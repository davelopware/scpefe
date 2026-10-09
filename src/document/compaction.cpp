#include "document/compaction.hpp"

#include "container/container_error.hpp"
#include "container/recoverable_password_container.hpp"
#include "document/revision_transition.hpp"
#include "format/revision_limits.hpp"

#include <array>

namespace scpefe::document {

std::vector<std::uint8_t> Compaction::create(
    const std::uint8_t *container_bytes,
    std::size_t container_size,
    const std::uint8_t *password,
    std::size_t password_size,
    const std::array<std::uint8_t, 16> &lease_session_id,
    std::uint64_t lease_heartbeat_counter
)
{
    const auto limits = format::RevisionLimits::defaults();
    const auto unlocked = container::RecoverablePasswordContainer::unlock(
        container_bytes, container_size, password, password_size, limits);
    const bool full_administrator = (unlocked.permissions & 0x06u) == 0x06u;
    const bool holds_lease = unlocked.editing_lease.active
        && unlocked.editing_lease.session_id == lease_session_id
        && unlocked.editing_lease.heartbeat_counter == lease_heartbeat_counter;
    if (unlocked.must_be_changed || !full_administrator || !holds_lease) {
        throw container::ContainerFailure{container::ContainerError::invalid_argument};
    }

    const auto encoded = RevisionTransition::compact(unlocked);
    return container::RecoverablePasswordContainer::replace_snapshot(
        container_bytes, container_size, password, password_size,
        encoded.data(), encoded.size());
}

} // namespace scpefe::document
