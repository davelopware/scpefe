#include "scpefe/scpefe.h"

#include "core/context.hpp"
#include "core/host_services.hpp"
#include "container/container_error.hpp"
#include "container/container_state.hpp"
#include "container/recoverable_password_container.hpp"
#include "format/revision_error.hpp"
#include "format/revision_limits.hpp"
#include "format/snapshot_revision.hpp"
#include "format/text_validation.hpp"

#include <cstring>
#include <memory>
#include <new>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr const char *library_version = SCPEFE_VERSION_STRING;

bool has_complete_host_services(const scpefe_host_services_v1 *services)
{
    return services != nullptr
        && services->struct_size >= sizeof(scpefe_host_services_v1)
        && services->monotonic_time_ms != nullptr;
}

scpefe_status map_error(scpefe::container::ContainerError error)
{
    using scpefe::container::ContainerError;
    switch (error) {
    case ContainerError::invalid_argument: return SCPEFE_STATUS_INVALID_ARGUMENT;
    case ContainerError::malformed_container: return SCPEFE_STATUS_MALFORMED_CONTAINER;
    case ContainerError::unsupported_format: return SCPEFE_STATUS_UNSUPPORTED_FORMAT;
    case ContainerError::limit_exceeded: return SCPEFE_STATUS_LIMIT_EXCEEDED;
    case ContainerError::authentication_failed: return SCPEFE_STATUS_AUTHENTICATION_FAILED;
    case ContainerError::weak_password: return SCPEFE_STATUS_WEAK_PASSWORD;
    case ContainerError::password_already_in_use: return SCPEFE_STATUS_PASSWORD_ALREADY_IN_USE;
    case ContainerError::out_of_memory: return SCPEFE_STATUS_OUT_OF_MEMORY;
    case ContainerError::crypto_error: return SCPEFE_STATUS_CRYPTO_ERROR;
    }
    return SCPEFE_STATUS_CRYPTO_ERROR;
}

scpefe_status map_error(scpefe::format::RevisionError error)
{
    using scpefe::format::RevisionError;
    switch (error) {
    case RevisionError::invalid_argument: return SCPEFE_STATUS_INVALID_ARGUMENT;
    case RevisionError::malformed_cbor: return SCPEFE_STATUS_MALFORMED_CBOR;
    case RevisionError::limit_exceeded: return SCPEFE_STATUS_LIMIT_EXCEEDED;
    case RevisionError::unsupported_format: return SCPEFE_STATUS_UNSUPPORTED_FORMAT;
    }
    return SCPEFE_STATUS_MALFORMED_CBOR;
}

bool valid_document(const scpefe_new_document_v1 &document)
{
    using scpefe::format::span_is_valid;
    using scpefe::format::valid_utf8;
    return document.struct_size >= sizeof(document)
        && document.profile_name_size > 0 && document.profile_email_size > 0
        && document.device_name_size > 0 && document.owner_password_size > 0
        && span_is_valid(document.owner_password, document.owner_password_size)
        && span_is_valid(document.recovery_password, document.recovery_password_size)
        && (document.recovery_password == nullptr) == (document.recovery_password_size == 0)
        && valid_utf8(document.profile_name, document.profile_name_size)
        && valid_utf8(document.profile_email, document.profile_email_size)
        && valid_utf8(document.device_name, document.device_name_size)
        && scpefe::format::valid_canonical_document_text(document.content, document.content_size)
        && !(document.recovery_password && document.owner_password_size == document.recovery_password_size
            && std::memcmp(document.owner_password, document.recovery_password,
                document.owner_password_size) == 0);
}

bool document_exceeds_limits(const scpefe_new_document_v1 &document)
{
    const auto limits = scpefe::format::RevisionLimits::defaults();
    return document.content_size > limits.max_text_bytes()
        || document.profile_name_size > limits.max_text_bytes()
        || document.profile_email_size > limits.max_text_bytes()
        || document.device_name_size > limits.max_text_bytes()
        || document.owner_password_size > 4096
        || document.recovery_password_size > 4096;
}

} // namespace

struct scpefe_container {
    scpefe_context *owner{};
    bool live{};
};

struct scpefe_owned_snapshot {
    std::array<std::uint8_t, SCPEFE_DOCUMENT_ID_SIZE> document_id{};
    std::array<std::uint8_t, SCPEFE_SLOT_ID_SIZE> slot_id{};
    std::vector<std::uint8_t> encoded_revision;
    std::string content;
};

struct scpefe_context {
    explicit scpefe_context(scpefe::core::Context value)
        : implementation(std::move(value)) {}
    scpefe::core::Context implementation;
    std::vector<std::unique_ptr<scpefe_container>> handles;
    scpefe_container *active{};
};

namespace {

bool live(const scpefe_container *handle)
{
    return handle && handle->live && handle->owner
        && handle->owner->active == handle;
}

uint32_t effect_mask(const scpefe::container::TransitionResult &result)
{
    using scpefe::container::EffectKind;
    uint32_t mask = 0;
    for (const auto &effect : result.effects) {
        switch (effect.kind) {
        case EffectKind::reread_target: mask |= SCPEFE_EFFECT_REREAD_TARGET; break;
        case EffectKind::journal_candidate: mask |= SCPEFE_EFFECT_JOURNAL_CANDIDATE; break;
        case EffectKind::publish_candidate: mask |= SCPEFE_EFFECT_PUBLISH_CANDIDATE; break;
        case EffectKind::adopt_candidate: mask |= SCPEFE_EFFECT_ADOPT_CANDIDATE; break;
        case EffectKind::clear_journal: mask |= SCPEFE_EFFECT_CLEAR_JOURNAL; break;
        case EffectKind::recover_candidate: mask |= SCPEFE_EFFECT_RECOVER_CANDIDATE; break;
        default: break;
        }
    }
    return mask;
}

scpefe_status map_state_error(scpefe::container::StateError error)
{
    return error == scpefe::container::StateError::stale_operation
        ? SCPEFE_STATUS_STALE_OPERATION : SCPEFE_STATUS_INVALID_STATE;
}

scpefe_status install_handle(scpefe_context *context,
    std::unique_ptr<scpefe_container> handle, scpefe_container **output)
{
    handle->owner = context;
    handle->live = true;
    auto *raw = handle.get();
    context->handles.push_back(std::move(handle));
    context->active = raw;
    *output = raw;
    return SCPEFE_STATUS_OK;
}

} // namespace

uint32_t scpefe_abi_version(void) { return SCPEFE_ABI_VERSION; }
const char *scpefe_library_version(void) { return library_version; }

scpefe_status scpefe_context_create(
    const scpefe_host_services_v1 *host_services,
    scpefe_context **context
)
{
    if (context == nullptr || !has_complete_host_services(host_services)) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    *context = nullptr;
    if (host_services->abi_version != SCPEFE_ABI_VERSION) {
        return SCPEFE_STATUS_UNSUPPORTED_ABI;
    }
    scpefe::core::HostServices internal_host(
        host_services->instance_data,
        host_services->monotonic_time_ms
    );
    try {
        *context = new scpefe_context(scpefe::core::Context(std::move(internal_host)));
        return SCPEFE_STATUS_OK;
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

void scpefe_context_destroy(scpefe_context *context) { delete context; }

scpefe_status scpefe_context_health(
    scpefe_context *context,
    scpefe_health_info_v1 *health_info
)
{
    if (context == nullptr || health_info == nullptr
        || health_info->struct_size < sizeof(scpefe_health_info_v1)) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    scpefe::core::HealthInfo internal_health{};
    if (!context->implementation.read_health(internal_health)) {
        return SCPEFE_STATUS_HOST_ERROR;
    }
    *health_info = scpefe_health_info_v1{
        sizeof(scpefe_health_info_v1),
        SCPEFE_ABI_VERSION,
        SCPEFE_VERSION_MAJOR,
        SCPEFE_VERSION_MINOR,
        SCPEFE_VERSION_PATCH,
        internal_health.host_monotonic_time_ms,
    };
    return SCPEFE_STATUS_OK;
}

scpefe_status scpefe_container_create(scpefe_context *context,
    const scpefe_container_create_v1 *request, scpefe_container **output)
{
    if (output) *output = nullptr;
    if (!context || !request || !output || request->struct_size < sizeof(*request))
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    if (request->abi_version != SCPEFE_ABI_VERSION) return SCPEFE_STATUS_UNSUPPORTED_ABI;
    if (request->document.struct_size < sizeof(request->document))
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    if (document_exceeds_limits(request->document)) return SCPEFE_STATUS_LIMIT_EXCEEDED;
    if (!valid_document(request->document)) return SCPEFE_STATUS_INVALID_ARGUMENT;
    if (context->active) return SCPEFE_STATUS_INVALID_STATE;
    try {
        auto handle = std::make_unique<scpefe_container>();
        context->handles.reserve(context->handles.size() + 1);
        auto &container = context->implementation.make_container();
        const auto &document = request->document;
        auto bytes = container.create_document(
            {document.profile_name, document.profile_name_size},
            {document.profile_email, document.profile_email_size},
            {document.device_name, document.device_name_size},
            {document.content, document.content_size}, document.timestamp_ms,
            document.owner_password, document.owner_password_size,
            document.recovery_password, document.recovery_password_size);
        container.open_document(bytes.data(), bytes.size());
        try {
            container.unlock_legacy_document(document.owner_password, document.owner_password_size);
        } catch (...) {
            container.transition(scpefe::container::Close{});
            context->implementation.release_container();
            throw;
        }
        return install_handle(context, std::move(handle), output);
    } catch (const scpefe::container::ContainerFailure &failure) {
        return map_error(failure.error);
    } catch (scpefe::container::StateError) {
        return SCPEFE_STATUS_INVALID_STATE;
    } catch (const scpefe::format::RevisionFailure &failure) {
        return map_error(failure.error);
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_container_open(scpefe_context *context,
    const scpefe_container_open_v1 *request, scpefe_container **output)
{
    if (output) *output = nullptr;
    if (!context || !request || !output || request->struct_size < sizeof(*request))
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    if (request->abi_version != SCPEFE_ABI_VERSION) return SCPEFE_STATUS_UNSUPPORTED_ABI;
    if (!request->bytes || request->bytes_size == 0) return SCPEFE_STATUS_INVALID_ARGUMENT;
    if (request->bytes_size
        > scpefe::container::RecoverablePasswordContainer::max_container_bytes())
        return SCPEFE_STATUS_LIMIT_EXCEEDED;
    if (context->active) return SCPEFE_STATUS_INVALID_STATE;
    try {
        auto handle = std::make_unique<scpefe_container>();
        context->handles.reserve(context->handles.size() + 1);
        context->implementation.make_container().open_document(
            request->bytes, request->bytes_size);
        return install_handle(context, std::move(handle), output);
    } catch (const scpefe::container::ContainerFailure &failure) {
        return map_error(failure.error);
    } catch (scpefe::container::StateError) {
        return SCPEFE_STATUS_INVALID_STATE;
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_container_unlock(scpefe_container *handle,
    const scpefe_password_input_v1 *password)
{
    if (!password || password->struct_size < sizeof(*password))
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    if (password->abi_version != SCPEFE_ABI_VERSION) return SCPEFE_STATUS_UNSUPPORTED_ABI;
    if (!password->bytes || password->bytes_size == 0) return SCPEFE_STATUS_INVALID_ARGUMENT;
    if (password->bytes_size > 4096) return SCPEFE_STATUS_LIMIT_EXCEEDED;
    if (!live(handle)) return SCPEFE_STATUS_INVALID_STATE;
    try {
        handle->owner->implementation.make_container().unlock_legacy_document(
            password->bytes, password->bytes_size);
        return SCPEFE_STATUS_OK;
    } catch (const scpefe::container::ContainerFailure &failure) {
        return map_error(failure.error);
    } catch (scpefe::container::StateError) {
        return SCPEFE_STATUS_INVALID_STATE;
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_container_lock(scpefe_container *handle)
{
    if (!live(handle)) return SCPEFE_STATUS_INVALID_STATE;
    try {
        handle->owner->implementation.make_container().transition(scpefe::container::Lock{});
        return SCPEFE_STATUS_OK;
    } catch (scpefe::container::StateError) {
        return SCPEFE_STATUS_INVALID_STATE;
    }
}

scpefe_status scpefe_container_close(scpefe_container *handle)
{
    if (!live(handle)) return SCPEFE_STATUS_INVALID_STATE;
    try {
        handle->owner->implementation.make_container().transition(scpefe::container::Close{});
        handle->owner->implementation.release_container();
        handle->live = false;
        handle->owner->active = nullptr;
        return SCPEFE_STATUS_OK;
    } catch (scpefe::container::StateError) {
        return SCPEFE_STATUS_INVALID_STATE;
    }
}

scpefe_status scpefe_container_status(const scpefe_container *handle,
    scpefe_container_status_v1 *status)
{
    if (!status || status->struct_size < sizeof(*status))
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    if (status->abi_version != SCPEFE_ABI_VERSION) return SCPEFE_STATUS_UNSUPPORTED_ABI;
    if (!live(handle)) return SCPEFE_STATUS_INVALID_STATE;
    const auto &container = handle->owner->implementation.make_container();
    const auto &state = container.state();
    const auto *unlocked = container.read_unlocked();
    *status = {sizeof(*status), SCPEFE_ABI_VERSION,
        state.screen == scpefe::container::Screen::locked,
        state.permissions.can_edit, state.permissions.can_add_passwords,
        state.permissions.can_remove_passwords,
        unlocked && unlocked->must_be_changed};
    return SCPEFE_STATUS_OK;
}

scpefe_status scpefe_container_read(const scpefe_container *handle,
    scpefe_owned_snapshot **output)
{
    if (!output) return SCPEFE_STATUS_INVALID_ARGUMENT;
    *output = nullptr;
    if (!live(handle)) return SCPEFE_STATUS_INVALID_STATE;
    const auto &container = handle->owner->implementation.make_container();
    const auto *unlocked = container.read_unlocked();
    if (!unlocked) return SCPEFE_STATUS_LOCKED;
    try {
        auto snapshot = std::make_unique<scpefe_owned_snapshot>();
        snapshot->document_id = unlocked->document_id;
        snapshot->slot_id = unlocked->slot_id;
        const auto *clear = container.read_content_clear();
        if (clear) {
            snapshot->content = *clear;
            snapshot->encoded_revision = unlocked->encoded_snapshot_revision;
        } else if (unlocked->revision_graph) {
            const auto content = unlocked->revision_graph->reconstruct(
                unlocked->revision_graph->content_head());
            if (!content) return SCPEFE_STATUS_BODY_UNAVAILABLE;
            snapshot->content = *content;
        } else {
            snapshot->encoded_revision = unlocked->encoded_snapshot_revision;
            auto decoded = scpefe::format::SnapshotRevision::decode(
                snapshot->encoded_revision.data(), snapshot->encoded_revision.size(),
                scpefe::format::RevisionLimits::defaults());
            snapshot->content = decoded.data().content;
        }
        *output = snapshot.release();
        return SCPEFE_STATUS_OK;
    } catch (const scpefe::format::RevisionFailure &failure) {
        return map_error(failure.error);
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_container_revision_graph(const scpefe_container *handle,
    scpefe_revision_graph **graph)
{
    if (!graph) return SCPEFE_STATUS_INVALID_ARGUMENT;
    *graph = nullptr;
    if (!live(handle)) return SCPEFE_STATUS_INVALID_STATE;
    const auto *unlocked = handle->owner->implementation.make_container().read_unlocked();
    if (!unlocked) return SCPEFE_STATUS_LOCKED;
    if (!unlocked->revision_graph) return SCPEFE_STATUS_UNSUPPORTED_FORMAT;
    const auto &payload = unlocked->revision_graph->encode();
    scpefe_revision_limits_v1 limits{};
    limits.struct_size = sizeof(limits);
    const auto status = scpefe_revision_limits_default(&limits);
    if (status != SCPEFE_STATUS_OK) return status;
    return scpefe_revision_graph_decode(payload.data(), payload.size(), &limits, graph);
}

scpefe_status scpefe_owned_snapshot_view(const scpefe_owned_snapshot *snapshot,
    scpefe_owned_snapshot_view_v1 *view)
{
    if (!snapshot || !view || view->struct_size < sizeof(*view))
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    if (view->abi_version != SCPEFE_ABI_VERSION) return SCPEFE_STATUS_UNSUPPORTED_ABI;
    view->struct_size = sizeof(*view);
    view->abi_version = SCPEFE_ABI_VERSION;
    std::memcpy(view->document_id, snapshot->document_id.data(), SCPEFE_DOCUMENT_ID_SIZE);
    std::memcpy(view->slot_id, snapshot->slot_id.data(), SCPEFE_SLOT_ID_SIZE);
    view->encoded_revision = snapshot->encoded_revision.data();
    view->encoded_revision_size = snapshot->encoded_revision.size();
    view->content = snapshot->content.data();
    view->content_size = snapshot->content.size();
    return SCPEFE_STATUS_OK;
}

void scpefe_owned_snapshot_destroy(scpefe_owned_snapshot *snapshot) { delete snapshot; }

scpefe_status scpefe_container_copy_bytes(const scpefe_container *handle,
    std::uint8_t *output, std::size_t capacity, std::size_t *output_size)
{
    if (!output_size || (!output && capacity != 0)) return SCPEFE_STATUS_INVALID_ARGUMENT;
    if (!live(handle)) return SCPEFE_STATUS_INVALID_STATE;
    const auto &bytes = handle->owner->implementation.make_container().committed_bytes();
    *output_size = bytes.size();
    if (!output || capacity < bytes.size()) return SCPEFE_STATUS_BUFFER_TOO_SMALL;
    std::memcpy(output, bytes.data(), bytes.size());
    return SCPEFE_STATUS_OK;
}

scpefe_status scpefe_container_confirm_edit_lease(scpefe_container *handle)
{
    if (!live(handle)) return SCPEFE_STATUS_INVALID_STATE;
    try {
        handle->owner->implementation.make_container().confirm_edit_lease();
        return SCPEFE_STATUS_OK;
    } catch (scpefe::container::StateError error) {
        return map_state_error(error);
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_container_submit_content(scpefe_container *handle,
    const char *content, size_t content_size)
{
    if (!scpefe::format::span_is_valid(content, content_size))
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    if (!live(handle)) return SCPEFE_STATUS_INVALID_STATE;
    try {
        handle->owner->implementation.make_container().submit_content(
            {content ? content : "", content_size});
        return SCPEFE_STATUS_OK;
    } catch (const scpefe::container::ContainerFailure &failure) {
        return map_error(failure.error);
    } catch (scpefe::container::StateError error) {
        return map_state_error(error);
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_container_prepare_save(scpefe_container *handle,
    const scpefe_container_save_v1 *save, scpefe_candidate_info_v1 *info)
{
    if (!save || !info || save->struct_size < sizeof(*save)
        || info->struct_size < sizeof(*info)
        || !save->password || save->password_size == 0
        || !scpefe::format::span_is_valid(save->profile_name, save->profile_name_size)
        || !scpefe::format::span_is_valid(save->profile_email, save->profile_email_size)
        || !scpefe::format::span_is_valid(save->device_name, save->device_name_size)
        || save->kind < SCPEFE_SAVE_MANUAL || save->kind > SCPEFE_SAVE_DISCARD)
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    if (save->abi_version != SCPEFE_ABI_VERSION
        || info->abi_version != SCPEFE_ABI_VERSION)
        return SCPEFE_STATUS_UNSUPPORTED_ABI;
    if (save->password_size > 4096) return SCPEFE_STATUS_LIMIT_EXCEEDED;
    const auto text_limit = scpefe::format::RevisionLimits::defaults().max_text_bytes();
    if (save->profile_name_size > text_limit || save->profile_email_size > text_limit
        || save->device_name_size > text_limit) return SCPEFE_STATUS_LIMIT_EXCEEDED;
    if (save->kind != SCPEFE_SAVE_DISCARD
        && (!scpefe::format::valid_utf8(save->profile_name, save->profile_name_size)
            || !scpefe::format::valid_utf8(save->profile_email, save->profile_email_size)
            || !scpefe::format::valid_utf8(save->device_name, save->device_name_size)
            || !save->profile_name_size || !save->profile_email_size
            || !save->device_name_size)) return SCPEFE_STATUS_INVALID_ARGUMENT;
    if (!live(handle)) return SCPEFE_STATUS_INVALID_STATE;
    try {
        auto &container = handle->owner->implementation.make_container();
        const auto result = container.prepare_save(save->operation_id,
            save->kind == SCPEFE_SAVE_REGULAR, save->kind == SCPEFE_SAVE_DISCARD,
            save->password, save->password_size,
            {save->profile_name ? save->profile_name : "", save->profile_name_size},
            {save->profile_email ? save->profile_email : "", save->profile_email_size},
            {save->device_name ? save->device_name : "", save->device_name_size},
            save->timestamp_ms);
        const auto *candidate = container.candidate();
        *info = {sizeof(*info), SCPEFE_ABI_VERSION, candidate->operation_id, {},
            candidate->bytes.size(), effect_mask(result)};
        std::memcpy(info->source_head, candidate->source_head.data(),
            candidate->source_head.size());
        return SCPEFE_STATUS_OK;
    } catch (const scpefe::container::ContainerFailure &failure) {
        return map_error(failure.error);
    } catch (scpefe::container::StateError error) {
        return map_state_error(error);
    } catch (const scpefe::format::RevisionFailure &failure) {
        return map_error(failure.error);
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_container_copy_candidate(const scpefe_container *handle,
    uint64_t operation_id, uint8_t *output, size_t capacity, size_t *output_size)
{
    if (!output_size || (!output && capacity)) return SCPEFE_STATUS_INVALID_ARGUMENT;
    if (!live(handle)) return SCPEFE_STATUS_INVALID_STATE;
    const auto *candidate = handle->owner->implementation.make_container().candidate();
    if (!candidate || candidate->operation_id != operation_id)
        return SCPEFE_STATUS_STALE_OPERATION;
    *output_size = candidate->bytes.size();
    if (!output || capacity < candidate->bytes.size())
        return SCPEFE_STATUS_BUFFER_TOO_SMALL;
    std::memcpy(output, candidate->bytes.data(), candidate->bytes.size());
    return SCPEFE_STATUS_OK;
}

scpefe_status scpefe_container_acknowledge_save(scpefe_container *handle,
    uint64_t operation_id, scpefe_publication_outcome outcome, uint32_t *mask)
{
    if (!mask || outcome < SCPEFE_PUBLICATION_VERIFIED
        || outcome > SCPEFE_PUBLICATION_AMBIGUOUS)
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    if (!live(handle)) return SCPEFE_STATUS_INVALID_STATE;
    try {
        using scpefe::container::PublicationOutcome;
        const auto internal = outcome == SCPEFE_PUBLICATION_VERIFIED
            ? PublicationOutcome::verified
            : outcome == SCPEFE_PUBLICATION_DEFINITE_FAILURE
                ? PublicationOutcome::definite_failure : PublicationOutcome::ambiguous;
        *mask = effect_mask(handle->owner->implementation.make_container()
            .acknowledge_save(operation_id, internal));
        return SCPEFE_STATUS_OK;
    } catch (scpefe::container::StateError error) {
        return map_state_error(error);
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_container_resolve_save(scpefe_container *handle,
    uint64_t operation_id, int published, uint32_t *mask)
{
    if (!mask || (published != 0 && published != 1))
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    if (!live(handle)) return SCPEFE_STATUS_INVALID_STATE;
    try {
        *mask = effect_mask(handle->owner->implementation.make_container()
            .resolve_save(operation_id, published != 0));
        return SCPEFE_STATUS_OK;
    } catch (scpefe::container::StateError error) {
        return map_state_error(error);
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}
