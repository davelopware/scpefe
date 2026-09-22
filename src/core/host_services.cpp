#include "core/host_services.hpp"

namespace scpefe::core {

HostServices::HostServices(
    void *instance_data,
    scpefe_monotonic_time_ms_fn monotonic_time_ms
) : instance_data_(instance_data), monotonic_time_ms_(monotonic_time_ms)
{
}

bool HostServices::read_monotonic_time_ms(std::uint64_t &time_ms) const
{
    return monotonic_time_ms_(instance_data_, &time_ms) == SCPEFE_STATUS_OK;
}

} // namespace scpefe::core
