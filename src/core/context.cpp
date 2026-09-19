#include "core/context.hpp"

#include <utility>

namespace scpefe::core {

Context::Context(HostServices host_services)
    : host_services_(std::move(host_services))
{
}

bool Context::read_health(HealthInfo &health_info) const
{
    std::uint64_t host_time = 0;
    if (!host_services_.read_monotonic_time_ms(host_time)) return false;
    health_info.host_monotonic_time_ms = host_time;
    return true;
}

} // namespace scpefe::core
