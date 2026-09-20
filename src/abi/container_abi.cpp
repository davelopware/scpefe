#include "scpefe/scpefe.h"

#include "container/container_error.hpp"
#include "container/password_container.hpp"
#include "container/recoverable_password_container.hpp"
#include "container/unlocked_container_data.hpp"
#include "document/new_document.hpp"
#include "document/manual_save.hpp"
#include "document/merge_save.hpp"
#include "format/revision_error.hpp"
#include "format/text_validation.hpp"
#include "format/revision_limits.hpp"

#include <cstring>
#include <algorithm>
#include <new>
#include <utility>
#include <vector>

using scpefe::container::ContainerError;
using scpefe::container::ContainerFailure;
using scpefe::container::PasswordContainer;
using scpefe::container::RecoverablePasswordContainer;
using scpefe::container::UnlockedContainerData;
using scpefe::format::RevisionLimits;

namespace {

/* Maps an internal container failure to its stable C ABI status. */
scpefe_status external_status(ContainerError error)
{
    switch (error) {
    case ContainerError::invalid_argument:
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    case ContainerError::malformed_container:
        return SCPEFE_STATUS_MALFORMED_CONTAINER;
    case ContainerError::unsupported_format:
        return SCPEFE_STATUS_UNSUPPORTED_FORMAT;
    case ContainerError::limit_exceeded:
        return SCPEFE_STATUS_LIMIT_EXCEEDED;
    case ContainerError::authentication_failed:
        return SCPEFE_STATUS_AUTHENTICATION_FAILED;
    case ContainerError::weak_password:
        return SCPEFE_STATUS_WEAK_PASSWORD;
    case ContainerError::password_already_in_use:
        return SCPEFE_STATUS_PASSWORD_ALREADY_IN_USE;
    case ContainerError::out_of_memory:
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    case ContainerError::crypto_error:
        return SCPEFE_STATUS_CRYPTO_ERROR;
    }
    return SCPEFE_STATUS_CRYPTO_ERROR;
}

/* Validates and converts caller-provided revision and allocation limits. */
bool read_limits(
    const scpefe_revision_limits_v1 *limits,
    RevisionLimits &result
)
{
    if (limits == nullptr
        || limits->struct_size < sizeof(scpefe_revision_limits_v1)) {
        return false;
    }
    result = RevisionLimits(
        limits->max_input_bytes,
        limits->max_nesting_depth,
        limits->max_collection_entries,
        limits->max_text_bytes,
        limits->max_byte_string_bytes,
        limits->max_parent_count
    );
    return true;
}

} // namespace

struct scpefe_unlocked_container {
    /* Takes ownership of authenticated unlocked values. */
    explicit scpefe_unlocked_container(UnlockedContainerData &&value) noexcept
        : data(std::move(value)) {}
    UnlockedContainerData data;
};

scpefe_status scpefe_password_container_create(
    const std::uint8_t *password,
    std::size_t password_size,
    const std::uint8_t *encoded_snapshot_revision,
    std::size_t encoded_snapshot_revision_size,
    std::uint8_t *output,
    std::size_t output_capacity,
    std::size_t *output_size
)
{
    if (!scpefe::format::span_is_valid(password, password_size)
        || password_size == 0
        || !scpefe::format::span_is_valid(
            encoded_snapshot_revision, encoded_snapshot_revision_size
        )
        || encoded_snapshot_revision_size == 0 || output_size == nullptr) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    try {
        const std::size_t required_size = PasswordContainer::encoded_size(
            encoded_snapshot_revision_size
        );
        *output_size = required_size;
        if (output == nullptr || output_capacity < required_size) {
            return SCPEFE_STATUS_BUFFER_TOO_SMALL;
        }
        const std::vector<std::uint8_t> encoded = PasswordContainer::create(
            password, password_size, encoded_snapshot_revision,
            encoded_snapshot_revision_size
        );
        std::memcpy(output, encoded.data(), encoded.size());
        return SCPEFE_STATUS_OK;
    } catch (const ContainerFailure &failure) {
        return external_status(failure.error);
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_new_document_create(
    const scpefe_new_document_v1 *document,
    std::uint8_t *output,
    std::size_t output_capacity,
    std::size_t *output_size
)
{
    if (document == nullptr
        || document->struct_size < sizeof(scpefe_new_document_v1)
        || output_size == nullptr
        || document->profile_name_size == 0
        || document->profile_email_size == 0
        || document->device_name_size == 0
        || document->owner_password_size == 0
        || !scpefe::format::span_is_valid(
            document->owner_password, document->owner_password_size)
        || !scpefe::format::span_is_valid(
            document->recovery_password, document->recovery_password_size)
        || (document->recovery_password == nullptr
            && document->recovery_password_size != 0)
        || (document->recovery_password != nullptr
            && document->recovery_password_size == 0)
        || !scpefe::format::valid_utf8(
            document->profile_name, document->profile_name_size)
        || !scpefe::format::valid_utf8(
            document->profile_email, document->profile_email_size)
        || !scpefe::format::valid_utf8(
            document->device_name, document->device_name_size)
        || !scpefe::format::valid_canonical_document_text(
            document->content, document->content_size)
        || (document->recovery_password != nullptr
            && document->owner_password_size == document->recovery_password_size
            && std::memcmp(document->owner_password, document->recovery_password,
                document->owner_password_size) == 0)) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    try {
        const std::size_t required_size = scpefe::document::NewDocument::encoded_size(
            {document->profile_name, document->profile_name_size},
            {document->profile_email, document->profile_email_size},
            {document->device_name, document->device_name_size},
            {document->content, document->content_size},
            document->timestamp_ms,
            document->recovery_password != nullptr
        );
        *output_size = required_size;
        if (output == nullptr || output_capacity < required_size)
            return SCPEFE_STATUS_BUFFER_TOO_SMALL;
        const std::vector<std::uint8_t> encoded =
            scpefe::document::NewDocument::create(
                {document->profile_name, document->profile_name_size},
                {document->profile_email, document->profile_email_size},
                {document->device_name, document->device_name_size},
                {document->content, document->content_size},
                document->timestamp_ms,
                document->owner_password, document->owner_password_size,
                document->recovery_password, document->recovery_password_size
            );
        *output_size = encoded.size();
        std::memcpy(output, encoded.data(), encoded.size());
        return SCPEFE_STATUS_OK;
    } catch (const ContainerFailure &failure) {
        return external_status(failure.error);
    } catch (const scpefe::format::RevisionFailure &failure) {
        return failure.error == scpefe::format::RevisionError::limit_exceeded
            ? SCPEFE_STATUS_LIMIT_EXCEEDED : SCPEFE_STATUS_INVALID_ARGUMENT;
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_password_container_unlock(
    const std::uint8_t *container,
    std::size_t container_size,
    const std::uint8_t *password,
    std::size_t password_size,
    scpefe_unlocked_container **unlocked
)
{
    const RevisionLimits defaults = RevisionLimits::defaults();
    const scpefe_revision_limits_v1 limits{
        sizeof(scpefe_revision_limits_v1),
        defaults.max_input_bytes(),
        defaults.max_nesting_depth(),
        defaults.max_collection_entries(),
        defaults.max_text_bytes(),
        defaults.max_byte_string_bytes(),
        defaults.max_parent_count(),
    };
    return scpefe_password_container_unlock_with_limits(
        container, container_size, password, password_size, &limits, unlocked
    );
}

scpefe_status scpefe_manual_save(
    const scpefe_manual_save_v1 *save,
    std::uint8_t *output,
    std::size_t output_capacity,
    std::size_t *output_size
)
{
    if (save == nullptr || save->struct_size < sizeof(scpefe_manual_save_v1)
        || output_size == nullptr
        || !scpefe::format::span_is_valid(save->container, save->container_size)
        || save->container_size == 0
        || !scpefe::format::span_is_valid(save->password, save->password_size)
        || save->password_size == 0
        || !scpefe::format::span_is_valid(save->profile_name, save->profile_name_size)
        || save->profile_name_size == 0
        || !scpefe::format::span_is_valid(save->profile_email, save->profile_email_size)
        || save->profile_email_size == 0
        || !scpefe::format::span_is_valid(save->device_name, save->device_name_size)
        || save->device_name_size == 0
        || !scpefe::format::span_is_valid(save->content, save->content_size)
        || !scpefe::format::valid_utf8(save->profile_name, save->profile_name_size)
        || !scpefe::format::valid_utf8(save->profile_email, save->profile_email_size)
        || !scpefe::format::valid_utf8(save->device_name, save->device_name_size)
        || !scpefe::format::valid_canonical_document_text(
            save->content, save->content_size)) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    try {
        const auto encoded = scpefe::document::ManualSave::create(
            save->container, save->container_size,
            save->password, save->password_size,
            {save->profile_name, save->profile_name_size},
            {save->profile_email, save->profile_email_size},
            {save->device_name, save->device_name_size},
            {save->content, save->content_size}, save->timestamp_ms);
        *output_size = encoded.size();
        if (output == nullptr || output_capacity < encoded.size())
            return SCPEFE_STATUS_BUFFER_TOO_SMALL;
        std::memcpy(output, encoded.data(), encoded.size());
        return SCPEFE_STATUS_OK;
    } catch (const ContainerFailure &failure) {
        return external_status(failure.error);
    } catch (const scpefe::format::RevisionFailure &failure) {
        return failure.error == scpefe::format::RevisionError::limit_exceeded
            ? SCPEFE_STATUS_LIMIT_EXCEEDED : SCPEFE_STATUS_INVALID_ARGUMENT;
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_merge_save(
    const scpefe_merge_save_v1 *save,
    std::uint8_t *output,
    std::size_t output_capacity,
    std::size_t *output_size
)
{
    if (save == nullptr || save->struct_size < sizeof(scpefe_merge_save_v1)
        || output_size == nullptr
        || !scpefe::format::span_is_valid(
            save->current_container, save->current_container_size)
        || save->current_container_size == 0
        || !scpefe::format::span_is_valid(
            save->local_container, save->local_container_size)
        || save->local_container_size == 0
        || !scpefe::format::span_is_valid(save->password, save->password_size)
        || save->password_size == 0
        || !scpefe::format::valid_utf8(save->profile_name, save->profile_name_size)
        || save->profile_name_size == 0
        || !scpefe::format::valid_utf8(save->profile_email, save->profile_email_size)
        || save->profile_email_size == 0
        || !scpefe::format::valid_utf8(save->device_name, save->device_name_size)
        || save->device_name_size == 0
        || !scpefe::format::valid_canonical_document_text(
            save->content, save->content_size)) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    try {
        const auto encoded = scpefe::document::MergeSave::create(
            save->current_container, save->current_container_size,
            save->local_container, save->local_container_size,
            save->password, save->password_size,
            {save->profile_name, save->profile_name_size},
            {save->profile_email, save->profile_email_size},
            {save->device_name, save->device_name_size},
            {save->content, save->content_size}, save->timestamp_ms);
        *output_size = encoded.size();
        if (output == nullptr || output_capacity < encoded.size())
            return SCPEFE_STATUS_BUFFER_TOO_SMALL;
        std::memcpy(output, encoded.data(), encoded.size());
        return SCPEFE_STATUS_OK;
    } catch (const ContainerFailure &failure) {
        return external_status(failure.error);
    } catch (const scpefe::format::RevisionFailure &failure) {
        return failure.error == scpefe::format::RevisionError::limit_exceeded
            ? SCPEFE_STATUS_LIMIT_EXCEEDED : SCPEFE_STATUS_INVALID_ARGUMENT;
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_password_container_change_password(
    const std::uint8_t *container,
    std::size_t container_size,
    const std::uint8_t *current_password,
    std::size_t current_password_size,
    const std::uint8_t *new_password,
    std::size_t new_password_size,
    std::uint8_t *output,
    std::size_t output_capacity,
    std::size_t *output_size
)
{
    if (!scpefe::format::span_is_valid(container, container_size)
        || container_size == 0
        || !scpefe::format::span_is_valid(current_password, current_password_size)
        || current_password_size == 0
        || !scpefe::format::span_is_valid(new_password, new_password_size)
        || new_password_size == 0 || output_size == nullptr) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    try {
        const std::vector<std::uint8_t> changed =
            RecoverablePasswordContainer::change_password(
                container, container_size, current_password, current_password_size,
                new_password, new_password_size);
        *output_size = changed.size();
        if (output == nullptr || output_capacity < changed.size())
            return SCPEFE_STATUS_BUFFER_TOO_SMALL;
        std::memcpy(output, changed.data(), changed.size());
        return SCPEFE_STATUS_OK;
    } catch (const ContainerFailure &failure) {
        return external_status(failure.error);
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_password_container_add_invitation(
    const scpefe_invitation_create_v1 *invitation,
    std::uint8_t *output, std::size_t output_capacity, std::size_t *output_size)
{
    if (invitation == nullptr || invitation->struct_size < sizeof(*invitation)
        || output_size == nullptr || invitation->container_size == 0
        || invitation->creator_password_size == 0
        || invitation->temporary_password_size == 0
        || !scpefe::format::span_is_valid(invitation->container, invitation->container_size)
        || !scpefe::format::span_is_valid(invitation->creator_password,
            invitation->creator_password_size)
        || !scpefe::format::span_is_valid(invitation->temporary_password,
            invitation->temporary_password_size)
        || !scpefe::format::valid_utf8(invitation->temporary_label,
            invitation->temporary_label_size)
        || invitation->temporary_label_size == 0)
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    try {
        std::uint8_t permissions = invitation->can_edit ? 1u : 0u;
        if (invitation->can_add_passwords) permissions |= 2u;
        if (invitation->can_remove_passwords) permissions |= 4u;
        const auto encoded = RecoverablePasswordContainer::add_invitation(
            invitation->container, invitation->container_size,
            invitation->creator_password, invitation->creator_password_size,
            invitation->temporary_password, invitation->temporary_password_size,
            permissions, {invitation->temporary_label, invitation->temporary_label_size});
        *output_size = encoded.size();
        if (output == nullptr || output_capacity < encoded.size())
            return SCPEFE_STATUS_BUFFER_TOO_SMALL;
        std::memcpy(output, encoded.data(), encoded.size());
        return SCPEFE_STATUS_OK;
    } catch (const ContainerFailure &failure) { return external_status(failure.error); }
      catch (const std::bad_alloc &) { return SCPEFE_STATUS_OUT_OF_MEMORY; }
}

scpefe_status scpefe_password_container_claim_invitation(
    const scpefe_invitation_claim_v1 *claim,
    std::uint8_t *output, std::size_t output_capacity, std::size_t *output_size)
{
    if (claim == nullptr || claim->struct_size < sizeof(*claim)
        || output_size == nullptr || claim->container_size == 0
        || claim->temporary_password_size == 0 || claim->new_password_size == 0
        || claim->profile_name_size == 0 || claim->profile_email_size == 0
        || !scpefe::format::span_is_valid(claim->container, claim->container_size)
        || !scpefe::format::span_is_valid(claim->temporary_password,
            claim->temporary_password_size)
        || !scpefe::format::span_is_valid(claim->new_password, claim->new_password_size)
        || !scpefe::format::valid_utf8(claim->profile_name, claim->profile_name_size)
        || !scpefe::format::valid_utf8(claim->profile_email, claim->profile_email_size))
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    try {
        const auto encoded = RecoverablePasswordContainer::claim_invitation(
            claim->container, claim->container_size,
            claim->temporary_password, claim->temporary_password_size,
            claim->new_password, claim->new_password_size,
            {claim->profile_name, claim->profile_name_size},
            {claim->profile_email, claim->profile_email_size});
        *output_size = encoded.size();
        if (output == nullptr || output_capacity < encoded.size())
            return SCPEFE_STATUS_BUFFER_TOO_SMALL;
        std::memcpy(output, encoded.data(), encoded.size());
        return SCPEFE_STATUS_OK;
    } catch (const ContainerFailure &failure) { return external_status(failure.error); }
      catch (const std::bad_alloc &) { return SCPEFE_STATUS_OUT_OF_MEMORY; }
}

scpefe_status scpefe_password_container_unlock_with_limits(
    const std::uint8_t *container,
    std::size_t container_size,
    const std::uint8_t *password,
    std::size_t password_size,
    const scpefe_revision_limits_v1 *limits,
    scpefe_unlocked_container **unlocked
)
{
    if (!scpefe::format::span_is_valid(container, container_size)
        || container_size == 0
        || !scpefe::format::span_is_valid(password, password_size)
        || password_size == 0 || unlocked == nullptr) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    *unlocked = nullptr;
    RevisionLimits internal_limits = RevisionLimits::defaults();
    if (!read_limits(limits, internal_limits)) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    try {
        UnlockedContainerData data = PasswordContainer::unlock(
            container, container_size, password, password_size, internal_limits
        );
        *unlocked = new scpefe_unlocked_container(std::move(data));
        return SCPEFE_STATUS_OK;
    } catch (const ContainerFailure &failure) {
        return external_status(failure.error);
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_unlocked_container_view(
    const scpefe_unlocked_container *unlocked,
    scpefe_unlocked_container_v1 *view
)
{
    if (unlocked == nullptr || view == nullptr
        || view->struct_size < sizeof(scpefe_unlocked_container_v1)) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    const std::uint32_t struct_size = view->struct_size;
    *view = scpefe_unlocked_container_v1{
        struct_size,
        unlocked->data.document_id.data(),
        unlocked->data.document_id.size(),
        unlocked->data.encoded_snapshot_revision.data(),
        unlocked->data.encoded_snapshot_revision.size(),
    };
    return SCPEFE_STATUS_OK;
}

scpefe_status scpefe_unlocked_container_slot_access(
    const scpefe_unlocked_container *unlocked,
    scpefe_unlocked_slot_access_v1 *access
)
{
    if (unlocked == nullptr || access == nullptr
        || access->struct_size < offsetof(
            scpefe_unlocked_slot_access_v1, can_add_passwords)) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    const std::uint32_t struct_size = access->struct_size;
    const scpefe_unlocked_slot_access_v1 value{
        struct_size, unlocked->data.slot_id.data(), unlocked->data.slot_id.size(),
        (unlocked->data.permissions & 1u) != 0,
        unlocked->data.recovery_slot,
        (unlocked->data.permissions & 2u) != 0,
        (unlocked->data.permissions & 4u) != 0,
        unlocked->data.must_be_changed,
        unlocked->data.slot_identity_name.data(),
        unlocked->data.slot_identity_name.size(),
        unlocked->data.slot_identity_email.data(),
        unlocked->data.slot_identity_email.size(),
    };
    std::memcpy(access, &value, std::min<std::size_t>(
        struct_size, sizeof(scpefe_unlocked_slot_access_v1)));
    return SCPEFE_STATUS_OK;
}

scpefe_status scpefe_unlocked_container_editing_lease(
    const scpefe_unlocked_container *unlocked,
    scpefe_editing_lease_v1 *lease)
{
    if (unlocked == nullptr || lease == nullptr
        || lease->struct_size < sizeof(scpefe_editing_lease_v1))
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    const auto &value = unlocked->data.editing_lease;
    const std::uint32_t struct_size = lease->struct_size;
    *lease = scpefe_editing_lease_v1{
        struct_size, value.active, value.session_id.data(), value.session_id.size(),
        value.heartbeat_counter, value.holder_utc_ms, value.duration_ms,
        value.holder_name.data(), value.holder_name.size(),
        value.holder_email.data(), value.holder_email.size(),
        value.device_name.data(), value.device_name.size(),
    };
    return SCPEFE_STATUS_OK;
}

scpefe_status scpefe_editing_lease_update(
    const scpefe_editing_lease_update_v1 *update,
    std::uint8_t *output, std::size_t output_capacity, std::size_t *output_size)
{
    if (update == nullptr
        || update->struct_size < sizeof(scpefe_editing_lease_update_v1)
        || update->lease.struct_size < sizeof(scpefe_editing_lease_v1)
        || output_size == nullptr
        || !scpefe::format::span_is_valid(update->container, update->container_size)
        || update->container_size == 0
        || !scpefe::format::span_is_valid(update->password, update->password_size)
        || update->password_size == 0
        || update->lease.session_id_size != SCPEFE_LEASE_SESSION_ID_SIZE
        || !scpefe::format::span_is_valid(
            update->lease.session_id, update->lease.session_id_size)
        || update->lease.duration_ms == 0
        || !scpefe::format::valid_utf8(
            update->lease.holder_name, update->lease.holder_name_size)
        || !scpefe::format::valid_utf8(
            update->lease.holder_email, update->lease.holder_email_size)
        || !scpefe::format::valid_utf8(
            update->lease.device_name, update->lease.device_name_size)) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    try {
        scpefe::container::EditingLeaseData lease;
        lease.active = update->lease.active != 0;
        std::copy_n(update->lease.session_id, lease.session_id.size(),
            lease.session_id.begin());
        lease.heartbeat_counter = update->lease.heartbeat_counter;
        lease.holder_utc_ms = update->lease.holder_utc_ms;
        lease.duration_ms = update->lease.duration_ms;
        lease.holder_name.assign(update->lease.holder_name,
            update->lease.holder_name_size);
        lease.holder_email.assign(update->lease.holder_email,
            update->lease.holder_email_size);
        lease.device_name.assign(update->lease.device_name,
            update->lease.device_name_size);
        const auto encoded = RecoverablePasswordContainer::replace_editing_lease(
            update->container, update->container_size,
            update->password, update->password_size, lease);
        *output_size = encoded.size();
        if (output == nullptr || output_capacity < encoded.size())
            return SCPEFE_STATUS_BUFFER_TOO_SMALL;
        std::memcpy(output, encoded.data(), encoded.size());
        return SCPEFE_STATUS_OK;
    } catch (const ContainerFailure &failure) {
        return external_status(failure.error);
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_unlocked_container_work_journal_key(
    const scpefe_unlocked_container *unlocked,
    std::uint8_t *key,
    std::size_t key_capacity,
    std::size_t *key_size
)
{
    if (unlocked == nullptr || key_size == nullptr) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    *key_size = unlocked->data.work_journal_key.size();
    if (key == nullptr || key_capacity < *key_size) {
        return SCPEFE_STATUS_BUFFER_TOO_SMALL;
    }
    std::memcpy(key, unlocked->data.work_journal_key.data(), *key_size);
    return SCPEFE_STATUS_OK;
}

void scpefe_unlocked_container_destroy(scpefe_unlocked_container *unlocked)
{
    delete unlocked;
}
