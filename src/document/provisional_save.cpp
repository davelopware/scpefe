#include "document/provisional_save.hpp"

#include "container/recoverable_password_container.hpp"
#include "document/revision_transition.hpp"
#include "format/revision_limits.hpp"

namespace scpefe::document {

std::vector<std::uint8_t> ProvisionalSave::create(
    const std::uint8_t *container_bytes, std::size_t container_size,
    const std::uint8_t *password, std::size_t password_size,
    std::string_view profile_name, std::string_view profile_email,
    std::string_view device_name, std::string_view content,
    std::uint64_t timestamp_ms)
{
    const auto unlocked = container::RecoverablePasswordContainer::unlock(
        container_bytes, container_size, password, password_size,
        format::RevisionLimits::defaults());
    const auto result = RevisionTransition::save(unlocked, SaveKind::regular,
        profile_name, profile_email, device_name, content, timestamp_ms);
    return container::RecoverablePasswordContainer::replace_snapshot(
        container_bytes, container_size, password, password_size,
        result.encoded_revision.data(), result.encoded_revision.size());
}

std::vector<std::uint8_t> ProvisionalSave::discard(
    const std::uint8_t *container_bytes, std::size_t container_size,
    const std::uint8_t *password, std::size_t password_size)
{
    const auto unlocked = container::RecoverablePasswordContainer::unlock(
        container_bytes, container_size, password, password_size,
        format::RevisionLimits::defaults());
    const auto base = RevisionTransition::discard(unlocked);
    return container::RecoverablePasswordContainer::replace_snapshot(
        container_bytes, container_size, password, password_size,
        base.data(), base.size());
}

} // namespace scpefe::document
