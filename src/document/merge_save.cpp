#include "document/merge_save.hpp"

#include "container/container_error.hpp"
#include "container/revised_v3_container.hpp"
#include "format/revision_limits.hpp"

#include <algorithm>

namespace scpefe::document {

std::vector<std::uint8_t> MergeSave::create_revised(
    const std::uint8_t *target_container, std::size_t target_size,
    const std::uint8_t *local_container, std::size_t local_size,
    const std::uint8_t *target_password, std::size_t target_password_size,
    const std::uint8_t *local_password, std::size_t local_password_size,
    std::string_view profile_name, std::string_view profile_email,
    std::string_view device_name, std::string_view content,
    std::uint64_t timestamp_ms)
{
    const auto limits = format::RevisionLimits::defaults();
    auto target = container::RevisedV3Container::unlock(target_container,
        target_size, target_password, target_password_size, limits);
    auto local = container::RevisedV3Container::unlock(local_container,
        local_size, local_password, local_password_size, limits);
    if (target.document_id != local.document_id
        || target.work_journal_key != local.work_journal_key
        || target.content_type != local.content_type)
        throw format::MergeFailure{format::MergeProblem::unrelated_target};
    if (target.slot_id != local.slot_id)
        throw format::MergeFailure{format::MergeProblem::revoked_access};
    if (target.must_be_changed || (target.permissions & 1u) == 0)
        throw format::MergeFailure{format::MergeProblem::permission_denied};
    const auto &target_graph = *target.revision_graph;
    const auto &local_graph = *local.revision_graph;
    const auto actor = std::find_if(target_graph.slots().begin(),
        target_graph.slots().end(), [&](const auto &slot) {
            return slot.id == target.slot_id;
        });
    if (actor == target_graph.slots().end())
        throw container::ContainerFailure{container::ContainerError::malformed_container};
    const auto graph = local_graph.merge_with(target_graph, content,
        profile_name, profile_email, device_name, *actor, timestamp_ms);
    return container::RevisedV3Container::replace_graph(target_container,
        target_size, target_password, target_password_size,
        graph.data(), graph.size());
}

} // namespace scpefe::document
