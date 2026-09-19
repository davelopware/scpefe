#pragma once

#include "core/host_services.hpp"
#include "core/health_info.hpp"

namespace scpefe::core {

/* Owns per-context core state and coordinates host-backed operations. */
class Context {
public:
    /* Creates a context around one isolated host-services adapter. */
    explicit Context(HostServices host_services);
    /* Reads the context's current health information. */
    bool read_health(HealthInfo &health_info) const;

private:
    HostServices host_services_;
};

} // namespace scpefe::core
