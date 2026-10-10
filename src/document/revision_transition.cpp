#include "document/revision_transition.hpp"

#include "container/container_error.hpp"
#include "format/revision_limits.hpp"
#include "format/snapshot_revision.hpp"
#include "format/snapshot_revision_data.hpp"

#include <algorithm>
#include <array>
#include <string>
#include <unordered_map>
#include <unordered_set>
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

using GraphNode = format::RevisionGraphNodeData;
using Graph = std::unordered_map<std::string, GraphNode>;

std::string revision_key(const std::uint8_t *revision)
{
    return {reinterpret_cast<const char *>(revision), format::revision_id_size};
}

void add_node(Graph &graph, GraphNode node)
{
    const std::string key = revision_key(node.revision_id.data());
    const auto found = graph.find(key);
    if (found != graph.end()) {
        if (found->second.parent_revision_ids != node.parent_revision_ids)
            throw container::ContainerFailure{container::ContainerError::authentication_failed};
        return;
    }
    graph.emplace(key, std::move(node));
}

void add_branch(Graph &graph, const format::SnapshotRevision &revision,
    const std::array<std::uint8_t, format::revision_id_size> &head)
{
    for (const auto &node : revision.data().ancestor_graph) add_node(graph, node);
    GraphNode head_node;
    head_node.revision_id = head;
    head_node.parent_revision_ids = revision.data().parent_revision_ids;
    add_node(graph, std::move(head_node));
}

std::unordered_set<std::string> ancestors(const Graph &graph, const std::string &head)
{
    std::unordered_set<std::string> visited;
    std::vector<std::string> pending{head};
    while (!pending.empty()) {
        std::string current = std::move(pending.back());
        pending.pop_back();
        if (!visited.insert(current).second) continue;
        const auto found = graph.find(current);
        if (found == graph.end()) continue;
        const auto &parents = found->second.parent_revision_ids;
        for (std::size_t offset = 0; offset < parents.size();
             offset += format::revision_id_size)
            pending.push_back(revision_key(parents.data() + offset));
    }
    return visited;
}

void append_merge_lineage(format::SnapshotRevisionData &data,
    const format::SnapshotRevision &current_revision,
    const format::SnapshotRevision &local_revision,
    const std::array<std::uint8_t, format::revision_id_size> &current_head,
    const std::array<std::uint8_t, format::revision_id_size> &local_head)
{
    if (current_head == local_head)
        throw container::ContainerFailure{container::ContainerError::invalid_argument};

    Graph graph;
    add_branch(graph, current_revision, current_head);
    add_branch(graph, local_revision, local_head);
    const auto current_ancestors = ancestors(graph, revision_key(current_head.data()));
    const auto local_ancestors = ancestors(graph, revision_key(local_head.data()));
    if (current_ancestors.contains(revision_key(local_head.data()))
        || local_ancestors.contains(revision_key(current_head.data())))
        throw container::ContainerFailure{container::ContainerError::invalid_argument};
    const bool related = std::any_of(current_ancestors.begin(), current_ancestors.end(),
        [&](const auto &id) { return local_ancestors.contains(id); });
    if (!related)
        throw container::ContainerFailure{container::ContainerError::invalid_argument};

    data.parent_revision_ids.insert(data.parent_revision_ids.end(),
        local_head.begin(), local_head.end());
    data.parent_revision_ids.insert(data.parent_revision_ids.end(),
        current_head.begin(), current_head.end());
    data.ancestor_graph.reserve(graph.size());
    std::vector<std::string> revision_ids;
    revision_ids.reserve(graph.size());
    for (const auto &entry : graph) revision_ids.push_back(entry.first);
    std::sort(revision_ids.begin(), revision_ids.end());
    for (const auto &id : revision_ids)
        data.ancestor_graph.push_back(std::move(graph.at(id)));
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

std::vector<std::uint8_t> RevisionTransition::merge(
    const container::UnlockedContainerData &current,
    const container::UnlockedContainerData &local,
    std::string_view profile_name,
    std::string_view profile_email,
    std::string_view device_name,
    std::string_view content,
    std::uint64_t timestamp_ms)
{
    if (sodium_init() < 0)
        throw container::ContainerFailure{container::ContainerError::crypto_error};
    const auto current_head = hash_bytes(current.encoded_snapshot_revision.data(),
        current.encoded_snapshot_revision.size());
    const auto local_head = hash_bytes(local.encoded_snapshot_revision.data(),
        local.encoded_snapshot_revision.size());
    const auto current_revision = decode(current.encoded_snapshot_revision);
    const auto local_revision = decode(local.encoded_snapshot_revision);

    format::SnapshotRevisionData data;
    append_merge_lineage(data, current_revision, local_revision,
        current_head, local_head);
    data.timestamp_ms = timestamp_ms;
    data.slot_id.assign(current.slot_id.begin(), current.slot_id.end());
    if (!current.recovery_slot) {
        data.slot_identity_name = current.slot_identity_name.empty()
            ? std::string(profile_name) : current.slot_identity_name;
        data.slot_identity_email = current.slot_identity_email.empty()
            ? std::string(profile_email) : current.slot_identity_email;
    }
    data.client_profile_name.assign(profile_name);
    data.client_profile_email.assign(profile_email);
    data.device_name.assign(device_name);
    const auto content_hash = hash_bytes(
        reinterpret_cast<const std::uint8_t *>(content.data()), content.size());
    data.content_hash.assign(content_hash.begin(), content_hash.end());
    data.content.assign(content);
    return format::SnapshotRevision::create(std::move(data),
        format::RevisionLimits::defaults()).encode();
}

std::vector<std::uint8_t> RevisionTransition::migration(
    const container::UnlockedContainerData &unlocked,
    std::string_view profile_name,
    std::string_view profile_email,
    std::string_view device_name,
    std::uint64_t timestamp_ms)
{
    if (sodium_init() < 0)
        throw container::ContainerFailure{container::ContainerError::crypto_error};
    const auto current = decode(unlocked.encoded_snapshot_revision);
    format::SnapshotRevisionData data;
    append_parent(data, current.data(), unlocked.encoded_snapshot_revision);
    data.manually_sealed = true;
    data.timestamp_ms = timestamp_ms;
    data.slot_id.assign(unlocked.slot_id.begin(), unlocked.slot_id.end());
    if (!unlocked.recovery_slot) {
        data.slot_identity_name = unlocked.slot_identity_name;
        data.slot_identity_email = unlocked.slot_identity_email;
    }
    data.client_profile_name.assign(profile_name);
    data.client_profile_email.assign(profile_email);
    data.device_name.assign(device_name);
    data.content_hash = current.data().content_hash;
    data.content = current.data().content;
    data.event_type = "format-migration";
    data.event_detail = "container-version-2-to-3";
    return format::SnapshotRevision::create(std::move(data),
        format::RevisionLimits::defaults()).encode();
}

std::vector<std::uint8_t> RevisionTransition::compact(
    const container::UnlockedContainerData &unlocked)
{
    if (sodium_init() < 0)
        throw container::ContainerFailure{container::ContainerError::crypto_error};
    const auto current = decode(unlocked.encoded_snapshot_revision);
    if (!current.data().manually_sealed)
        throw container::ContainerFailure{container::ContainerError::invalid_argument};

    const auto previous_head = hash_bytes(unlocked.encoded_snapshot_revision.data(),
        unlocked.encoded_snapshot_revision.size());
    format::SnapshotRevisionData baseline;
    baseline.parent_revision_ids.assign(previous_head.begin(), previous_head.end());
    baseline.timestamp_ms = current.data().timestamp_ms;
    baseline.slot_id = current.data().slot_id;
    baseline.slot_identity_name = current.data().slot_identity_name;
    baseline.slot_identity_email = current.data().slot_identity_email;
    baseline.client_profile_name = current.data().client_profile_name;
    baseline.client_profile_email = current.data().client_profile_email;
    baseline.device_name = current.data().device_name;
    baseline.content_hash = current.data().content_hash;
    baseline.content = current.data().content;
    baseline.manually_sealed = true;
    return format::SnapshotRevision::create(std::move(baseline),
        format::RevisionLimits::defaults()).encode();
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
