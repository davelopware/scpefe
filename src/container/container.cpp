#include "container/container.hpp"
#include "container/container_error.hpp"
#include "document/new_document.hpp"
#include "format/revision_limits.hpp"
#include "security/password_strength.hpp"

#include <algorithm>
#include <cstring>
#include <utility>

namespace scpefe::container {

Container::Container(const ContainerStateManagerService &state_manager,
    const core::PasswordService &password, const core::EncryptionService &encryption,
    const core::PersistenceService &persistence, const core::HistoryService &history)
    : state_manager_(state_manager), password_(password), encryption_(encryption),
      persistence_(persistence), history_(history) {}

std::vector<std::uint8_t> Container::create_document(std::string_view profile_name,
    std::string_view profile_email, std::string_view device_name,
    std::string_view content, std::uint64_t timestamp_ms,
    const std::uint8_t *owner_password, std::size_t owner_password_size,
    const std::uint8_t *recovery_password, std::size_t recovery_password_size) const
{
    if (state_.access != Access::closed) throw StateError::invalid_transition;
    if (owner_password == nullptr || owner_password_size == 0
        || (recovery_password == nullptr && recovery_password_size != 0)
        || (recovery_password != nullptr && recovery_password_size == 0)
        || (recovery_password != nullptr && owner_password_size == recovery_password_size
            && std::memcmp(owner_password, recovery_password, owner_password_size) == 0))
        throw ContainerFailure{ContainerError::invalid_argument};
    if (password_.assess(owner_password, owner_password_size)
            != security::PasswordPolicyAssessment::accepted
        || (recovery_password && password_.assess(recovery_password,
            recovery_password_size) != security::PasswordPolicyAssessment::accepted))
        throw ContainerFailure{ContainerError::weak_password};
    return document::NewDocument::create(profile_name, profile_email,
        device_name, content, timestamp_ms, owner_password, owner_password_size,
        recovery_password, recovery_password_size, &encryption_);
}

void Container::open_legacy_document(const std::uint8_t *bytes, std::size_t size)
{
    if (state_.access != Access::closed) throw StateError::invalid_transition;
    if (!persistence_.recognizes_legacy_envelope(bytes, size))
        throw ContainerFailure{ContainerError::malformed_container};
    std::vector<std::uint8_t> incoming(bytes, bytes + size);
    transition(Open{});
    committed_bytes_ = std::move(incoming);
}

const UnlockedContainerData &Container::unlock_legacy_document(
    const std::uint8_t *password, std::size_t password_size)
{
    if (state_.access != Access::open || state_.screen != Screen::locked
        || committed_bytes_.empty()) throw StateError::invalid_transition;
    if (password == nullptr || password_size == 0)
        throw ContainerFailure{ContainerError::invalid_argument};
    auto decoded = persistence_.unlock_legacy_envelope(committed_bytes_.data(),
        committed_bytes_.size(), password, password_size,
        format::RevisionLimits::defaults());
    const Permissions rights{(decoded.permissions & 1u) != 0,
        (decoded.permissions & 2u) != 0, (decoded.permissions & 4u) != 0};
    const Unlock request{decoded.slot_id, rights, !decoded.must_be_changed};
    unlocked_.emplace(std::move(decoded));
    try {
        transition(request);
    } catch (...) {
        unlocked_.reset();
        throw;
    }
    return *unlocked_;
}

std::vector<std::uint8_t> Container::compact_legacy_document(
    const std::uint8_t *password, std::size_t password_size,
    const std::array<std::uint8_t, 16> &lease_session_id,
    std::uint64_t heartbeat_counter) const
{
    if (state_.access != Access::open || state_.screen != Screen::unlocked
        || state_.edit != EditMode::editing || state_.lease != Lease::held
        || !state_.permissions.can_edit || !state_.permissions.can_add_passwords
        || !state_.permissions.can_remove_passwords
        || state_.attention != Attention::none
        || state_.publication != PublicationPhase::idle
        || committed_bytes_.empty()) throw StateError::invalid_transition;
    if (password == nullptr || password_size == 0)
        throw ContainerFailure{ContainerError::invalid_argument};
    return history_.compact_legacy_document(committed_bytes_.data(),
        committed_bytes_.size(), password, password_size,
        lease_session_id, heartbeat_counter);
}

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
    if (std::holds_alternative<Close>(attempt)) {
        unlocked_.reset();
        committed_bytes_.clear();
    }
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
