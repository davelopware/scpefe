#include "scpefe/scpefe.h"

#include "core/context.hpp"
#include "core/host_services.hpp"

#include <new>
#include <utility>

namespace {

constexpr const char *library_version = SCPEFE_VERSION_STRING;

bool has_complete_host_services(const scpefe_host_services_v1 *services)
{
    return services != nullptr
        && services->struct_size >= sizeof(scpefe_host_services_v1)
        && services->monotonic_time_ms != nullptr;
}

} // namespace

struct scpefe_context {
    explicit scpefe_context(scpefe::core::Context value)
        : implementation(std::move(value)) {}
    scpefe::core::Context implementation;
};

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
    auto *created = new (std::nothrow) scpefe_context(
        scpefe::core::Context(std::move(internal_host))
    );
    if (created == nullptr) return SCPEFE_STATUS_OUT_OF_MEMORY;
    *context = created;
    return SCPEFE_STATUS_OK;
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
