#include "container/container.hpp"
#include "container/container_error.hpp"
#include "document/new_document.hpp"
#include "format/revision_limits.hpp"
#include "security/password_strength.hpp"

#include <algorithm>
#include <cstring>
#include <utility>

namespace scpefe::container {
namespace {

std::uint8_t permission_bits(const Permissions &permissions)
{
    return static_cast<std::uint8_t>((permissions.can_edit ? 1u : 0u)
        | (permissions.can_add_passwords ? 2u : 0u)
        | (permissions.can_remove_passwords ? 4u : 0u));
}

} // namespace

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

void Container::open_document(const std::uint8_t *bytes, std::size_t size)
{
    constexpr std::uint8_t obsolete_v2_magic[8]{'S', 'C', 'P', 'E', 'F', 'E', 0, 2};
    if (bytes && size >= sizeof(obsolete_v2_magic)
        && std::memcmp(bytes, obsolete_v2_magic, sizeof(obsolete_v2_magic)) == 0)
        throw ContainerFailure{ContainerError::unsupported_format};
    open_legacy_document(bytes, size);
}

void Container::open_legacy_document(const std::uint8_t *bytes, std::size_t size)
{
    if (state_.access != Access::closed) throw StateError::invalid_transition;
    persistence_.validate_legacy_envelope(bytes, size);
    std::vector<std::uint8_t> incoming(bytes, bytes + size);
    committed_bytes_.swap(incoming);
    try {
        install_transition(Open{});
    } catch (...) {
        committed_bytes_.swap(incoming);
        throw;
    }
}

const UnlockedContainerData &Container::unlock_legacy_document(
    const std::uint8_t *password, std::size_t password_size)
{
    if (state_.access != Access::open || state_.screen != Screen::locked
        || committed_bytes_.empty()) throw StateError::invalid_transition;
    if (state_.attention == Attention::reauthenticate && target_bytes_.empty())
        throw StateError::invalid_transition;
    if (password == nullptr || password_size == 0)
        throw ContainerFailure{ContainerError::invalid_argument};
    const bool authenticating_target = !target_bytes_.empty();
    const auto &source = authenticating_target ? target_bytes_ : committed_bytes_;
    auto decoded = persistence_.unlock_legacy_envelope(source.data(),
        source.size(), password, password_size,
        format::RevisionLimits::defaults());
    if (document_id_ && decoded.document_id != *document_id_)
        throw ContainerFailure{ContainerError::malformed_container};
    if (authenticating_target && state_.target_access
        && (decoded.slot_id != state_.target_access->slot_id
            || decoded.permissions != permission_bits(state_.target_access->permissions)))
        throw ContainerFailure{ContainerError::malformed_container};
    const Permissions rights{(decoded.permissions & 1u) != 0,
        (decoded.permissions & 2u) != 0, (decoded.permissions & 4u) != 0};
    const Unlock request{decoded.slot_id, rights, !decoded.must_be_changed,
        authenticating_target};
    // Target authentication changes effective access, not the local committed
    // document or its retained clear projection.
    const bool retain_local_data = authenticating_target && unlocked_.has_value();
    if (!retain_local_data) unlocked_.emplace(std::move(decoded));
    try {
        install_transition(request);
    } catch (...) {
        if (!retain_local_data) unlocked_.reset();
        throw;
    }
    document_id_ = unlocked_->document_id;
    return *unlocked_;
}

TransitionResult Container::apply_target_legacy_document(
    const std::uint8_t *target_bytes, std::size_t target_size,
    const std::uint8_t *password, std::size_t password_size)
{
    if (state_.access != Access::open || state_.screen != Screen::unlocked
        || state_.publication != PublicationPhase::idle || !state_.active_slot
        || !document_id_ || committed_bytes_.empty() || state_.target_access
        || !target_bytes_.empty())
        throw StateError::invalid_transition;
    if (password == nullptr || password_size == 0)
        throw ContainerFailure{ContainerError::invalid_argument};
    persistence_.validate_legacy_envelope(target_bytes, target_size);
    auto decoded = persistence_.unlock_legacy_envelope(target_bytes, target_size,
        password, password_size, format::RevisionLimits::defaults());
    if (decoded.document_id != *document_id_)
        throw ContainerFailure{ContainerError::malformed_container};
    const bool active_slot_matched = decoded.slot_id == *state_.active_slot;
    bool wrapper_changed = !active_slot_matched;
    if (active_slot_matched) {
        try {
            const auto current = persistence_.unlock_legacy_envelope(committed_bytes_.data(),
                committed_bytes_.size(), password, password_size,
                format::RevisionLimits::defaults());
            wrapper_changed = current.slot_id != decoded.slot_id;
        } catch (const ContainerFailure &failure) {
            if (failure.error != ContainerError::authentication_failed) throw;
            wrapper_changed = true;
        }
    }
    const Permissions rights{active_slot_matched && (decoded.permissions & 1u) != 0,
        active_slot_matched && (decoded.permissions & 2u) != 0,
        active_slot_matched && (decoded.permissions & 4u) != 0};
    std::vector<std::uint8_t> incoming(target_bytes, target_bytes + target_size);
    target_bytes_.swap(incoming);
    try {
        return install_transition(ApplyTargetPermissions{rights, wrapper_changed});
    } catch (...) {
        target_bytes_.swap(incoming);
        throw;
    }
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

const UnlockedContainerData *Container::read_unlocked() const
{
    return can_read_clear() && unlocked_ ? &*unlocked_ : nullptr;
}

TransitionResult Container::transition(const StateTransition &attempt)
{
    if (!std::holds_alternative<Lock>(attempt)
        && !std::holds_alternative<Close>(attempt)
        && !std::holds_alternative<ReleaseEdit>(attempt)
        && !std::holds_alternative<RaiseAttention>(attempt))
        throw StateError::invalid_transition;
    return install_transition(attempt);
}

TransitionResult Container::install_transition(const StateTransition &attempt)
{
    if (transitioning_) throw StateError::invalid_transition;
    auto result = state_manager_.apply(state_, attempt);
    if (result.state == state_) return result;
    const auto before = state_;
    transitioning_ = true;
    state_ = result.state;
    if (unlocked_ && (std::holds_alternative<Unlock>(attempt)
        || std::holds_alternative<ApplyTargetPermissions>(attempt)))
        unlocked_->permissions = permission_bits(state_.permissions);
    if (std::holds_alternative<Close>(attempt)) {
        unlocked_.reset();
        committed_bytes_.clear();
        target_bytes_.clear();
        document_id_.reset();
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
