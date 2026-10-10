#include "document/migration.hpp"

#include "container/container_error.hpp"
#include "container/recoverable_password_container.hpp"
#include "document/revision_transition.hpp"
#include "format/revision_limits.hpp"

namespace scpefe::document {

std::vector<std::uint8_t> Migration::create(
    const std::uint8_t *container_bytes, std::size_t container_size,
    const std::uint8_t *password, std::size_t password_size,
    std::string_view profile_name, std::string_view profile_email,
    std::string_view device_name, std::uint64_t timestamp_ms,
    const container::EditingLeaseData &lease)
{
    const auto limits = format::RevisionLimits::defaults();
    const auto unlocked = container::RecoverablePasswordContainer::unlock(
        container_bytes, container_size, password, password_size, limits);
    if (unlocked.must_be_changed || (unlocked.permissions & 1u) == 0)
        throw container::ContainerFailure{container::ContainerError::invalid_argument};
    const auto encoded = RevisionTransition::migration(unlocked, profile_name,
        profile_email, device_name, timestamp_ms);
    return container::RecoverablePasswordContainer::migrate(
        container_bytes, container_size, password, password_size,
        encoded.data(), encoded.size(), lease);
}

} // namespace scpefe::document
