#include "scpefe/scpefe.h"

#include <node_api.h>

#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

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
        napi_value read_only;
        check(env, napi_get_boolean(env, true, &read_only));
        check(env, napi_set_named_property(env, result, "readOnly", read_only));
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

napi_value initialize(napi_env env, napi_value exports)
{
    napi_property_descriptor methods[] = {
        {"createDocument", nullptr, create_document, nullptr, nullptr, nullptr,
            napi_default, nullptr},
        {"openDocument", nullptr, open_document, nullptr, nullptr, nullptr,
            napi_default, nullptr},
    };
    check(env, napi_define_properties(env, exports, 2, methods));
    return exports;
}

} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
