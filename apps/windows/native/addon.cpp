#include "scpefe/scpefe.h"

#include <node_api.h>

#include <array>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iterator>
#include <memory>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

extern "C" int crypto_generichash(
    unsigned char *, std::size_t, const unsigned char *, unsigned long long,
    const unsigned char *, std::size_t
);
extern "C" void sodium_memzero(void *, std::size_t);

void check(napi_env env, napi_status status)
{
    if (status != napi_ok) {
        const napi_extended_error_info *info = nullptr;
        napi_get_last_error_info(env, &info);
        throw std::runtime_error(info && info->error_message
            ? info->error_message : "Node-API operation failed");
    }
}

napi_value property(napi_env env, napi_value object, const char *name)
{
    napi_value result;
    check(env, napi_get_named_property(env, object, name, &result));
    return result;
}

std::string string_value(napi_env env, napi_value value)
{
    size_t size = 0;
    check(env, napi_get_value_string_utf8(env, value, nullptr, 0, &size));
    std::string result(size, '\0');
    check(env, napi_get_value_string_utf8(
        env, value, result.data(), result.size() + 1, &size));
    return result;
}

class SecretBytes {
public:
    SecretBytes() = default;

    SecretBytes(napi_env env, napi_value value)
    {
        assign(env, value);
    }

    ~SecretBytes()
    {
        clear();
    }

    SecretBytes(const SecretBytes &) = delete;
    SecretBytes &operator=(const SecretBytes &) = delete;

    void assign(napi_env env, napi_value value)
    {
        clear();
        size_t size = 0;
        check(env, napi_get_value_string_utf8(env, value, nullptr, 0, &size));
        bytes_.resize(size + 1);
        size_t written = 0;
        try {
            check(env, napi_get_value_string_utf8(env, value,
                reinterpret_cast<char *>(bytes_.data()), bytes_.size(), &written));
            bytes_.resize(written);
        } catch (...) {
            clear();
            throw;
        }
    }

    const std::uint8_t *data() const { return bytes_.data(); }
    std::size_t size() const { return bytes_.size(); }

private:
    void clear()
    {
        if (!bytes_.empty()) sodium_memzero(bytes_.data(), bytes_.size());
        bytes_.clear();
    }

    std::vector<std::uint8_t> bytes_;
};

void set_string(napi_env env, napi_value object, const char *name,
    const char *value, std::size_t size)
{
    napi_value string;
    check(env, napi_create_string_utf8(env, value, size, &string));
    check(env, napi_set_named_property(env, object, name, string));
}

void set_boolean(napi_env env, napi_value object, const char *name, bool value)
{
    napi_value boolean;
    check(env, napi_get_boolean(env, value, &boolean));
    check(env, napi_set_named_property(env, object, name, boolean));
}

void set_number(napi_env env, napi_value object, const char *name, std::uint64_t value)
{
    napi_value number;
    check(env, napi_create_double(env, static_cast<double>(value), &number));
    check(env, napi_set_named_property(env, object, name, number));
}

std::uint64_t number_value(napi_env env, napi_value value)
{
    double result = 0;
    check(env, napi_get_value_double(env, value, &result));
    if (!std::isfinite(result) || result < 0 || result > 9007199254740991.0
        || static_cast<double>(static_cast<std::uint64_t>(result)) != result)
        throw std::runtime_error("expected a non-negative safe integer");
    return static_cast<std::uint64_t>(result);
}

bool boolean_value(napi_env env, napi_value value)
{
    bool result = false;
    check(env, napi_get_value_bool(env, value, &result));
    return result;
}

void set_buffer(napi_env env, napi_value object, const char *name,
    const std::uint8_t *value, std::size_t size)
{
    void *copy = nullptr;
    napi_value buffer;
    check(env, napi_create_buffer_copy(env, size, value, &copy, &buffer));
    check(env, napi_set_named_property(env, object, name, buffer));
}

std::string hexadecimal(const std::uint8_t *value, std::size_t size);

void set_revision_graph(napi_env env, napi_value object,
    const std::uint8_t *revision_id, const scpefe_snapshot_revision_v1 &revision)
{
    napi_value graph;
    check(env, napi_create_array_with_length(
        env, revision.ancestor_count + 1, &graph));
    const auto add_node = [&](std::size_t graph_index, const std::uint8_t *id_bytes,
                              const std::uint8_t *parent_bytes,
                              std::size_t parent_count) {
        napi_value node;
        napi_value parents;
        check(env, napi_create_object(env, &node));
        const std::string id = hexadecimal(id_bytes, SCPEFE_REVISION_ID_SIZE);
        set_string(env, node, "revisionId", id.data(), id.size());
        check(env, napi_create_array_with_length(env, parent_count, &parents));
        for (std::size_t index = 0; index < parent_count; ++index) {
            const std::string parent = hexadecimal(
                parent_bytes + index * SCPEFE_REVISION_ID_SIZE,
                SCPEFE_REVISION_ID_SIZE);
            napi_value value;
            check(env, napi_create_string_utf8(
                env, parent.data(), parent.size(), &value));
            check(env, napi_set_element(env, parents, index, value));
        }
        check(env, napi_set_named_property(env, node, "parentRevisionIds", parents));
        check(env, napi_set_element(env, graph, graph_index, node));
    };
    for (std::size_t index = 0; index < revision.ancestor_count; ++index) {
        const auto &ancestor = revision.ancestor_graph[index];
        add_node(index, ancestor.revision_id, ancestor.parent_revision_ids,
            ancestor.parent_count);
    }
    add_node(revision.ancestor_count, revision_id,
        revision.parent_revision_ids, revision.parent_count);
    check(env, napi_set_named_property(env, object, "revisionGraph", graph));
}

std::string hexadecimal(const std::uint8_t *value, std::size_t size)
{
    static constexpr char digits[] = "0123456789abcdef";
    std::string result(size * 2, '\0');
    for (std::size_t index = 0; index < size; ++index) {
        result[index * 2] = digits[value[index] >> 4];
        result[index * 2 + 1] = digits[value[index] & 0x0f];
    }
    return result;
}

std::array<std::uint8_t, SCPEFE_REVISION_ID_SIZE> revision_id(napi_env env,
    napi_value value)
{
    const auto input = string_value(env, value);
    if (input.size() != SCPEFE_REVISION_ID_SIZE * 2)
        throw std::runtime_error("expected a revision ID");
    std::array<std::uint8_t, SCPEFE_REVISION_ID_SIZE> result{};
    const auto digit = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        return -1;
    };
    for (std::size_t i = 0; i < result.size(); ++i) {
        const int high = digit(input[i * 2]), low = digit(input[i * 2 + 1]);
        if (high < 0 || low < 0) throw std::runtime_error("expected a revision ID");
        result[i] = static_cast<std::uint8_t>((high << 4) | low);
    }
    return result;
}

void throw_status(napi_env env, scpefe_status status)
{
    const std::string message = "SCPEFE operation failed with status "
        + std::to_string(static_cast<unsigned int>(status));
    napi_value code, text, error;
    check(env, napi_create_string_utf8(env, "SCPEFE_NATIVE", NAPI_AUTO_LENGTH, &code));
    check(env, napi_create_string_utf8(env, message.c_str(), message.size(), &text));
    check(env, napi_create_error(env, code, text, &error));
    set_number(env, error, "status", static_cast<unsigned int>(status));
    check(env, napi_throw(env, error));
}

std::pair<const std::uint8_t *, std::size_t> buffer_value(
    napi_env env, napi_value value)
{
    bool is_buffer = false;
    check(env, napi_is_buffer(env, value, &is_buffer));
    if (!is_buffer) throw std::runtime_error("expected a Buffer");
    void *bytes = nullptr;
    std::size_t size = 0;
    check(env, napi_get_buffer_info(env, value, &bytes, &size));
    return {static_cast<const std::uint8_t *>(bytes), size};
}

template<class Operation>
napi_value output_buffer(napi_env env, Operation operation)
{
    std::size_t size = 0;
    auto status = operation(nullptr, 0, &size);
    if (status != SCPEFE_STATUS_BUFFER_TOO_SMALL) {
        throw_status(env, status); return nullptr;
    }
    void *bytes = nullptr;
    napi_value result;
    check(env, napi_create_buffer(env, size, &bytes, &result));
    status = operation(static_cast<std::uint8_t *>(bytes), size, &size);
    if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
    return result;
}

struct ContainerContext {
    scpefe_context *context{};
    scpefe_container *active{};

    ~ContainerContext()
    {
        if (active) scpefe_container_close(active);
        if (context) scpefe_context_destroy(context);
    }
};

ContainerContext *container_context(napi_env env, napi_callback_info info,
    size_t &argc, napi_value *args);

using RevisionGraphOwner = std::unique_ptr<scpefe_revision_graph,
    decltype(&scpefe_revision_graph_destroy)>;

RevisionGraphOwner revision_graph(napi_env env, ContainerContext *owner)
{
    scpefe_revision_graph *graph = nullptr;
    const auto status = scpefe_container_revision_graph(owner->active, &graph);
    if (status != SCPEFE_STATUS_OK) {
        throw_status(env, status); return {nullptr, scpefe_revision_graph_destroy};
    }
    return {graph, scpefe_revision_graph_destroy};
}

void set_revision_id(napi_env env, napi_value object, const char *name,
    const std::uint8_t *id)
{
    const auto hex = hexadecimal(id, SCPEFE_REVISION_ID_SIZE);
    set_string(env, object, name, hex.data(), hex.size());
}

void set_event_details(napi_env env, napi_value object,
    const scpefe_revision_metadata_v1 &metadata)
{
    if (!metadata.event_details_cbor_size) return;
    if (metadata.event_details_cbor_size > 4096) {
        set_boolean(env, object, "detailsTruncated", true);
        return;
    }
    const auto hex = hexadecimal(metadata.event_details_cbor,
        metadata.event_details_cbor_size);
    set_string(env, object, "eventDetailsCbor", hex.data(), hex.size());
}

napi_value container_history_page(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 2;
        napi_value args[2];
        auto *owner = container_context(env, info, argc, args);
        if (argc != 2) throw std::runtime_error("historyPage expects offset and count");
        const auto offset = number_value(env, args[0]);
        const auto count = number_value(env, args[1]);
        if (offset > std::numeric_limits<std::size_t>::max()
            || offset > 9007199254740991ULL - count || count == 0
            || count > 50) throw std::runtime_error("invalid history page bounds");
        auto graph = revision_graph(env, owner);
        if (!graph) return nullptr;
        scpefe_revision_page *page = nullptr;
        auto status = scpefe_revision_graph_list(graph.get(),
            static_cast<std::size_t>(offset), static_cast<std::size_t>(count + 1), &page);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        std::unique_ptr<scpefe_revision_page, decltype(&scpefe_revision_page_destroy)>
            owned(page, scpefe_revision_page_destroy);
        std::size_t available = 0;
        status = scpefe_revision_page_count(page, &available);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        const auto length = std::min(available, static_cast<std::size_t>(count));
        napi_value result, items;
        check(env, napi_create_object(env, &result));
        check(env, napi_create_array_with_length(env, length, &items));
        for (std::size_t i = 0; i < length; ++i) {
            scpefe_revision_metadata_v1 metadata{};
            metadata.struct_size = sizeof(metadata);
            status = scpefe_revision_page_metadata(page, i, &metadata);
            if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
            napi_value item, sources;
            check(env, napi_create_object(env, &item));
            set_revision_id(env, item, "revisionId", metadata.id);
            if (metadata.has_previous_head)
                set_revision_id(env, item, "previousHead", metadata.previous_head);
            if (metadata.has_content_parent)
                set_revision_id(env, item, "contentParent", metadata.content_parent);
            if (metadata.has_resolved_by)
                set_revision_id(env, item, "resolvedBy", metadata.resolved_by);
            check(env, napi_create_array_with_length(env, metadata.merge_source_count, &sources));
            for (std::size_t j = 0; j < metadata.merge_source_count; ++j) {
                const auto hex = hexadecimal(metadata.merge_source_ids
                    + j * SCPEFE_REVISION_ID_SIZE, SCPEFE_REVISION_ID_SIZE);
                napi_value source;
                check(env, napi_create_string_utf8(env, hex.data(), hex.size(), &source));
                check(env, napi_set_element(env, sources, j, source));
            }
            check(env, napi_set_named_property(env, item, "mergeSources", sources));
            set_number(env, item, "timestampMs", metadata.timestamp_ms);
            const auto slot = hexadecimal(metadata.actor_slot_id, SCPEFE_SLOT_ID_SIZE);
            set_string(env, item, "actorSlotId", slot.data(), slot.size());
            set_string(env, item, "actorName", metadata.actor_name, metadata.actor_name_size);
            set_string(env, item, "actorEmail", metadata.actor_email, metadata.actor_email_size);
            set_string(env, item, "clientName", metadata.client_name, metadata.client_name_size);
            set_string(env, item, "clientEmail", metadata.client_email, metadata.client_email_size);
            set_string(env, item, "device", metadata.device, metadata.device_size);
            set_string(env, item, "eventType", metadata.event_type, metadata.event_type_size);
            set_number(env, item, "kind", metadata.original_kind);
            set_number(env, item, "storageKind", metadata.storage_kind);
            set_boolean(env, item, "foreign", metadata.foreign != 0);
            set_boolean(env, item, "provisional", metadata.provisional != 0);
            set_boolean(env, item, "bodyAvailable", metadata.body_available != 0);
            set_boolean(env, item, "textAvailable", metadata.text_available != 0);
            set_event_details(env, item, metadata);
            check(env, napi_set_element(env, items, i, item));
        }
        check(env, napi_set_named_property(env, result, "items", items));
        set_number(env, result, "nextOffset", offset + length);
        set_boolean(env, result, "hasMore", available > count);
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_history_compare(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 2;
        napi_value args[2];
        auto *owner = container_context(env, info, argc, args);
        if (argc != 2) throw std::runtime_error("historyCompare expects two revision IDs");
        const auto before = revision_id(env, args[0]);
        const auto after = revision_id(env, args[1]);
        auto graph = revision_graph(env, owner);
        if (!graph) return nullptr;
        scpefe_revision_result *comparison = nullptr;
        const auto status = scpefe_revision_graph_compare(graph.get(),
            before.data(), after.data(), &comparison);
        napi_value result;
        check(env, napi_create_object(env, &result));
        if (status == SCPEFE_STATUS_BODY_UNAVAILABLE) {
            set_boolean(env, result, "available", false); return result;
        }
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        std::unique_ptr<scpefe_revision_result, decltype(&scpefe_revision_result_destroy)>
            owned(comparison, scpefe_revision_result_destroy);
        scpefe_revision_result_view_v1 view{};
        view.struct_size = sizeof(view);
        const auto view_status = scpefe_revision_result_view(owned.get(), &view);
        if (view_status != SCPEFE_STATUS_OK) { throw_status(env, view_status); return nullptr; }
        set_boolean(env, result, "available", true);
        set_string(env, result, "text", view.text, view.text_size);
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

scpefe_status monotonic_time(void *, std::uint64_t *value)
{
    if (!value) return SCPEFE_STATUS_INVALID_ARGUMENT;
    *value = static_cast<std::uint64_t>(std::chrono::duration_cast<
        std::chrono::milliseconds>(std::chrono::steady_clock::now()
            .time_since_epoch()).count());
    return SCPEFE_STATUS_OK;
}

napi_value open_revised_document(napi_env env, const std::uint8_t *bytes,
    std::size_t size, const SecretBytes &password)
{
    scpefe_host_services_v1 host{sizeof(host), SCPEFE_ABI_VERSION,
        nullptr, monotonic_time};
    scpefe_context *raw_context = nullptr;
    auto status = scpefe_context_create(&host, &raw_context);
    if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
    std::unique_ptr<scpefe_context, decltype(&scpefe_context_destroy)>
        context(raw_context, scpefe_context_destroy);
    scpefe_container *handle = nullptr;
    const scpefe_container_open_v1 open{sizeof(open), SCPEFE_ABI_VERSION,
        bytes, size};
    status = scpefe_container_open(context.get(), &open, &handle);
    if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
    const scpefe_password_input_v1 input{sizeof(input), SCPEFE_ABI_VERSION,
        password.data(), password.size()};
    status = scpefe_container_unlock(handle, &input);
    if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
    scpefe_owned_authenticated_state *raw_auth = nullptr;
    status = scpefe_container_authenticated_state(handle, &raw_auth);
    if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
    std::unique_ptr<scpefe_owned_authenticated_state,
        decltype(&scpefe_owned_authenticated_state_destroy)>
        auth(raw_auth, scpefe_owned_authenticated_state_destroy);
    scpefe_owned_authenticated_state_view_v1 view{};
    view.struct_size = sizeof(view);
    view.abi_version = SCPEFE_ABI_VERSION;
    status = scpefe_owned_authenticated_state_view(auth.get(), &view);
    if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
    scpefe_container_status_v1 access{sizeof(access), SCPEFE_ABI_VERSION};
    status = scpefe_container_status(handle, &access);
    if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
    napi_value result;
    check(env, napi_create_object(env, &result));
    set_number(env, result, "containerFormatVersion", 3);
    set_string(env, result, "documentId",
        hexadecimal(view.document_id, sizeof(view.document_id)).c_str(),
        sizeof(view.document_id) * 2);
    const auto head = hexadecimal(view.revision_head, sizeof(view.revision_head));
    set_string(env, result, "baseRevision", head.data(), head.size());
    set_buffer(env, result, "journalKey", view.work_journal_key,
        sizeof(view.work_journal_key));
    sodium_memzero(view.work_journal_key, sizeof(view.work_journal_key));
    set_number(env, result, "revisionTimestampMs", view.revision_timestamp_ms);
    set_boolean(env, result, "manuallySealed", view.manually_sealed != 0);
    set_string(env, result, "historyEventType", view.event_type, view.event_type_size);
    set_string(env, result, "historyEventDetail", view.event_detail,
        view.event_detail_size);
    set_string(env, result, "profileName", view.client_name, view.client_name_size);
    set_string(env, result, "profileEmail", view.client_email, view.client_email_size);
    set_string(env, result, "deviceName", view.device_name, view.device_name_size);
    set_string(env, result, "content", "", 0);
    set_boolean(env, result, "readOnly", true);
    set_boolean(env, result, "canEdit", access.can_edit && !access.must_change_password);
    set_boolean(env, result, "canAddPasswords",
        access.can_add_passwords && !access.must_change_password);
    set_boolean(env, result, "canRemovePasswords",
        access.can_remove_passwords && !access.must_change_password);
    set_boolean(env, result, "mustBeChanged", view.must_change_password != 0);
    set_boolean(env, result, "recoverySlot", view.recovery_slot != 0);
    const auto slot_id = hexadecimal(view.slot_id, sizeof(view.slot_id));
    set_string(env, result, "slotId", slot_id.data(), slot_id.size());
    set_string(env, result, "slotIdentityName", view.identity_name,
        view.identity_name_size);
    set_string(env, result, "slotIdentityEmail", view.identity_email,
        view.identity_email_size);
    napi_value lease;
    check(env, napi_create_object(env, &lease));
    set_boolean(env, lease, "active", view.lease_active != 0);
    const auto session = hexadecimal(view.lease_session_id,
        sizeof(view.lease_session_id));
    set_string(env, lease, "sessionId", session.data(), session.size());
    set_number(env, lease, "heartbeatCounter", view.lease_heartbeat_counter);
    set_number(env, lease, "holderUtcMs", view.lease_holder_utc_ms);
    set_number(env, lease, "durationMs", view.lease_duration_ms);
    set_string(env, lease, "holderName", view.lease_holder_name,
        view.lease_holder_name_size);
    set_string(env, lease, "holderEmail", view.lease_holder_email,
        view.lease_holder_email_size);
    set_string(env, lease, "deviceName", view.lease_device_name,
        view.lease_device_name_size);
    check(env, napi_set_named_property(env, result, "lease", lease));
    napi_value graph_nodes;
    check(env, napi_create_array(env, &graph_nodes));
    std::size_t node_index = 0;
    if (!view.must_change_password) {
        scpefe_owned_snapshot *raw_snapshot = nullptr;
        status = scpefe_container_read(handle, &raw_snapshot);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        std::unique_ptr<scpefe_owned_snapshot, decltype(&scpefe_owned_snapshot_destroy)>
            snapshot(raw_snapshot, scpefe_owned_snapshot_destroy);
        scpefe_owned_snapshot_view_v1 content{};
        content.struct_size = sizeof(content);
        content.abi_version = SCPEFE_ABI_VERSION;
        status = scpefe_owned_snapshot_view(snapshot.get(), &content);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        set_string(env, result, "content", content.content, content.content_size);
        scpefe_owned_slots *raw_slots = nullptr;
        status = scpefe_container_slots(handle, &raw_slots);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        std::unique_ptr<scpefe_owned_slots, decltype(&scpefe_owned_slots_destroy)>
            slots(raw_slots, scpefe_owned_slots_destroy);
        std::size_t slot_count = 0;
        status = scpefe_owned_slots_count(slots.get(), &slot_count);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        napi_value managed;
        check(env, napi_create_array(env, &managed));
        std::uint32_t managed_index = 0;
        for (std::size_t i = 0; i < slot_count; ++i) {
            scpefe_owned_slot_view_v1 slot{};
            slot.struct_size = sizeof(slot);
            status = scpefe_owned_slots_view(slots.get(), i, &slot);
            if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
            if (slot.role != 1 || !access.can_remove_passwords) continue;
            napi_value item;
            check(env, napi_create_object(env, &item));
            const auto id = hexadecimal(slot.slot_id, sizeof(slot.slot_id));
            set_string(env, item, "slotId", id.data(), id.size());
            set_boolean(env, item, "canEdit", slot.can_edit != 0);
            set_boolean(env, item, "canAddPasswords", slot.can_add_passwords != 0);
            set_boolean(env, item, "canRemovePasswords", slot.can_remove_passwords != 0);
            set_boolean(env, item, "mustBeChanged", slot.must_change_password != 0);
            set_boolean(env, item, "slotIdKnown", true);
            set_boolean(env, item, "permissionsKnown", true);
            set_boolean(env, item, "identityKnown", true);
            set_boolean(env, item, "mustBeChangedKnown", true);
            set_string(env, item, "identityName", slot.name, slot.name_size);
            set_string(env, item, "identityEmail", slot.email, slot.email_size);
            check(env, napi_set_element(env, managed, managed_index++, item));
        }
        check(env, napi_set_named_property(env, result, "managedSlots", managed));
        scpefe_revision_graph *raw_graph = nullptr;
        status = scpefe_container_revision_graph(handle, &raw_graph);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        std::unique_ptr<scpefe_revision_graph, decltype(&scpefe_revision_graph_destroy)>
            graph(raw_graph, scpefe_revision_graph_destroy);
        for (std::size_t offset = 0;; offset += 128) {
            scpefe_revision_page *raw_page = nullptr;
            status = scpefe_revision_graph_list(graph.get(), offset, 128, &raw_page);
            if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
            std::unique_ptr<scpefe_revision_page, decltype(&scpefe_revision_page_destroy)>
                page(raw_page, scpefe_revision_page_destroy);
            std::size_t count = 0;
            status = scpefe_revision_page_count(page.get(), &count);
            if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
            for (std::size_t i = 0; i < count; ++i) {
                scpefe_revision_metadata_v1 metadata{};
                metadata.struct_size = sizeof(metadata);
                status = scpefe_revision_page_metadata(page.get(), i, &metadata);
                if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
                napi_value node, parents;
                check(env, napi_create_object(env, &node));
                check(env, napi_create_array(env, &parents));
                const auto id = hexadecimal(metadata.id, sizeof(metadata.id));
                set_string(env, node, "revisionId", id.data(), id.size());
                if (metadata.has_previous_head) {
                    napi_value parent;
                    const auto previous = hexadecimal(metadata.previous_head,
                        sizeof(metadata.previous_head));
                    check(env, napi_create_string_utf8(env, previous.data(),
                        previous.size(), &parent));
                    check(env, napi_set_element(env, parents, 0, parent));
                }
                check(env, napi_set_named_property(env, node,
                    "parentRevisionIds", parents));
                check(env, napi_set_element(env, graph_nodes, node_index++, node));
            }
            if (count < 128) break;
        }
    }
    if (node_index == 0) {
        napi_value node, parents;
        check(env, napi_create_object(env, &node));
        check(env, napi_create_array(env, &parents));
        set_string(env, node, "revisionId", head.data(), head.size());
        check(env, napi_set_named_property(env, node, "parentRevisionIds", parents));
        check(env, napi_set_element(env, graph_nodes, 0, node));
    }
    check(env, napi_set_named_property(env, result, "revisionGraph", graph_nodes));
    return result;
}

ContainerContext *container_context(napi_env env, napi_callback_info info,
    size_t &argc, napi_value *args)
{
    napi_value receiver;
    check(env, napi_get_cb_info(env, info, &argc, args, &receiver, nullptr));
    ContainerContext *context = nullptr;
    check(env, napi_unwrap(env, receiver, reinterpret_cast<void **>(&context)));
    if (!context) throw std::runtime_error("container context is closed");
    return context;
}

napi_value container_open(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 1;
        napi_value args[1];
        auto *owner = container_context(env, info, argc, args);
        if (argc != 1) throw std::runtime_error("open expects a Buffer");
        auto [bytes, size] = buffer_value(env, args[0]);
        scpefe_container_open_v1 request{sizeof(request), SCPEFE_ABI_VERSION, bytes, size};
        scpefe_container *handle = nullptr;
        const auto status = scpefe_container_open(owner->context, &request, &handle);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        owner->active = handle;
        return args[0];
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_create(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 1;
        napi_value args[1];
        auto *owner = container_context(env, info, argc, args);
        if (argc != 1) throw std::runtime_error("create expects one object");
        const std::string name = string_value(env, property(env, args[0], "name"));
        const std::string email = string_value(env, property(env, args[0], "email"));
        const std::string device = string_value(env, property(env, args[0], "deviceName"));
        const std::string content = string_value(env, property(env, args[0], "content"));
        const SecretBytes password{env, property(env, args[0], "ownerPassword")};
        napi_value recovery_value = property(env, args[0], "recoveryPassword");
        napi_valuetype recovery_type;
        check(env, napi_typeof(env, recovery_value, &recovery_type));
        const bool has_recovery = recovery_type == napi_string;
        SecretBytes recovery;
        if (has_recovery) recovery.assign(env, recovery_value);
        double timestamp = 0;
        check(env, napi_get_value_double(
            env, property(env, args[0], "timestampMs"), &timestamp));
        const scpefe_new_document_v1 document{
            sizeof(scpefe_new_document_v1),
            name.data(), name.size(), email.data(), email.size(),
            device.data(), device.size(), content.data(), content.size(),
            static_cast<std::uint64_t>(timestamp),
            password.data(), password.size(),
            has_recovery ? recovery.data() : nullptr,
            has_recovery ? recovery.size() : 0,
        };
        if (owner->active) {
            throw_status(env, SCPEFE_STATUS_INVALID_STATE);
            return nullptr;
        }
        const scpefe_container_create_v1 request{
            sizeof(request), SCPEFE_ABI_VERSION, document};
        scpefe_container *handle = nullptr;
        const auto status = scpefe_container_create(owner->context, &request, &handle);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        owner->active = handle;
        return output_buffer(env, [&](std::uint8_t *output,
            std::size_t capacity, std::size_t *size) {
            return scpefe_container_copy_bytes(handle, output, capacity, size);
        });
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_unlock(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 1;
        napi_value args[1];
        auto *owner = container_context(env, info, argc, args);
        if (argc != 1) throw std::runtime_error("unlock expects a password");
        const SecretBytes password{env, args[0]};
        scpefe_password_input_v1 input{sizeof(input), SCPEFE_ABI_VERSION,
            password.data(), password.size()};
        const auto status = scpefe_container_unlock(owner->active, &input);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        napi_value result;
        check(env, napi_get_boolean(env, true, &result));
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_lock(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 0;
        auto *owner = container_context(env, info, argc, nullptr);
        const auto status = scpefe_container_lock(owner->active);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        napi_value result;
        check(env, napi_get_boolean(env, true, &result));
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_close(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 0;
        auto *owner = container_context(env, info, argc, nullptr);
        const auto status = scpefe_container_close(owner->active);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        owner->active = nullptr;
        napi_value result;
        check(env, napi_get_boolean(env, true, &result));
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_read(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 0;
        auto *owner = container_context(env, info, argc, nullptr);
        scpefe_owned_snapshot *snapshot = nullptr;
        const auto status = scpefe_container_read(owner->active, &snapshot);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        std::unique_ptr<scpefe_owned_snapshot, decltype(&scpefe_owned_snapshot_destroy)>
            owned(snapshot, scpefe_owned_snapshot_destroy);
        scpefe_owned_snapshot_view_v1 view{};
        view.struct_size = sizeof(view);
        view.abi_version = SCPEFE_ABI_VERSION;
        const auto view_status = scpefe_owned_snapshot_view(owned.get(), &view);
        if (view_status != SCPEFE_STATUS_OK) {
            throw_status(env, view_status); return nullptr;
        }
        napi_value result;
        check(env, napi_create_object(env, &result));
        set_string(env, result, "content", view.content, view.content_size);
        const auto id = hexadecimal(view.document_id, SCPEFE_DOCUMENT_ID_SIZE);
        set_string(env, result, "documentId", id.data(), id.size());
        const auto slot = hexadecimal(view.slot_id, SCPEFE_SLOT_ID_SIZE);
        set_string(env, result, "slotId", slot.data(), slot.size());
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_bytes(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 0;
        auto *owner = container_context(env, info, argc, nullptr);
        return output_buffer(env, [&](std::uint8_t *output, std::size_t capacity,
            std::size_t *size) {
            return scpefe_container_copy_bytes(owner->active, output, capacity, size);
        });
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_status(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 0;
        auto *owner = container_context(env, info, argc, nullptr);
        scpefe_container_status_v1 status{sizeof(status), SCPEFE_ABI_VERSION};
        const auto result = scpefe_container_status(owner->active, &status);
        if (result != SCPEFE_STATUS_OK) { throw_status(env, result); return nullptr; }
        napi_value object;
        check(env, napi_create_object(env, &object));
        set_boolean(env, object, "locked", status.is_locked != 0);
        set_boolean(env, object, "canEdit", status.can_edit != 0);
        set_boolean(env, object, "canAddPasswords", status.can_add_passwords != 0);
        set_boolean(env, object, "canRemovePasswords", status.can_remove_passwords != 0);
        set_boolean(env, object, "mustChangePassword", status.must_change_password != 0);
        return object;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_confirm_edit_lease(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 0;
        auto *owner = container_context(env, info, argc, nullptr);
        const auto status = scpefe_container_confirm_edit_lease(owner->active);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        napi_value result;
        check(env, napi_get_boolean(env, true, &result));
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

std::array<std::uint8_t, SCPEFE_SLOT_ID_SIZE> parse_slot_id(
    const std::string &input);

napi_value container_lease_mode(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 0;
        auto *owner = container_context(env, info, argc, nullptr);
        scpefe_container_lease_mode_v1 mode{sizeof(mode), SCPEFE_ABI_VERSION};
        const auto status = scpefe_container_lease_mode(owner->active, &mode);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        napi_value result;
        check(env, napi_create_object(env, &result));
        set_boolean(env, result, "editing", mode.is_editing != 0);
        const char *relation = mode.lease_status == SCPEFE_LEASE_HELD ? "held"
            : mode.lease_status == SCPEFE_LEASE_OTHER_HOLDER ? "other-holder"
            : mode.lease_status == SCPEFE_LEASE_UNCERTAIN ? "uncertain" : "none";
        set_string(env, result, "leaseStatus", relation, std::strlen(relation));
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_authenticated_lease(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 0;
        auto *owner = container_context(env, info, argc, nullptr);
        scpefe_owned_authenticated_state *raw = nullptr;
        const auto status = scpefe_container_authenticated_state(owner->active, &raw);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        std::unique_ptr<scpefe_owned_authenticated_state,
            decltype(&scpefe_owned_authenticated_state_destroy)>
            state(raw, scpefe_owned_authenticated_state_destroy);
        scpefe_owned_authenticated_state_view_v1 view{};
        view.struct_size = sizeof(view);
        view.abi_version = SCPEFE_ABI_VERSION;
        const auto viewed = scpefe_owned_authenticated_state_view(state.get(), &view);
        if (viewed != SCPEFE_STATUS_OK) { throw_status(env, viewed); return nullptr; }
        napi_value result;
        check(env, napi_create_object(env, &result));
        set_boolean(env, result, "active", view.lease_active != 0);
        const auto session = hexadecimal(view.lease_session_id,
            sizeof(view.lease_session_id));
        set_string(env, result, "sessionId", session.data(), session.size());
        set_number(env, result, "heartbeatCounter", view.lease_heartbeat_counter);
        set_number(env, result, "holderUtcMs", view.lease_holder_utc_ms);
        set_number(env, result, "durationMs", view.lease_duration_ms);
        set_string(env, result, "holderName", view.lease_holder_name,
            view.lease_holder_name_size);
        set_string(env, result, "holderEmail", view.lease_holder_email,
            view.lease_holder_email_size);
        set_string(env, result, "deviceName", view.lease_device_name,
            view.lease_device_name_size);
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_lease_advice(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 1;
        napi_value args[1];
        auto *owner = container_context(env, info, argc, args);
        if (argc != 1) throw std::runtime_error("leaseAdvice expects host evidence");
        const auto session = parse_slot_id(string_value(env,
            property(env, args[0], "suspendedSessionId")));
        scpefe_container_lease_advice_v1 advice{};
        advice.struct_size = sizeof(advice);
        advice.abi_version = SCPEFE_ABI_VERSION;
        std::copy(session.begin(), session.end(), advice.suspended_session_id);
        advice.suspended_heartbeat_counter = number_value(env,
            property(env, args[0], "suspendedCounter"));
        advice.now_utc_ms = number_value(env, property(env, args[0], "nowUtcMs"));
        advice.unchanged_monotonic_ms = number_value(env,
            property(env, args[0], "unchangedMonotonicMs"));
        const auto status = scpefe_container_lease_advice(owner->active, &advice);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        const char *entry = advice.entry == SCPEFE_LEASE_ENTRY_ACQUIRE ? "acquire"
            : advice.entry == SCPEFE_LEASE_ENTRY_RESUME ? "resume"
            : advice.entry == SCPEFE_LEASE_ENTRY_TAKEOVER ? "takeover"
            : advice.entry == SCPEFE_LEASE_ENTRY_CONFIRM_TAKEOVER ? "confirm-takeover"
            : advice.entry == SCPEFE_LEASE_ENTRY_CHANGED ? "changed" : "blocked";
        napi_value result;
        check(env, napi_create_string_utf8(env, entry, NAPI_AUTO_LENGTH, &result));
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_prepare_lease_change(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 3;
        napi_value args[3];
        auto *owner = container_context(env, info, argc, args);
        if (argc != 3) throw std::runtime_error(
            "prepareLeaseChange expects action, password, and input");
        const auto action = string_value(env, args[0]);
        const auto native_action = action == "acquire" ? SCPEFE_LEASE_ACQUIRE
            : action == "refresh" ? SCPEFE_LEASE_REFRESH
            : action == "release" ? SCPEFE_LEASE_RELEASE
            : action == "resume" ? SCPEFE_LEASE_RESUME
            : action == "takeover" ? SCPEFE_LEASE_TAKEOVER
            : throw std::runtime_error("unknown lease action");
        const SecretBytes password{env, args[1]};
        const auto input = args[2];
        const auto session = parse_slot_id(string_value(env,
            property(env, input, "sessionId")));
        const auto expected = parse_slot_id(string_value(env,
            property(env, input, "expectedSessionId")));
        const auto name = string_value(env, property(env, input, "holderName"));
        const auto email = string_value(env, property(env, input, "holderEmail"));
        const auto device = string_value(env, property(env, input, "deviceName"));
        const scpefe_container_lease_change_v1 request{
            sizeof(request), SCPEFE_ABI_VERSION,
            number_value(env, property(env, input, "operationId")), native_action,
            password.data(), password.size(), session.data(), session.size(),
            boolean_value(env, property(env, input, "expectedActive")),
            expected.data(), expected.size(),
            number_value(env, property(env, input, "expectedHeartbeatCounter")),
            number_value(env, property(env, input, "expectedHolderUtcMs")),
            number_value(env, property(env, input, "expectedDurationMs")),
            number_value(env, property(env, input, "nowUtcMs")),
            number_value(env, property(env, input, "unchangedMonotonicMs")),
            number_value(env, property(env, input, "durationMs")),
            name.data(), name.size(), email.data(), email.size(),
            device.data(), device.size(),
            boolean_value(env, property(env, input, "explicitTakeover"))};
        scpefe_candidate_info_v1 candidate{sizeof(candidate), SCPEFE_ABI_VERSION};
        const auto status = scpefe_container_prepare_lease_change(
            owner->active, &request, &candidate);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        napi_value bytes = output_buffer(env,
            [&](std::uint8_t *output, std::size_t capacity, std::size_t *size) {
                return scpefe_container_copy_candidate(owner->active,
                    candidate.operation_id, output, capacity, size);
            });
        if (!bytes) return nullptr;
        napi_value result;
        check(env, napi_create_object(env, &result));
        check(env, napi_set_named_property(env, result, "bytes", bytes));
        set_number(env, result, "operationId", candidate.operation_id);
        set_number(env, result, "effects", candidate.effect_mask);
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_prepare_save(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 3;
        napi_value args[3];
        auto *owner = container_context(env, info, argc, args);
        if (argc != 3) throw std::runtime_error("prepareSave expects kind, password, and input");
        const std::string kind = string_value(env, args[0]);
        const auto save_kind = kind == "manual" ? SCPEFE_SAVE_MANUAL
            : kind == "regular" ? SCPEFE_SAVE_REGULAR
            : kind == "discard" ? SCPEFE_SAVE_DISCARD
            : throw std::runtime_error("unknown save kind");
        const SecretBytes password{env, args[1]};
        const std::string name = string_value(env, property(env, args[2], "name"));
        const std::string email = string_value(env, property(env, args[2], "email"));
        const std::string device = string_value(env, property(env, args[2], "deviceName"));
        const std::string content = string_value(env, property(env, args[2], "content"));
        double timestamp = 0;
        check(env, napi_get_value_double(env, property(env, args[2], "timestampMs"), &timestamp));
        double operation = 0;
        check(env, napi_get_value_double(env, property(env, args[2], "operationId"), &operation));
        if (!std::isfinite(timestamp) || timestamp < 0 || !std::isfinite(operation)
            || operation < 1 || operation > 9007199254740991.0
            || std::floor(operation) != operation)
            throw std::runtime_error("invalid save timestamp or operation ID");
        auto status = scpefe_container_submit_content(owner->active, content.data(), content.size());
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        const scpefe_container_save_v1 request{sizeof(request), SCPEFE_ABI_VERSION,
            static_cast<std::uint64_t>(operation), save_kind,
            password.data(), password.size(), name.data(), name.size(),
            email.data(), email.size(), device.data(), device.size(),
            static_cast<std::uint64_t>(timestamp)};
        scpefe_candidate_info_v1 candidate{sizeof(candidate), SCPEFE_ABI_VERSION};
        status = scpefe_container_prepare_save(owner->active, &request, &candidate);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        napi_value bytes = output_buffer(env,
            [&](std::uint8_t *output, std::size_t capacity, std::size_t *size) {
                return scpefe_container_copy_candidate(owner->active,
                    candidate.operation_id, output, capacity, size);
            });
        if (!bytes) return nullptr;
        napi_value result;
        check(env, napi_create_object(env, &result));
        check(env, napi_set_named_property(env, result, "bytes", bytes));
        set_number(env, result, "operationId", static_cast<double>(candidate.operation_id));
        set_number(env, result, "effects", candidate.effect_mask);
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_assess_merge(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 4;
        napi_value args[4];
        auto *owner = container_context(env, info, argc, args);
        if (argc != 4)
            throw std::runtime_error("assessMerge expects local bytes, two passwords, and input");
        const auto [local, local_size] = buffer_value(env, args[0]);
        const SecretBytes local_password{env, args[1]};
        const SecretBytes target_password{env, args[2]};
        const std::string name = string_value(env, property(env, args[3], "name"));
        const std::string email = string_value(env, property(env, args[3], "email"));
        const std::string device = string_value(env, property(env, args[3], "deviceName"));
        const std::string content = string_value(env, property(env, args[3], "content"));
        double timestamp = 0;
        check(env, napi_get_value_double(env,
            property(env, args[3], "timestampMs"), &timestamp));
        if (!std::isfinite(timestamp) || timestamp < 0 || std::floor(timestamp) != timestamp)
            throw std::runtime_error("invalid merge timestamp");
        const scpefe_container_merge_v1 request{
            sizeof(request), SCPEFE_ABI_VERSION, 0, local, local_size,
            target_password.data(), target_password.size(),
            local_password.data(), local_password.size(),
            name.data(), name.size(), email.data(), email.size(),
            device.data(), device.size(), content.data(), content.size(),
            static_cast<std::uint64_t>(timestamp),
        };
        const auto status = scpefe_container_assess_merge(owner->active, &request);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        napi_value result;
        check(env, napi_get_boolean(env, true, &result));
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_prepare_merge(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 4;
        napi_value args[4];
        auto *owner = container_context(env, info, argc, args);
        if (argc != 4)
            throw std::runtime_error("prepareMerge expects local bytes, two passwords, and input");
        const auto [local, local_size] = buffer_value(env, args[0]);
        const SecretBytes local_password{env, args[1]};
        const SecretBytes target_password{env, args[2]};
        const std::string name = string_value(env, property(env, args[3], "name"));
        const std::string email = string_value(env, property(env, args[3], "email"));
        const std::string device = string_value(env, property(env, args[3], "deviceName"));
        const std::string content = string_value(env, property(env, args[3], "content"));
        double timestamp = 0;
        check(env, napi_get_value_double(env,
            property(env, args[3], "timestampMs"), &timestamp));
        double operation = 0;
        check(env, napi_get_value_double(env,
            property(env, args[3], "operationId"), &operation));
        if (!std::isfinite(timestamp) || timestamp < 0 || std::floor(timestamp) != timestamp
            || !std::isfinite(operation) || operation < 1
            || operation > 9007199254740991.0 || std::floor(operation) != operation)
            throw std::runtime_error("invalid merge timestamp or operation ID");
        const scpefe_container_merge_v1 request{
            sizeof(request), SCPEFE_ABI_VERSION,
            static_cast<std::uint64_t>(operation), local, local_size,
            target_password.data(), target_password.size(),
            local_password.data(), local_password.size(),
            name.data(), name.size(), email.data(), email.size(),
            device.data(), device.size(), content.data(), content.size(),
            static_cast<std::uint64_t>(timestamp),
        };
        scpefe_candidate_info_v1 candidate{sizeof(candidate), SCPEFE_ABI_VERSION};
        const auto status = scpefe_container_prepare_merge(owner->active,
            &request, &candidate);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        napi_value bytes = output_buffer(env,
            [&](std::uint8_t *output, std::size_t capacity, std::size_t *size) {
                return scpefe_container_copy_candidate(owner->active,
                    candidate.operation_id, output, capacity, size);
            });
        if (!bytes) return nullptr;
        napi_value result;
        check(env, napi_create_object(env, &result));
        check(env, napi_set_named_property(env, result, "bytes", bytes));
        set_number(env, result, "operationId",
            static_cast<double>(candidate.operation_id));
        set_number(env, result, "effects", candidate.effect_mask);
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_prepare_compaction(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 2;
        napi_value args[2];
        auto *owner = container_context(env, info, argc, args);
        if (argc != 2) throw std::runtime_error(
            "prepareCompaction expects a password and verified host evidence");
        const SecretBytes password{env, args[0]};
        const auto input = args[1];
        const auto session = parse_slot_id(string_value(env,
            property(env, input, "sessionId")));
        const auto [backup, backup_size] = buffer_value(env,
            property(env, input, "verifiedBackupBytes"));
        const auto name = string_value(env, property(env, input, "clientName"));
        const auto email = string_value(env, property(env, input, "clientEmail"));
        const auto device = string_value(env, property(env, input, "deviceName"));
        scpefe_container_compaction_v1 request{};
        request.struct_size = sizeof(request);
        request.abi_version = SCPEFE_ABI_VERSION;
        request.operation_id = number_value(env, property(env, input, "operationId"));
        request.password = password.data();
        request.password_size = password.size();
        request.lease_session_id = session.data();
        request.lease_session_id_size = session.size();
        request.lease_heartbeat_counter = number_value(env,
            property(env, input, "heartbeatCounter"));
        request.explicit_decision = boolean_value(env,
            property(env, input, "explicitDecision"));
        request.clean_state_confirmed = boolean_value(env,
            property(env, input, "cleanStateConfirmed"));
        request.backup_verified = boolean_value(env,
            property(env, input, "backupVerified"));
        request.verified_backup_bytes = backup;
        request.verified_backup_size = backup_size;
        request.client_name = name.data();
        request.client_name_size = name.size();
        request.client_email = email.data();
        request.client_email_size = email.size();
        request.device_name = device.data();
        request.device_name_size = device.size();
        request.timestamp_ms = number_value(env, property(env, input, "timestampMs"));
        scpefe_candidate_info_v1 candidate{sizeof(candidate), SCPEFE_ABI_VERSION};
        const auto status = scpefe_container_prepare_compaction(
            owner->active, &request, &candidate);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        napi_value bytes = output_buffer(env,
            [&](std::uint8_t *output, std::size_t capacity, std::size_t *size) {
                return scpefe_container_copy_candidate(owner->active,
                    candidate.operation_id, output, capacity, size);
            });
        if (!bytes) return nullptr;
        napi_value result;
        check(env, napi_create_object(env, &result));
        check(env, napi_set_named_property(env, result, "bytes", bytes));
        set_number(env, result, "operationId", candidate.operation_id);
        set_number(env, result, "effects", candidate.effect_mask);
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_prepare_activity(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 3;
        napi_value args[3];
        auto *owner = container_context(env, info, argc, args);
        if (argc != 3) throw std::runtime_error(
            "prepareActivity expects phase, password, and input");
        const auto phase = string_value(env, args[0]);
        if (phase != "attempt" && phase != "outcome")
            throw std::runtime_error("unknown activity phase");
        const SecretBytes password{env, args[1]};
        const auto input = args[2];
        const auto kind = string_value(env, property(env, input, "kind"));
        if (kind != "backup" && kind != "export")
            throw std::runtime_error("unknown activity kind");
        const auto [observed, observed_size] = buffer_value(env,
            property(env, input, "observedTarget"));
        const auto name = string_value(env, property(env, input, "clientName"));
        const auto email = string_value(env, property(env, input, "clientEmail"));
        const auto device = string_value(env, property(env, input, "deviceName"));
        const scpefe_container_activity_v1 request{
            sizeof(request), SCPEFE_ABI_VERSION,
            number_value(env, property(env, input, "operationId")),
            kind == "backup" ? SCPEFE_ACTIVITY_BACKUP : SCPEFE_ACTIVITY_EXPORT,
            boolean_value(env, property(env, input, "cleanStateConfirmed")),
            observed, observed_size, password.data(), password.size(),
            name.data(), name.size(), email.data(), email.size(),
            device.data(), device.size(),
            number_value(env, property(env, input, "timestampMs"))};
        scpefe_candidate_info_v1 candidate{sizeof(candidate), SCPEFE_ABI_VERSION};
        const auto status = phase == "attempt"
            ? scpefe_container_prepare_activity_attempt(owner->active,
                &request, &candidate)
            : scpefe_container_prepare_activity_outcome(owner->active,
                &request, &candidate);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        napi_value bytes = output_buffer(env,
            [&](std::uint8_t *output, std::size_t capacity, std::size_t *size) {
                return scpefe_container_copy_candidate(owner->active,
                    candidate.operation_id, output, capacity, size);
            });
        if (!bytes) return nullptr;
        napi_value result;
        check(env, napi_create_object(env, &result));
        check(env, napi_set_named_property(env, result, "bytes", bytes));
        set_number(env, result, "operationId", candidate.operation_id);
        set_number(env, result, "effects", candidate.effect_mask);
        const auto source_head = hexadecimal(candidate.source_head,
            SCPEFE_REVISION_ID_SIZE);
        set_string(env, result, "sourceHead",
            source_head.data(), source_head.size());
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_complete_activity(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 2;
        napi_value args[2];
        auto *owner = container_context(env, info, argc, args);
        if (argc != 2) throw std::runtime_error(
            "completeActivity expects attempt ID and success");
        std::uint32_t effects = 0;
        const auto status = scpefe_container_complete_activity(owner->active,
            number_value(env, args[0]), boolean_value(env, args[1]), &effects);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        napi_value result;
        check(env, napi_create_uint32(env, effects, &result));
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_restore_activity(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 1;
        napi_value args[1];
        auto *owner = container_context(env, info, argc, args);
        if (argc != 1) throw std::runtime_error("restoreActivity expects an outcome");
        const auto input = args[0];
        const auto kind = string_value(env, property(env, input, "kind"));
        if (kind != "backup" && kind != "export")
            throw std::runtime_error("unknown activity kind");
        const auto head = revision_id(env, property(env, input, "attemptHead"));
        const auto [observed, size] = buffer_value(env,
            property(env, input, "observedTarget"));
        scpefe_activity_recovery_v1 request{};
        request.struct_size = sizeof(request);
        request.abi_version = SCPEFE_ABI_VERSION;
        request.attempt_operation_id = number_value(env,
            property(env, input, "attemptOperationId"));
        request.kind = kind == "backup" ? SCPEFE_ACTIVITY_BACKUP : SCPEFE_ACTIVITY_EXPORT;
        std::copy(head.begin(), head.end(), request.attempt_head);
        request.succeeded = boolean_value(env, property(env, input, "succeeded"));
        request.observed_target = observed;
        request.observed_target_size = size;
        const auto status = scpefe_container_restore_activity_outcome(
            owner->active, &request);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        napi_value result;
        check(env, napi_get_boolean(env, true, &result));
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_activity_status(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 0;
        auto *owner = container_context(env, info, argc, nullptr);
        scpefe_activity_status_v1 status{sizeof(status), SCPEFE_ABI_VERSION};
        const auto result_status = scpefe_container_activity_status(owner->active, &status);
        if (result_status != SCPEFE_STATUS_OK) {
            throw_status(env, result_status); return nullptr;
        }
        napi_value result;
        check(env, napi_create_object(env, &result));
        set_boolean(env, result, "hasPending", status.has_pending != 0);
        if (status.has_pending) {
            const auto *kind = status.kind == SCPEFE_ACTIVITY_BACKUP
                ? "backup" : "export";
            set_string(env, result, "kind", kind, std::strlen(kind));
            set_number(env, result, "attemptOperationId", status.attempt_operation_id);
            const auto head = hexadecimal(status.attempt_head,
                SCPEFE_REVISION_ID_SIZE);
            set_string(env, result, "attemptHead", head.data(), head.size());
            set_boolean(env, result, "hostActionComplete", status.host_action_complete != 0);
            set_boolean(env, result, "succeeded", status.succeeded != 0);
            set_boolean(env, result, "outcomePending", status.outcome_pending != 0);
        }
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_finish_save(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 2;
        napi_value args[2];
        auto *owner = container_context(env, info, argc, args);
        if (argc != 2) throw std::runtime_error("finishSave expects operation ID and outcome");
        double operation = 0;
        check(env, napi_get_value_double(env, args[0], &operation));
        if (!std::isfinite(operation) || operation < 1 || operation > 9007199254740991.0
            || std::floor(operation) != operation)
            throw std::runtime_error("invalid save operation ID");
        const std::string outcome = string_value(env, args[1]);
        const auto native_outcome = outcome == "verified" ? SCPEFE_PUBLICATION_VERIFIED
            : outcome == "definite-failure" ? SCPEFE_PUBLICATION_DEFINITE_FAILURE
            : outcome == "ambiguous" ? SCPEFE_PUBLICATION_AMBIGUOUS
            : throw std::runtime_error("unknown save outcome");
        std::uint32_t effects = 0;
        const auto status = scpefe_container_acknowledge_save(owner->active,
            static_cast<std::uint64_t>(operation), native_outcome, &effects);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        napi_value result;
        check(env, napi_create_uint32(env, effects, &result));
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_resolve_save(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 2;
        napi_value args[2];
        auto *owner = container_context(env, info, argc, args);
        if (argc != 2) throw std::runtime_error("resolveSave expects operation ID and published flag");
        double operation = 0;
        bool published = false;
        check(env, napi_get_value_double(env, args[0], &operation));
        check(env, napi_get_value_bool(env, args[1], &published));
        if (!std::isfinite(operation) || operation < 1 || operation > 9007199254740991.0
            || std::floor(operation) != operation)
            throw std::runtime_error("invalid save operation ID");
        std::uint32_t effects = 0;
        const auto status = scpefe_container_resolve_save(owner->active,
            static_cast<std::uint64_t>(operation), published ? 1 : 0, &effects);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        napi_value result;
        check(env, napi_create_uint32(env, effects, &result));
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

std::array<std::uint8_t, SCPEFE_SLOT_ID_SIZE> parse_slot_id(
    const std::string &input);

napi_value container_slots(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 0;
        auto *owner = container_context(env, info, argc, nullptr);
        scpefe_owned_slots *raw = nullptr;
        const auto status = scpefe_container_slots(owner->active, &raw);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        std::unique_ptr<scpefe_owned_slots, decltype(&scpefe_owned_slots_destroy)>
            slots(raw, scpefe_owned_slots_destroy);
        std::size_t count = 0;
        const auto count_status = scpefe_owned_slots_count(slots.get(), &count);
        if (count_status != SCPEFE_STATUS_OK) {
            throw_status(env, count_status); return nullptr;
        }
        napi_value result;
        check(env, napi_create_array_with_length(env, count, &result));
        for (std::size_t index = 0; index < count; ++index) {
            scpefe_owned_slot_view_v1 view{};
            view.struct_size = sizeof(view);
            const auto view_status = scpefe_owned_slots_view(slots.get(), index, &view);
            if (view_status != SCPEFE_STATUS_OK) {
                throw_status(env, view_status); return nullptr;
            }
            napi_value item;
            check(env, napi_create_object(env, &item));
            const auto id = hexadecimal(view.slot_id, sizeof(view.slot_id));
            const auto management_id = hexadecimal(
                view.management_id, sizeof(view.management_id));
            set_string(env, item, "slotId", id.data(), id.size());
            set_string(env, item, "managementId", management_id.data(),
                management_id.size());
            set_number(env, item, "role", view.role);
            set_boolean(env, item, "canEdit", view.can_edit != 0);
            set_boolean(env, item, "canAddPasswords", view.can_add_passwords != 0);
            set_boolean(env, item, "canRemovePasswords", view.can_remove_passwords != 0);
            set_boolean(env, item, "mustBeChanged", view.must_change_password != 0);
            set_string(env, item, "identityName", view.name, view.name_size);
            set_string(env, item, "identityEmail", view.email, view.email_size);
            check(env, napi_set_element(env, result, index, item));
        }
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value container_prepare_slot_change(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 3;
        napi_value args[3];
        auto *owner = container_context(env, info, argc, args);
        if (argc != 3) throw std::runtime_error(
            "prepareSlotChange expects kind, current password, and input");
        const auto kind = string_value(env, args[0]);
        const auto native_kind = kind == "password" ? SCPEFE_SLOT_CHANGE_PASSWORD
            : kind == "invitation" ? SCPEFE_SLOT_ADD_INVITATION
            : kind == "claim" ? SCPEFE_SLOT_CLAIM_INVITATION
            : kind == "identity" ? SCPEFE_SLOT_RECONCILE_IDENTITY
            : kind == "permissions" ? SCPEFE_SLOT_UPDATE_PERMISSIONS
            : kind == "remove" ? SCPEFE_SLOT_REMOVE
            : throw std::runtime_error("unknown slot change kind");
        const SecretBytes actor{env, args[1]};
        const auto input = args[2];
        const auto optional_string = [&](const char *key) {
            const auto value = property(env, input, key);
            napi_valuetype type;
            check(env, napi_typeof(env, value, &type));
            return type == napi_undefined ? std::string{} : string_value(env, value);
        };
        const auto optional_bool = [&](const char *key) {
            const auto value = property(env, input, key);
            napi_valuetype type;
            check(env, napi_typeof(env, value, &type));
            return type == napi_undefined ? false : boolean_value(env, value);
        };
        const auto new_password_value = property(env, input, "newPassword");
        napi_valuetype new_password_type;
        check(env, napi_typeof(env, new_password_value, &new_password_type));
        SecretBytes new_password;
        if (new_password_type != napi_undefined)
            new_password.assign(env, new_password_value);
        const auto slot_id_text = optional_string("slotId");
        const auto slot_id = slot_id_text.empty()
            ? std::array<std::uint8_t, SCPEFE_SLOT_ID_SIZE>{}
            : parse_slot_id(slot_id_text);
        const auto name = optional_string("name");
        const auto email = optional_string("email");
        const auto client_name = string_value(env, property(env, input, "clientName"));
        const auto client_email = string_value(env, property(env, input, "clientEmail"));
        const auto device = string_value(env, property(env, input, "deviceName"));
        const scpefe_container_slot_change_v1 request{
            sizeof(request), SCPEFE_ABI_VERSION,
            number_value(env, property(env, input, "operationId")), native_kind,
            actor.data(), actor.size(),
            new_password.size() ? new_password.data() : nullptr, new_password.size(),
            slot_id_text.empty() ? nullptr : slot_id.data(),
            slot_id_text.empty() ? 0 : slot_id.size(),
            optional_bool("canEdit"), optional_bool("canAddPasswords"),
            optional_bool("canRemovePasswords"),
            name.data(), name.size(), email.data(), email.size(),
            client_name.data(), client_name.size(),
            client_email.data(), client_email.size(), device.data(), device.size(),
            number_value(env, property(env, input, "timestampMs"))};
        scpefe_candidate_info_v1 candidate{sizeof(candidate), SCPEFE_ABI_VERSION};
        const auto status = scpefe_container_prepare_slot_change(
            owner->active, &request, &candidate);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        napi_value bytes = output_buffer(env,
            [&](std::uint8_t *output, std::size_t capacity, std::size_t *size) {
                return scpefe_container_copy_candidate(owner->active,
                    candidate.operation_id, output, capacity, size);
            });
        if (!bytes) return nullptr;
        napi_value result;
        check(env, napi_create_object(env, &result));
        check(env, napi_set_named_property(env, result, "bytes", bytes));
        set_number(env, result, "operationId", candidate.operation_id);
        set_number(env, result, "effects", candidate.effect_mask);
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value create_container_context(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 0;
        check(env, napi_get_cb_info(env, info, &argc, nullptr, nullptr, nullptr));
        auto owner = std::make_unique<ContainerContext>();
        scpefe_host_services_v1 services{sizeof(services), SCPEFE_ABI_VERSION,
            nullptr, monotonic_time};
        const auto status = scpefe_context_create(&services, &owner->context);
        if (status != SCPEFE_STATUS_OK) { throw_status(env, status); return nullptr; }
        napi_value object;
        check(env, napi_create_object(env, &object));
        napi_property_descriptor methods[] = {
            {"create", nullptr, container_create, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"open", nullptr, container_open, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"unlock", nullptr, container_unlock, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"lock", nullptr, container_lock, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"close", nullptr, container_close, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"read", nullptr, container_read, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"bytes", nullptr, container_bytes, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"status", nullptr, container_status, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"confirmEditLease", nullptr, container_confirm_edit_lease, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"leaseMode", nullptr, container_lease_mode, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"authenticatedLease", nullptr, container_authenticated_lease, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"leaseAdvice", nullptr, container_lease_advice, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"prepareLeaseChange", nullptr, container_prepare_lease_change, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"prepareSave", nullptr, container_prepare_save, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"prepareMerge", nullptr, container_prepare_merge, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"assessMerge", nullptr, container_assess_merge, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"prepareCompaction", nullptr, container_prepare_compaction, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"prepareActivity", nullptr, container_prepare_activity, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"completeActivity", nullptr, container_complete_activity, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"restoreActivity", nullptr, container_restore_activity, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"activityStatus", nullptr, container_activity_status, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"prepareSlotChange", nullptr, container_prepare_slot_change, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"slots", nullptr, container_slots, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"finishSave", nullptr, container_finish_save, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"resolveSave", nullptr, container_resolve_save, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"historyPage", nullptr, container_history_page, nullptr, nullptr, nullptr, napi_default, nullptr},
            {"historyCompare", nullptr, container_history_compare, nullptr, nullptr, nullptr, napi_default, nullptr},
        };
        check(env, napi_define_properties(env, object, std::size(methods), methods));
        check(env, napi_wrap(env, object, owner.get(),
            [](napi_env, void *data, void *) {
                delete static_cast<ContainerContext *>(data);
            }, nullptr, nullptr));
        owner.release();
        return object;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value password_meets_policy(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 1;
        napi_value args[1];
        check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
        if (argc != 1) throw std::runtime_error("passwordMeetsPolicy expects one password");
        const SecretBytes password{env, args[0]};
        napi_value result;
        check(env, napi_get_boolean(env,
            scpefe_password_meets_policy(password.data(), password.size()) != 0,
            &result));
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what());
        return nullptr;
    }
}

napi_value assess_password_policy(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 1;
        napi_value args[1];
        check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
        if (argc != 1) throw std::runtime_error("assessPasswordPolicy expects one password");
        const SecretBytes password{env, args[0]};
        const scpefe_password_policy_assessment assessment =
            scpefe_assess_password_policy(password.data(), password.size());
        const char *reason = assessment == SCPEFE_PASSWORD_POLICY_ACCEPTED
            ? "accepted" : assessment == SCPEFE_PASSWORD_POLICY_MINIMUM_LENGTH
                ? "minimum-length" : assessment == SCPEFE_PASSWORD_POLICY_PREDICTABLE
                    ? "predictable" : "invalid";
        napi_value result;
        check(env, napi_create_string_utf8(env, reason, NAPI_AUTO_LENGTH, &result));
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what());
        return nullptr;
    }
}

napi_value inspect_document(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 2;
        napi_value args[2];
        check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
        if (argc != 2)
            throw std::runtime_error("inspectDocument expects a Buffer and password");
        const auto [bytes, size] = buffer_value(env, args[0]);
        const SecretBytes password{env, args[1]};
        return open_revised_document(env, bytes, size, password);
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

std::array<std::uint8_t, SCPEFE_LEASE_SESSION_ID_SIZE> parse_session_id(
    const std::string &hex)
{
    if (hex.size() != SCPEFE_LEASE_SESSION_ID_SIZE * 2)
        throw std::runtime_error("lease session ID must contain 32 hex characters");
    std::array<std::uint8_t, SCPEFE_LEASE_SESSION_ID_SIZE> result{};
    auto digit = [](char value) -> std::uint8_t {
        if (value >= '0' && value <= '9') return value - '0';
        if (value >= 'a' && value <= 'f') return value - 'a' + 10;
        throw std::runtime_error("lease session ID must be lowercase hexadecimal");
    };
    for (std::size_t i = 0; i < result.size(); ++i)
        result[i] = static_cast<std::uint8_t>(digit(hex[i * 2]) * 16 + digit(hex[i * 2 + 1]));
    return result;
}

std::array<std::uint8_t, SCPEFE_SLOT_ID_SIZE> parse_slot_id(
    const std::string &hex)
{
    if (hex.size() != SCPEFE_SLOT_ID_SIZE * 2)
        throw std::runtime_error("slot ID must contain 32 hex characters");
    std::array<std::uint8_t, SCPEFE_SLOT_ID_SIZE> result{};
    auto digit = [](char value) -> std::uint8_t {
        if (value >= '0' && value <= '9') return value - '0';
        if (value >= 'a' && value <= 'f') return value - 'a' + 10;
        throw std::runtime_error("slot ID must be lowercase hexadecimal");
    };
    for (std::size_t i = 0; i < result.size(); ++i)
        result[i] = static_cast<std::uint8_t>(digit(hex[i * 2]) * 16
            + digit(hex[i * 2 + 1]));
    return result;
}

napi_value initialize(napi_env env, napi_value exports)
{
    napi_property_descriptor methods[] = {
        {"createContainerContext", nullptr, create_container_context, nullptr,
            nullptr, nullptr, napi_default, nullptr},
        {"passwordMeetsPolicy", nullptr, password_meets_policy, nullptr, nullptr, nullptr,
            napi_default, nullptr},
        {"assessPasswordPolicy", nullptr, assess_password_policy, nullptr, nullptr, nullptr,
            napi_default, nullptr},
        {"inspectDocument", nullptr, inspect_document, nullptr, nullptr, nullptr,
            napi_default, nullptr},
    };
    check(env, napi_define_properties(env, exports, std::size(methods), methods));
    return exports;
}

} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
