#include "scpefe/scpefe.h"

#include <node_api.h>

#include <array>
#include <cstdint>
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
    if (result < 0) throw std::runtime_error("expected a non-negative number");
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

void throw_status(napi_env env, scpefe_status status)
{
    const std::string message = "SCPEFE operation failed with status "
        + std::to_string(static_cast<unsigned int>(status));
    napi_throw_error(env, "SCPEFE_NATIVE", message.c_str());
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

napi_value create_document(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 1;
        napi_value args[1];
        check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
        if (argc != 1) throw std::runtime_error("createDocument expects one object");
        const std::string name = string_value(env, property(env, args[0], "name"));
        const std::string email = string_value(env, property(env, args[0], "email"));
        const std::string device = string_value(env, property(env, args[0], "deviceName"));
        const std::string content = string_value(env, property(env, args[0], "content"));
        const SecretBytes owner{env, property(env, args[0], "ownerPassword")};
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
            owner.data(), owner.size(),
            has_recovery ? recovery.data() : nullptr,
            has_recovery ? recovery.size() : 0,
        };
        std::size_t size = 0;
        scpefe_status status = scpefe_new_document_create(
            &document, nullptr, 0, &size);
        if (status != SCPEFE_STATUS_BUFFER_TOO_SMALL) {
            throw_status(env, status);
            return nullptr;
        }
        void *bytes = nullptr;
        napi_value buffer;
        check(env, napi_create_buffer(env, size, &bytes, &buffer));
        status = scpefe_new_document_create(
            &document, static_cast<std::uint8_t *>(bytes), size, &size);
        if (status != SCPEFE_STATUS_OK) {
            throw_status(env, status);
            return nullptr;
        }
        return buffer;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what());
        return nullptr;
    }
}

napi_value open_document(napi_env env, napi_callback_info info)
{
    scpefe_unlocked_container *unlocked = nullptr;
    scpefe_decoded_snapshot_revision *revision = nullptr;
    try {
        size_t argc = 2;
        napi_value args[2];
        check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
        if (argc != 2)
            throw std::runtime_error("openDocument expects a Buffer and password");
        bool is_buffer = false;
        check(env, napi_is_buffer(env, args[0], &is_buffer));
        if (!is_buffer)
            throw std::runtime_error("openDocument expects a Buffer and password");
        void *bytes = nullptr;
        size_t size = 0;
        check(env, napi_get_buffer_info(env, args[0], &bytes, &size));
        const SecretBytes password{env, args[1]};
        scpefe_status status = scpefe_password_container_unlock(
            static_cast<const std::uint8_t *>(bytes), size,
            password.data(), password.size(),
            &unlocked);
        if (status != SCPEFE_STATUS_OK) {
            scpefe_decoded_snapshot_revision_destroy(revision);
            revision = nullptr;
            scpefe_unlocked_container_destroy(unlocked);
            unlocked = nullptr;
            throw_status(env, status);
            return nullptr;
        }
        scpefe_unlocked_container_v1 unlocked_view{};
        unlocked_view.struct_size = sizeof(unlocked_view);
        status = scpefe_unlocked_container_view(unlocked, &unlocked_view);
        scpefe_unlocked_slot_access_v1 slot_access{};
        slot_access.struct_size = sizeof(slot_access);
        if (status == SCPEFE_STATUS_OK)
            status = scpefe_unlocked_container_slot_access(unlocked, &slot_access);
        scpefe_editing_lease_v1 editing_lease{};
        editing_lease.struct_size = sizeof(editing_lease);
        if (status == SCPEFE_STATUS_OK)
            status = scpefe_unlocked_container_editing_lease(unlocked, &editing_lease);
        scpefe_revision_limits_v1 limits{};
        limits.struct_size = sizeof(limits);
        if (status == SCPEFE_STATUS_OK)
            status = scpefe_revision_limits_default(&limits);
        if (status == SCPEFE_STATUS_OK)
            status = scpefe_snapshot_revision_decode(
                unlocked_view.encoded_snapshot_revision,
                unlocked_view.encoded_snapshot_revision_size, &limits, &revision);
        scpefe_snapshot_revision_v1 view{};
        view.struct_size = sizeof(view);
        if (status == SCPEFE_STATUS_OK)
            status = scpefe_decoded_snapshot_revision_view(revision, &view);
        if (status != SCPEFE_STATUS_OK) {
            scpefe_decoded_snapshot_revision_destroy(revision);
            revision = nullptr;
            scpefe_unlocked_container_destroy(unlocked);
            unlocked = nullptr;
            throw_status(env, status);
            return nullptr;
        }
        napi_value result;
        check(env, napi_create_object(env, &result));
        if (slot_access.must_be_changed)
            set_string(env, result, "content", "", 0);
        else
            set_string(env, result, "content", view.content, view.content_size);
        set_string(env, result, "profileName", view.client_profile_name,
            view.client_profile_name_size);
        set_string(env, result, "profileEmail", view.client_profile_email,
            view.client_profile_email_size);
        set_string(env, result, "deviceName", view.device_name,
            view.device_name_size);
        set_number(env, result, "revisionTimestampMs", view.timestamp_ms);
        set_boolean(env, result, "readOnly", true);
        set_boolean(env, result, "canEdit",
            slot_access.can_edit != 0 && !slot_access.must_be_changed);
        set_boolean(env, result, "canAddPasswords",
            slot_access.can_add_passwords != 0 && !slot_access.must_be_changed);
        set_boolean(env, result, "canRemovePasswords",
            slot_access.can_remove_passwords != 0 && !slot_access.must_be_changed);
        set_boolean(env, result, "mustBeChanged", slot_access.must_be_changed != 0);
        set_boolean(env, result, "recoverySlot", slot_access.recovery_slot != 0);
        const std::string slot_id = hexadecimal(
            slot_access.slot_id, slot_access.slot_id_size);
        set_string(env, result, "slotId", slot_id.data(), slot_id.size());
        const bool revision_matches_slot = view.slot_id_size == slot_access.slot_id_size
            && std::equal(view.slot_id, view.slot_id + view.slot_id_size,
                slot_access.slot_id);
        const char *identity_name = slot_access.identity_name_size != 0
            ? slot_access.identity_name
            : (revision_matches_slot ? view.slot_identity_name : "");
        const std::size_t identity_name_size = slot_access.identity_name_size != 0
            ? slot_access.identity_name_size
            : (revision_matches_slot ? view.slot_identity_name_size : 0);
        const char *identity_email = slot_access.identity_email_size != 0
            ? slot_access.identity_email
            : (revision_matches_slot ? view.slot_identity_email : "");
        const std::size_t identity_email_size = slot_access.identity_email_size != 0
            ? slot_access.identity_email_size
            : (revision_matches_slot ? view.slot_identity_email_size : 0);
        set_string(env, result, "slotIdentityName", identity_name,
            identity_name_size);
        set_string(env, result, "slotIdentityEmail", identity_email,
            identity_email_size);
        std::size_t managed_count = 0;
        status = scpefe_unlocked_container_managed_slot_count(
            unlocked, &managed_count);
        if (status != SCPEFE_STATUS_OK) {
            throw_status(env, status);
            return nullptr;
        }
        napi_value managed_slots;
        check(env, napi_create_array_with_length(env, managed_count, &managed_slots));
        for (std::size_t index = 0; index < managed_count; ++index) {
            scpefe_managed_slot_v1 managed{};
            managed.struct_size = sizeof(managed);
            status = scpefe_unlocked_container_managed_slot(
                unlocked, index, &managed);
            if (status != SCPEFE_STATUS_OK) {
                throw_status(env, status);
                return nullptr;
            }
            napi_value item;
            check(env, napi_create_object(env, &item));
            const std::string managed_id = hexadecimal(
                managed.slot_id, managed.slot_id_size);
            set_string(env, item, "slotId", managed_id.data(), managed_id.size());
            set_boolean(env, item, "canEdit", managed.can_edit != 0);
            set_boolean(env, item, "canAddPasswords", managed.can_add_passwords != 0);
            set_boolean(env, item, "canRemovePasswords", managed.can_remove_passwords != 0);
            set_boolean(env, item, "mustBeChanged", managed.must_be_changed != 0);
            set_boolean(env, item, "slotIdKnown", managed.slot_id_known != 0);
            set_boolean(env, item, "permissionsKnown", managed.permissions_known != 0);
            set_boolean(env, item, "identityKnown", managed.identity_known != 0);
            set_boolean(env, item, "mustBeChangedKnown",
                managed.must_be_changed_known != 0);
            set_string(env, item, "identityName", managed.identity_name,
                managed.identity_name_size);
            set_string(env, item, "identityEmail", managed.identity_email,
                managed.identity_email_size);
            check(env, napi_set_element(env, managed_slots, index, item));
        }
        check(env, napi_set_named_property(env, result, "managedSlots", managed_slots));
        napi_value lease;
        check(env, napi_create_object(env, &lease));
        set_boolean(env, lease, "active", editing_lease.active != 0);
        const std::string lease_session = hexadecimal(
            editing_lease.session_id, editing_lease.session_id_size);
        set_string(env, lease, "sessionId", lease_session.data(), lease_session.size());
        set_number(env, lease, "heartbeatCounter", editing_lease.heartbeat_counter);
        set_number(env, lease, "holderUtcMs", editing_lease.holder_utc_ms);
        set_number(env, lease, "durationMs", editing_lease.duration_ms);
        set_string(env, lease, "holderName", editing_lease.holder_name,
            editing_lease.holder_name_size);
        set_string(env, lease, "holderEmail", editing_lease.holder_email,
            editing_lease.holder_email_size);
        set_string(env, lease, "deviceName", editing_lease.device_name,
            editing_lease.device_name_size);
        check(env, napi_set_named_property(env, result, "lease", lease));
        const std::string document_id = hexadecimal(
            unlocked_view.document_id, unlocked_view.document_id_size);
        set_string(env, result, "documentId", document_id.data(), document_id.size());
        std::array<std::uint8_t, 32> revision_id{};
        if (crypto_generichash(revision_id.data(), revision_id.size(),
            unlocked_view.encoded_snapshot_revision,
            unlocked_view.encoded_snapshot_revision_size, nullptr, 0) != 0) {
            throw std::runtime_error("Unable to identify the base revision");
        }
        const std::string base_revision = hexadecimal(
            revision_id.data(), revision_id.size());
        set_string(env, result, "baseRevision", base_revision.data(),
            base_revision.size());
        set_revision_graph(env, result, revision_id.data(), view);
        set_boolean(env, result, "manuallySealed", view.manually_sealed != 0);
        std::array<std::uint8_t, SCPEFE_WORK_JOURNAL_KEY_SIZE> journal_key{};
        std::size_t journal_key_size = 0;
        status = scpefe_unlocked_container_work_journal_key(
            unlocked, journal_key.data(), journal_key.size(), &journal_key_size);
        if (status != SCPEFE_STATUS_OK) {
            sodium_memzero(journal_key.data(), journal_key.size());
            scpefe_decoded_snapshot_revision_destroy(revision);
            revision = nullptr;
            scpefe_unlocked_container_destroy(unlocked);
            unlocked = nullptr;
            throw_status(env, status);
            return nullptr;
        }
        try {
            set_buffer(env, result, "journalKey", journal_key.data(), journal_key_size);
        } catch (...) {
            sodium_memzero(journal_key.data(), journal_key.size());
            throw;
        }
        sodium_memzero(journal_key.data(), journal_key.size());
        scpefe_decoded_snapshot_revision_destroy(revision);
        scpefe_unlocked_container_destroy(unlocked);
        return result;
    } catch (const std::exception &error) {
        scpefe_decoded_snapshot_revision_destroy(revision);
        scpefe_unlocked_container_destroy(unlocked);
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what());
        return nullptr;
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

napi_value update_lease(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 3;
        napi_value args[3];
        check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
        bool is_buffer = false;
        if (argc != 3) throw std::runtime_error("updateLease expects a Buffer, password, and lease");
        check(env, napi_is_buffer(env, args[0], &is_buffer));
        if (!is_buffer) throw std::runtime_error("updateLease expects a Buffer");
        void *container = nullptr;
        size_t container_size = 0;
        check(env, napi_get_buffer_info(env, args[0], &container, &container_size));
        const SecretBytes password{env, args[1]};
        const bool active = boolean_value(env, property(env, args[2], "active"));
        const auto session = parse_session_id(string_value(
            env, property(env, args[2], "sessionId")));
        const std::string name = string_value(env, property(env, args[2], "holderName"));
        const std::string email = string_value(env, property(env, args[2], "holderEmail"));
        const std::string device = string_value(env, property(env, args[2], "deviceName"));
        const scpefe_editing_lease_v1 lease{
            sizeof(scpefe_editing_lease_v1), active, session.data(), session.size(),
            number_value(env, property(env, args[2], "heartbeatCounter")),
            number_value(env, property(env, args[2], "holderUtcMs")),
            number_value(env, property(env, args[2], "durationMs")),
            name.data(), name.size(), email.data(), email.size(),
            device.data(), device.size(),
        };
        const scpefe_editing_lease_update_v1 update{
            sizeof(scpefe_editing_lease_update_v1),
            static_cast<const std::uint8_t *>(container), container_size,
            password.data(), password.size(),
            lease,
        };
        std::size_t size = 0;
        scpefe_status status = scpefe_editing_lease_update(&update, nullptr, 0, &size);
        if (status != SCPEFE_STATUS_BUFFER_TOO_SMALL) {
            throw_status(env, status);
            return nullptr;
        }
        void *bytes = nullptr;
        napi_value result;
        check(env, napi_create_buffer(env, size, &bytes, &result));
        status = scpefe_editing_lease_update(&update,
            static_cast<std::uint8_t *>(bytes), size, &size);
        if (status != SCPEFE_STATUS_OK) {
            throw_status(env, status);
            return nullptr;
        }
        return result;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what());
        return nullptr;
    }
}

napi_value save_document(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 3;
        napi_value args[3];
        check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
        if (argc != 3)
            throw std::runtime_error("saveDocument expects a Buffer, password, and input");
        bool is_buffer = false;
        check(env, napi_is_buffer(env, args[0], &is_buffer));
        if (!is_buffer)
            throw std::runtime_error("saveDocument expects a Buffer");
        void *container = nullptr;
        size_t container_size = 0;
        check(env, napi_get_buffer_info(env, args[0], &container, &container_size));
        const SecretBytes password{env, args[1]};
        const std::string name = string_value(env, property(env, args[2], "name"));
        const std::string email = string_value(env, property(env, args[2], "email"));
        const std::string device = string_value(env, property(env, args[2], "deviceName"));
        const std::string content = string_value(env, property(env, args[2], "content"));
        double timestamp = 0;
        check(env, napi_get_value_double(
            env, property(env, args[2], "timestampMs"), &timestamp));
        const scpefe_manual_save_v1 save{
            sizeof(scpefe_manual_save_v1),
            static_cast<const std::uint8_t *>(container), container_size,
            password.data(), password.size(),
            name.data(), name.size(), email.data(), email.size(),
            device.data(), device.size(), content.data(), content.size(),
            static_cast<std::uint64_t>(timestamp),
        };
        std::size_t size = 0;
        scpefe_status status = scpefe_manual_save(&save, nullptr, 0, &size);
        if (status != SCPEFE_STATUS_BUFFER_TOO_SMALL) {
            throw_status(env, status);
            return nullptr;
        }
        void *bytes = nullptr;
        napi_value buffer;
        check(env, napi_create_buffer(env, size, &bytes, &buffer));
        status = scpefe_manual_save(
            &save, static_cast<std::uint8_t *>(bytes), size, &size);
        if (status != SCPEFE_STATUS_OK) {
            throw_status(env, status);
            return nullptr;
        }
        return buffer;
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what());
        return nullptr;
    }
}

napi_value regular_save_document(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 3;
        napi_value args[3];
        check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
        if (argc != 3)
            throw std::runtime_error(
                "regularSaveDocument expects a Buffer, password, and input");
        const auto [container, container_size] = buffer_value(env, args[0]);
        const SecretBytes password{env, args[1]};
        const std::string name = string_value(env, property(env, args[2], "name"));
        const std::string email = string_value(env, property(env, args[2], "email"));
        const std::string device = string_value(env, property(env, args[2], "deviceName"));
        const std::string content = string_value(env, property(env, args[2], "content"));
        double timestamp = 0;
        check(env, napi_get_value_double(
            env, property(env, args[2], "timestampMs"), &timestamp));
        const scpefe_regular_save_v1 save{
            sizeof(scpefe_regular_save_v1), container, container_size,
            password.data(), password.size(), name.data(), name.size(),
            email.data(), email.size(), device.data(), device.size(),
            content.data(), content.size(), static_cast<std::uint64_t>(timestamp),
        };
        return output_buffer(env, [&](std::uint8_t *output, std::size_t capacity,
            std::size_t *size) {
            return scpefe_regular_save(&save, output, capacity, size);
        });
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what());
        return nullptr;
    }
}

napi_value discard_provisional(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 2;
        napi_value args[2];
        check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
        if (argc != 2)
            throw std::runtime_error("discardProvisional expects a Buffer and password");
        const auto [container, container_size] = buffer_value(env, args[0]);
        const SecretBytes password{env, args[1]};
        return output_buffer(env, [&](std::uint8_t *output, std::size_t capacity,
            std::size_t *size) {
            return scpefe_provisional_save_discard(container, container_size,
                password.data(), password.size(), output, capacity, size);
        });
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what());
        return nullptr;
    }
}

napi_value merge_document(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 4;
        napi_value args[4];
        check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
        if (argc != 4)
            throw std::runtime_error(
                "mergeDocument expects current and local Buffers, password, and input");
        const auto [current, current_size] = buffer_value(env, args[0]);
        const auto [local, local_size] = buffer_value(env, args[1]);
        const SecretBytes password{env, args[2]};
        const std::string name = string_value(env, property(env, args[3], "name"));
        const std::string email = string_value(env, property(env, args[3], "email"));
        const std::string device = string_value(env, property(env, args[3], "deviceName"));
        const std::string content = string_value(env, property(env, args[3], "content"));
        double timestamp = 0;
        check(env, napi_get_value_double(
            env, property(env, args[3], "timestampMs"), &timestamp));
        const scpefe_merge_save_v1 save{
            sizeof(scpefe_merge_save_v1), current, current_size, local, local_size,
            password.data(), password.size(), name.data(), name.size(),
            email.data(), email.size(), device.data(), device.size(),
            content.data(), content.size(), static_cast<std::uint64_t>(timestamp),
        };
        return output_buffer(env, [&](std::uint8_t *output, std::size_t capacity,
            std::size_t *size) {
            return scpefe_merge_save(&save, output, capacity, size);
        });
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what());
        return nullptr;
    }
}

napi_value add_invitation(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 3; napi_value args[3];
        check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
        if (argc != 3) throw std::runtime_error(
            "addInvitation expects a Buffer, creator password, and request");
        const auto [container, container_size] = buffer_value(env, args[0]);
        const SecretBytes creator{env, args[1]};
        const SecretBytes temporary{env, property(env, args[2], "temporaryPassword")};
        const auto label = string_value(env, property(env, args[2], "temporaryLabel"));
        const scpefe_invitation_create_v1 request{
            sizeof(request), container, container_size,
            creator.data(), creator.size(), temporary.data(), temporary.size(),
            boolean_value(env, property(env, args[2], "canEdit")),
            boolean_value(env, property(env, args[2], "canAddPasswords")),
            boolean_value(env, property(env, args[2], "canRemovePasswords")),
            label.data(), label.size()};
        return output_buffer(env, [&](std::uint8_t *output, std::size_t capacity,
            std::size_t *size) { return scpefe_password_container_add_invitation(
                &request, output, capacity, size); });
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value claim_invitation(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 3; napi_value args[3];
        check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
        if (argc != 3) throw std::runtime_error(
            "claimInvitation expects a Buffer, temporary password, and request");
        const auto [container, container_size] = buffer_value(env, args[0]);
        const SecretBytes temporary{env, args[1]};
        const SecretBytes replacement{env, property(env, args[2], "newPassword")};
        const auto name = string_value(env, property(env, args[2], "name"));
        const auto email = string_value(env, property(env, args[2], "email"));
        const scpefe_invitation_claim_v1 request{
            sizeof(request), container, container_size,
            temporary.data(), temporary.size(), replacement.data(), replacement.size(),
            name.data(), name.size(), email.data(), email.size()};
        return output_buffer(env, [&](std::uint8_t *output, std::size_t capacity,
            std::size_t *size) { return scpefe_password_container_claim_invitation(
                &request, output, capacity, size); });
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value update_slot_permissions(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 3; napi_value args[3];
        check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
        if (argc != 3) throw std::runtime_error(
            "updateSlotPermissions expects a Buffer, administrator password, and request");
        const auto [container, container_size] = buffer_value(env, args[0]);
        const SecretBytes administrator{env, args[1]};
        const auto slot_id = parse_slot_id(string_value(
            env, property(env, args[2], "slotId")));
        const scpefe_slot_permissions_update_v1 request{
            sizeof(request), container, container_size,
            administrator.data(), administrator.size(), slot_id.data(), slot_id.size(),
            boolean_value(env, property(env, args[2], "canEdit")),
            boolean_value(env, property(env, args[2], "canAddPasswords")),
            boolean_value(env, property(env, args[2], "canRemovePasswords"))};
        return output_buffer(env, [&](std::uint8_t *output, std::size_t capacity,
            std::size_t *size) { return scpefe_password_container_update_slot_permissions(
                &request, output, capacity, size); });
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value remove_slot(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 3; napi_value args[3];
        check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
        if (argc != 3) throw std::runtime_error(
            "removeSlot expects a Buffer, administrator password, and slot ID");
        const auto [container, container_size] = buffer_value(env, args[0]);
        const SecretBytes administrator{env, args[1]};
        const auto slot_id = parse_slot_id(string_value(env, args[2]));
        const scpefe_slot_remove_v1 request{sizeof(request), container, container_size,
            administrator.data(), administrator.size(), slot_id.data(), slot_id.size()};
        return output_buffer(env, [&](std::uint8_t *output, std::size_t capacity,
            std::size_t *size) { return scpefe_password_container_remove_slot(
                &request, output, capacity, size); });
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value reconcile_identity(napi_env env, napi_callback_info info)
{
    try {
        size_t argc = 3; napi_value args[3];
        check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
        if (argc != 3) throw std::runtime_error(
            "reconcileIdentity expects a Buffer, password, and profile");
        const auto [container, container_size] = buffer_value(env, args[0]);
        const SecretBytes password{env, args[1]};
        const auto name = string_value(env, property(env, args[2], "name"));
        const auto email = string_value(env, property(env, args[2], "email"));
        const scpefe_slot_identity_reconcile_v1 request{
            sizeof(request), container, container_size, password.data(), password.size(),
            name.data(), name.size(), email.data(), email.size()};
        return output_buffer(env, [&](std::uint8_t *output, std::size_t capacity,
            std::size_t *size) { return scpefe_password_container_reconcile_identity(
                &request, output, capacity, size); });
    } catch (const std::exception &error) {
        napi_throw_type_error(env, "SCPEFE_INPUT", error.what()); return nullptr;
    }
}

napi_value initialize(napi_env env, napi_value exports)
{
    napi_property_descriptor methods[] = {
        {"createDocument", nullptr, create_document, nullptr, nullptr, nullptr,
            napi_default, nullptr},
        {"openDocument", nullptr, open_document, nullptr, nullptr, nullptr,
            napi_default, nullptr},
        {"saveDocument", nullptr, save_document, nullptr, nullptr, nullptr,
            napi_default, nullptr},
        {"regularSaveDocument", nullptr, regular_save_document, nullptr, nullptr,
            nullptr, napi_default, nullptr},
        {"discardProvisional", nullptr, discard_provisional, nullptr, nullptr,
            nullptr, napi_default, nullptr},
        {"mergeDocument", nullptr, merge_document, nullptr, nullptr, nullptr,
            napi_default, nullptr},
        {"updateLease", nullptr, update_lease, nullptr, nullptr, nullptr,
            napi_default, nullptr},
        {"addInvitation", nullptr, add_invitation, nullptr, nullptr, nullptr,
            napi_default, nullptr},
        {"claimInvitation", nullptr, claim_invitation, nullptr, nullptr, nullptr,
            napi_default, nullptr},
        {"updateSlotPermissions", nullptr, update_slot_permissions, nullptr, nullptr,
            nullptr, napi_default, nullptr},
        {"removeSlot", nullptr, remove_slot, nullptr, nullptr, nullptr,
            napi_default, nullptr},
        {"reconcileIdentity", nullptr, reconcile_identity, nullptr, nullptr, nullptr,
            napi_default, nullptr},
    };
    check(env, napi_define_properties(env, exports, 12, methods));
    return exports;
}

} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
