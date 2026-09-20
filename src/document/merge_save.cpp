#include "document/merge_save.hpp"

#include "container/container_error.hpp"
#include "container/recoverable_password_container.hpp"
#include "format/revision_limits.hpp"
#include "format/snapshot_revision.hpp"
#include "format/snapshot_revision_data.hpp"

#include <algorithm>
#include <array>
#include <cstring>
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

using GraphNode = format::RevisionGraphNodeData;
using Graph = std::unordered_map<std::string, GraphNode>;

void hash_bytes(
    std::array<std::uint8_t, format::content_hash_size> &output,
    const std::uint8_t *input,
    std::size_t input_size
)
{
    if (crypto_generichash(output.data(), output.size(), input, input_size,
        nullptr, 0) != 0) {
        throw container::ContainerFailure{container::ContainerError::crypto_error};
    }
}

std::string revision_key(const std::uint8_t *revision)
{
    return {reinterpret_cast<const char *>(revision), format::revision_id_size};
}

void add_node(Graph &graph, GraphNode node)
{
    const std::string key = revision_key(node.revision_id.data());
    const auto found = graph.find(key);
    if (found != graph.end()) {
        if (found->second.parent_revision_ids != node.parent_revision_ids) {
            throw container::ContainerFailure{
                container::ContainerError::authentication_failed};
        }
        return;
    }
    graph.emplace(key, std::move(node));
}

void add_branch(
    Graph &graph,
    const format::SnapshotRevision &revision,
    const std::array<std::uint8_t, format::revision_id_size> &head
)
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
             offset += format::revision_id_size) {
            pending.push_back(revision_key(parents.data() + offset));
        }
    }
    return visited;
}

} // namespace

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
    std::uint64_t timestamp_ms
)
{
    if (sodium_init() < 0)
        throw container::ContainerFailure{container::ContainerError::crypto_error};
    const auto limits = format::RevisionLimits::defaults();
    const auto current = container::RecoverablePasswordContainer::unlock(
        current_container, current_container_size, password, password_size, limits);
    const auto local = container::RecoverablePasswordContainer::unlock(
        local_container, local_container_size, password, password_size, limits);
    if (current.document_id != local.document_id
        || current.work_journal_key != local.work_journal_key
        || current.must_be_changed
        || (current.permissions & 1u) == 0) {
        throw container::ContainerFailure{container::ContainerError::invalid_argument};
    }

    std::array<std::uint8_t, format::revision_id_size> current_head{};
    std::array<std::uint8_t, format::revision_id_size> local_head{};
    std::array<std::uint8_t, format::content_hash_size> content_hash{};
    hash_bytes(current_head, current.encoded_snapshot_revision.data(),
        current.encoded_snapshot_revision.size());
    hash_bytes(local_head, local.encoded_snapshot_revision.data(),
        local.encoded_snapshot_revision.size());
    if (current_head == local_head) {
        throw container::ContainerFailure{container::ContainerError::invalid_argument};
    }
    const auto current_revision = format::SnapshotRevision::decode(
        current.encoded_snapshot_revision.data(),
        current.encoded_snapshot_revision.size(), limits);
    const auto local_revision = format::SnapshotRevision::decode(
        local.encoded_snapshot_revision.data(),
        local.encoded_snapshot_revision.size(), limits);

    Graph graph;
    add_branch(graph, current_revision, current_head);
    add_branch(graph, local_revision, local_head);
    const auto current_ancestors = ancestors(graph, revision_key(current_head.data()));
    const auto local_ancestors = ancestors(graph, revision_key(local_head.data()));
    if (current_ancestors.contains(revision_key(local_head.data()))
        || local_ancestors.contains(revision_key(current_head.data()))) {
        throw container::ContainerFailure{container::ContainerError::invalid_argument};
    }
    const bool related = std::any_of(current_ancestors.begin(), current_ancestors.end(),
        [&](const auto &id) { return local_ancestors.contains(id); });
    if (!related) {
        throw container::ContainerFailure{container::ContainerError::invalid_argument};
    }
    hash_bytes(content_hash,
        reinterpret_cast<const std::uint8_t *>(content.data()), content.size());

    format::SnapshotRevisionData data;
    data.parent_revision_ids.insert(data.parent_revision_ids.end(),
        local_head.begin(), local_head.end());
    data.parent_revision_ids.insert(data.parent_revision_ids.end(),
        current_head.begin(), current_head.end());
    data.ancestor_graph.reserve(graph.size());
    std::vector<std::string> revision_ids;
    revision_ids.reserve(graph.size());
    for (const auto &entry : graph) revision_ids.push_back(entry.first);
    std::sort(revision_ids.begin(), revision_ids.end());
    for (const auto &id : revision_ids) {
        data.ancestor_graph.push_back(std::move(graph.at(id)));
    }
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
    data.content_hash.assign(content_hash.begin(), content_hash.end());
    data.content.assign(content);
    const auto encoded = format::SnapshotRevision::create(
        std::move(data), limits).encode();
    return container::RecoverablePasswordContainer::replace_snapshot(
        current_container, current_container_size, password, password_size,
        encoded.data(), encoded.size());
}

} // namespace scpefe::document
