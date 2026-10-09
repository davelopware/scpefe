#include "document/revision_transition.hpp"

#include "container/container_error.hpp"
#include "format/revision_limits.hpp"
#include "format/snapshot_revision.hpp"
#include "format/snapshot_revision_data.hpp"

#include <array>
#include <utility>

extern "C" {
int sodium_init(void);
int crypto_generichash(
    unsigned char *, std::size_t, const unsigned char *, unsigned long long,
    const unsigned char *, std::size_t
);
}

namespace scpefe::document {
namespace {

std::array<std::uint8_t, format::revision_id_size> hash_bytes(
    const std::uint8_t *input, std::size_t size)
{
    std::array<std::uint8_t, format::revision_id_size> result{};
    if (crypto_generichash(result.data(), result.size(), input, size,
        nullptr, 0) != 0)
        throw container::ContainerFailure{container::ContainerError::crypto_error};
    return result;
}

format::SnapshotRevision decode(const std::vector<std::uint8_t> &encoded)
{
    return format::SnapshotRevision::decode(encoded.data(), encoded.size(),
        format::RevisionLimits::defaults());
}

void append_parent(format::SnapshotRevisionData &target,
    const format::SnapshotRevisionData &parent,
    const std::vector<std::uint8_t> &encoded_parent)
{
    const auto parent_id = hash_bytes(encoded_parent.data(), encoded_parent.size());
    target.parent_revision_ids.assign(parent_id.begin(), parent_id.end());
    target.ancestor_graph = parent.ancestor_graph;
    format::RevisionGraphNodeData node;
    node.revision_id = parent_id;
    node.parent_revision_ids = parent.parent_revision_ids;
    target.ancestor_graph.push_back(std::move(node));
}

bool same_graph(const std::vector<format::RevisionGraphNodeData> &left,
    const std::vector<format::RevisionGraphNodeData> &right)
{
    if (left.size() != right.size()) return false;
    for (std::size_t index = 0; index < left.size(); ++index) {
        if (left[index].revision_id != right[index].revision_id
            || left[index].parent_revision_ids != right[index].parent_revision_ids)
            return false;
    }
    return true;
}

format::SnapshotRevision sealed_base(
    const format::SnapshotRevision &current)
{
    const auto &current_data = current.data();
    if (current_data.manually_sealed
        || current_data.provisional_base_revision.empty())
        throw container::ContainerFailure{container::ContainerError::invalid_argument};
    auto base = decode(current_data.provisional_base_revision);
    format::SnapshotRevisionData expected;
    append_parent(expected, base.data(), current_data.provisional_base_revision);
    if (!base.data().manually_sealed
        || current_data.parent_revision_ids != expected.parent_revision_ids
        || !same_graph(current_data.ancestor_graph, expected.ancestor_graph))
        throw container::ContainerFailure{container::ContainerError::invalid_argument};
    return base;
}

} // namespace

SaveTransitionResult RevisionTransition::save(
    const container::UnlockedContainerData &unlocked,
    SaveKind kind,
    std::string_view profile_name,
    std::string_view profile_email,
    std::string_view device_name,
    std::string_view content,
    std::uint64_t timestamp_ms)
{
    if (sodium_init() < 0)
        throw container::ContainerFailure{container::ContainerError::crypto_error};
    const auto current = decode(unlocked.encoded_snapshot_revision);
    const bool identity_only = kind == SaveKind::manual
        && (unlocked.permissions & 1u) == 0
        && !unlocked.recovery_slot
        && current.data().manually_sealed
        && current.data().content == content
        && unlocked.slot_identity_name == profile_name
        && unlocked.slot_identity_email == profile_email;
    if (unlocked.must_be_changed
        || ((unlocked.permissions & 1u) == 0 && !identity_only))
        throw container::ContainerFailure{container::ContainerError::invalid_argument};

    format::SnapshotRevisionData data;
    if (current.data().manually_sealed) {
        append_parent(data, current.data(), unlocked.encoded_snapshot_revision);
        if (kind == SaveKind::regular)
            data.provisional_base_revision = unlocked.encoded_snapshot_revision;
    } else {
        // The provisional head is amendable. Its parent remains the sealed base.
        const auto base = sealed_base(current);
        append_parent(data, base.data(), current.data().provisional_base_revision);
        if (kind == SaveKind::regular)
            data.provisional_base_revision = current.data().provisional_base_revision;
    }
    data.manually_sealed = kind == SaveKind::manual;
    data.timestamp_ms = timestamp_ms;
    data.slot_id.assign(unlocked.slot_id.begin(), unlocked.slot_id.end());
    if (!unlocked.recovery_slot) {
        data.slot_identity_name = unlocked.slot_identity_name.empty()
            ? std::string(profile_name) : unlocked.slot_identity_name;
        data.slot_identity_email = unlocked.slot_identity_email.empty()
            ? std::string(profile_email) : unlocked.slot_identity_email;
    }
    data.client_profile_name.assign(profile_name);
    data.client_profile_email.assign(profile_email);
    data.device_name.assign(device_name);
    const auto content_hash = hash_bytes(
        reinterpret_cast<const std::uint8_t *>(content.data()), content.size());
    data.content_hash.assign(content_hash.begin(), content_hash.end());
    data.content.assign(content);
    return {format::SnapshotRevision::create(std::move(data),
        format::RevisionLimits::defaults()).encode(), identity_only};
}

std::vector<std::uint8_t> RevisionTransition::discard(
    const container::UnlockedContainerData &unlocked)
{
    if (unlocked.must_be_changed || (unlocked.permissions & 1u) == 0)
        throw container::ContainerFailure{container::ContainerError::invalid_argument};
    const auto current = decode(unlocked.encoded_snapshot_revision);
    sealed_base(current);
    return current.data().provisional_base_revision;
}

} // namespace scpefe::document
