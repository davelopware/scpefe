#pragma once

#include "container/container_state.hpp"
#include "container/container_state_observer.hpp"

#include <cstdint>
#include <vector>

namespace scpefe::container {

/* Owns one container's installed state and observer subscriptions. */
class Container {
public:
    /* Injects only the state manager used for state-changing operations. */
    explicit Container(const ContainerStateManagerService &state_manager);
    /* Returns the currently installed immutable state snapshot. */
    const ContainerState &state() const { return state_; }
    /* Reports whether this session may expose currently available clear data. */
    bool can_read_clear() const;
    /* Computes, installs, and announces a valid state transition. */
    TransitionResult transition(const StateTransition &attempt);
    /* Attempts a transition while retaining state on a rejected request. */
    bool try_transition(const StateTransition &attempt);
    /* Subscribes an observer for the lifetime of this container or until removal. */
    void subscribe(ContainerStateObserver &observer);
    /* Removes a previously registered observer. */
    void unsubscribe(ContainerStateObserver &observer);

private:
    const ContainerStateManagerService &state_manager_;
    ContainerState state_{};
    std::vector<ContainerStateObserver *> observers_;
    bool transitioning_{};
};

} // namespace scpefe::container
