#include "scpefe/scpefe.h"

#include <new>

struct scpefe_context {
    scpefe_host_services_v1 host_services;
};

namespace {

constexpr const char *library_version = SCPEFE_VERSION_STRING;

bool has_complete_host_services(const scpefe_host_services_v1 *host_services)
{
    return host_services != nullptr
        && host_services->struct_size >= sizeof(scpefe_host_services_v1)
        && host_services->monotonic_time_ms != nullptr;
}

} // namespace

uint32_t scpefe_abi_version(void)
{
    return SCPEFE_ABI_VERSION;
}

const char *scpefe_library_version(void)
{
    return library_version;
}

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

    auto *created = new (std::nothrow) scpefe_context{*host_services};
    if (created == nullptr) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }

    *context = created;
    return SCPEFE_STATUS_OK;
}

void scpefe_context_destroy(scpefe_context *context)
{
    delete context;
}

scpefe_status scpefe_context_health(
    scpefe_context *context,
    scpefe_health_info_v1 *health_info
)
{
    if (context == nullptr || health_info == nullptr
        || health_info->struct_size < sizeof(scpefe_health_info_v1)) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }

    uint64_t host_time = 0;
    const scpefe_status host_status = context->host_services.monotonic_time_ms(
        context->host_services.instance_data,
        &host_time
    );
    if (host_status != SCPEFE_STATUS_OK) {
        return SCPEFE_STATUS_HOST_ERROR;
    }

    *health_info = scpefe_health_info_v1{
        sizeof(scpefe_health_info_v1),
        SCPEFE_ABI_VERSION,
        SCPEFE_VERSION_MAJOR,
        SCPEFE_VERSION_MINOR,
        SCPEFE_VERSION_PATCH,
        host_time,
    };
    return SCPEFE_STATUS_OK;
}
