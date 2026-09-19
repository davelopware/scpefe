#pragma once

#include "core/host_services.hpp"
#include "core/health_info.hpp"

namespace scpefe::core {

class Context {
public:
    explicit Context(HostServices host_services);
    bool read_health(HealthInfo &health_info) const;

private:
    HostServices host_services_;
};

} // namespace scpefe::core
