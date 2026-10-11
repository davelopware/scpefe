#pragma once

#include "core/host_services.hpp"
#include "core/health_info.hpp"
#include "core/service_registry.hpp"
#include "container/container.hpp"

#include <memory>

namespace scpefe::core {

/* Owns per-context core state and coordinates host-backed operations. */
class Context {
public:
    /* Creates a context around one isolated host-services adapter. */
    explicit Context(HostServices host_services);
    /* Creates a context with a complete caller-supplied service registry. */
    Context(HostServices host_services, ServiceRegistry services);
    /* Reads the context's current health information. */
    bool read_health(HealthInfo &health_info) const;
    /* Returns this context's independently owned service registry. */
    ServiceRegistry &services() { return services_; }
    /* Constructs a stateful container with its narrow state dependency. */
    std::unique_ptr<container::Container> make_container() const;

private:
    HostServices host_services_;
    ServiceRegistry services_;
};

} // namespace scpefe::core
