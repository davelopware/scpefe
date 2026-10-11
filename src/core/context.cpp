#include "core/context.hpp"
#include "core/service_factory.hpp"
#include "container/container.hpp"

#include <memory>
#include <utility>

namespace scpefe::core {

Context::Context(HostServices host_services)
    : Context(std::move(host_services), ServiceFactory::create())
{
}

Context::Context(HostServices host_services, ServiceRegistry services)
    : host_services_(std::move(host_services)), services_(std::move(services))
{
}

bool Context::read_health(HealthInfo &health_info) const
{
    std::uint64_t host_time = 0;
    if (!host_services_.read_monotonic_time_ms(host_time)) return false;
    health_info.host_monotonic_time_ms = host_time;
    return true;
}

std::unique_ptr<container::Container> Context::make_container() const
{
    return std::make_unique<container::Container>(services_.state_manager());
}

} // namespace scpefe::core
