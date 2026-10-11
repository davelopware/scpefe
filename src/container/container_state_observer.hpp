#pragma once

#include "container/container_state.hpp"

#include <cstdint>

namespace scpefe::container {

/* Receives installed state snapshots synchronously after a transition. */
class ContainerStateObserver {
public:
    /* Allows observer implementations owned outside the container. */
    virtual ~ContainerStateObserver() = default;
    /* Observes an installed transition without performing required effects. */
    virtual void on_state_changed(const ContainerState &before,
        const ContainerState &after, std::uint64_t operation_id) noexcept = 0;
};

} // namespace scpefe::container
