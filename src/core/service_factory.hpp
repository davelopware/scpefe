#pragma once

#include "core/service_registry.hpp"

namespace scpefe::core {

/* Composes the production services for one newly created context. */
class ServiceFactory {
public:
    /* Creates independently owned services for one context. */
    static ServiceRegistry create();
};

} // namespace scpefe::core
