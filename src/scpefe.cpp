#include "scpefe/scpefe.h"

#include <new>

namespace {

constexpr const char *library_version = SCPEFE_VERSION_STRING;

bool has_complete_host_services(const scpefe_host_services_v1 *services)
{
    return services != nullptr
        && services->struct_size >= sizeof(scpefe_host_services_v1)
        && services->monotonic_time_ms != nullptr;
}

} // namespace

namespace scpefe::core {

class HostServices {
public:
    explicit HostServices(const scpefe_host_services_v1 &services)
        : instance_data_(services.instance_data),
          monotonic_time_ms_(services.monotonic_time_ms) {}

    bool read_monotonic_time_ms(uint64_t &time_ms) const
    {
        return monotonic_time_ms_(instance_data_, &time_ms) == SCPEFE_STATUS_OK;
    }

private:
    void *instance_data_;
    scpefe_monotonic_time_ms_fn monotonic_time_ms_;
};

struct HealthInfo {
    uint64_t host_monotonic_time_ms;
};

class Context {
public:
    explicit Context(const scpefe_host_services_v1 &services)
        : host_services_(services) {}

    bool read_health(HealthInfo &health_info) const
    {
        uint64_t host_time = 0;
        if (!host_services_.read_monotonic_time_ms(host_time)) {
            return false;
        }
        health_info.host_monotonic_time_ms = host_time;
        return true;
    }

private:
    HostServices host_services_;
};

} // namespace scpefe::core

struct scpefe_context {
    explicit scpefe_context(const scpefe_host_services_v1 &services)
        : implementation(services) {}

    scpefe::core::Context implementation;
};

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

    auto *created = new (std::nothrow) scpefe_context(*host_services);
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
