#include "scpefe/scpefe.h"

#include <node_api.h>

#include <array>
#include <cstdint>
#include <stdexcept>
#include <string>
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
        const std::string owner = string_value(env, property(env, args[0], "ownerPassword"));
        napi_value recovery_value = property(env, args[0], "recoveryPassword");
        napi_valuetype recovery_type;
        check(env, napi_typeof(env, recovery_value, &recovery_type));
        const bool has_recovery = recovery_type == napi_string;
        const std::string recovery = has_recovery
            ? string_value(env, recovery_value) : std::string{};
        double timestamp = 0;
        check(env, napi_get_value_double(
            env, property(env, args[0], "timestampMs"), &timestamp));
        const scpefe_new_document_v1 document{
            sizeof(scpefe_new_document_v1),
            name.data(), name.size(), email.data(), email.size(),
            device.data(), device.size(), content.data(), content.size(),
            static_cast<std::uint64_t>(timestamp),
            reinterpret_cast<const std::uint8_t *>(owner.data()), owner.size(),
            has_recovery
                ? reinterpret_cast<const std::uint8_t *>(recovery.data()) : nullptr,
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
        const std::string password = string_value(env, args[1]);
        scpefe_status status = scpefe_password_container_unlock(
            static_cast<const std::uint8_t *>(bytes), size,
            reinterpret_cast<const std::uint8_t *>(password.data()), password.size(),
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
        set_string(env, result, "content", view.content, view.content_size);
        set_string(env, result, "profileName", view.client_profile_name,
            view.client_profile_name_size);
        set_string(env, result, "profileEmail", view.client_profile_email,
            view.client_profile_email_size);
        set_string(env, result, "deviceName", view.device_name,
            view.device_name_size);
        set_boolean(env, result, "readOnly", true);
        set_boolean(env, result, "canEdit", slot_access.can_edit != 0);
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
        const std::string password = string_value(env, args[1]);
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
            reinterpret_cast<const std::uint8_t *>(password.data()), password.size(),
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
        const std::string password = string_value(env, args[1]);
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
            reinterpret_cast<const std::uint8_t *>(password.data()), password.size(),
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

napi_value initialize(napi_env env, napi_value exports)
{
    napi_property_descriptor methods[] = {
        {"createDocument", nullptr, create_document, nullptr, nullptr, nullptr,
            napi_default, nullptr},
        {"openDocument", nullptr, open_document, nullptr, nullptr, nullptr,
            napi_default, nullptr},
        {"saveDocument", nullptr, save_document, nullptr, nullptr, nullptr,
            napi_default, nullptr},
        {"updateLease", nullptr, update_lease, nullptr, nullptr, nullptr,
            napi_default, nullptr},
    };
    check(env, napi_define_properties(env, exports, 4, methods));
    return exports;
}

} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
