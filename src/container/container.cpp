#include "container/container.hpp"

#include <algorithm>
#include <utility>

namespace scpefe::container {

Container::Container(const ContainerStateManagerService &state_manager)
    : state_manager_(state_manager) {}

bool Container::can_read_clear() const
{
    return state_.access == Access::open && state_.screen == Screen::unlocked;
}

TransitionResult Container::transition(const StateTransition &attempt)
{
    if (transitioning_) throw StateError::invalid_transition;
    auto result = state_manager_.apply(state_, attempt);
    if (result.state == state_) return result;
    const auto before = state_;
    transitioning_ = true;
    state_ = result.state;
    const auto operation_id = state_.operation_id.value_or(before.operation_id.value_or(0));
    for (auto *observer : observers_)
        observer->on_state_changed(before, state_, operation_id);
    transitioning_ = false;
    return result;
}

bool Container::try_transition(const StateTransition &attempt)
{
    try {
        transition(attempt);
        return true;
    } catch (StateError) {
        return false;
    }
}

void Container::subscribe(ContainerStateObserver &observer)
{
    if (std::find(observers_.begin(), observers_.end(), &observer) == observers_.end())
        observers_.push_back(&observer);
}

void Container::unsubscribe(ContainerStateObserver &observer)
{
    observers_.erase(std::remove(observers_.begin(), observers_.end(), &observer),
        observers_.end());
}

} // namespace scpefe::container
