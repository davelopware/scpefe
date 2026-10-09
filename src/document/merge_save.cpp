#include "document/merge_save.hpp"

#include "container/container_error.hpp"
#include "container/recoverable_password_container.hpp"
#include "document/revision_transition.hpp"
#include "format/revision_limits.hpp"

namespace scpefe::document {

std::vector<std::uint8_t> MergeSave::create(
    const std::uint8_t *current_container,
    std::size_t current_container_size,
    const std::uint8_t *local_container,
    std::size_t local_container_size,
    const std::uint8_t *password,
    std::size_t password_size,
    std::string_view profile_name,
    std::string_view profile_email,
    std::string_view device_name,
    std::string_view content,
    std::uint64_t timestamp_ms)
{
    const auto limits = format::RevisionLimits::defaults();
    const auto current = container::RecoverablePasswordContainer::unlock(
        current_container, current_container_size, password, password_size, limits);
    const auto local = container::RecoverablePasswordContainer::unlock(
        local_container, local_container_size, password, password_size, limits);
    if (current.document_id != local.document_id
        || current.work_journal_key != local.work_journal_key
        || current.must_be_changed
        || (current.permissions & 1u) == 0)
        throw container::ContainerFailure{container::ContainerError::invalid_argument};

    const auto encoded = RevisionTransition::merge(current, local,
        profile_name, profile_email, device_name, content, timestamp_ms);
    return container::RecoverablePasswordContainer::replace_snapshot(
        current_container, current_container_size, password, password_size,
        encoded.data(), encoded.size());
}

} // namespace scpefe::document
