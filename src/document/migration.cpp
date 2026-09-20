#include "document/migration.hpp"

#include "container/container_error.hpp"
#include "container/recoverable_password_container.hpp"
#include "format/revision_limits.hpp"
#include "format/snapshot_revision.hpp"
#include "format/snapshot_revision_data.hpp"

#include <array>
#include <utility>

extern "C" int crypto_generichash(unsigned char *, std::size_t,
    const unsigned char *, unsigned long long, const unsigned char *, std::size_t);

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
    const auto current = format::SnapshotRevision::decode(
        unlocked.encoded_snapshot_revision.data(),
        unlocked.encoded_snapshot_revision.size(), limits);
    std::array<std::uint8_t, format::revision_id_size> parent{};
    if (crypto_generichash(parent.data(), parent.size(),
        unlocked.encoded_snapshot_revision.data(),
        unlocked.encoded_snapshot_revision.size(), nullptr, 0) != 0)
        throw container::ContainerFailure{container::ContainerError::crypto_error};
    format::SnapshotRevisionData data;
    data.parent_revision_ids.assign(parent.begin(), parent.end());
    data.ancestor_graph = current.data().ancestor_graph;
    format::RevisionGraphNodeData parent_node;
    parent_node.revision_id = parent;
    parent_node.parent_revision_ids = current.data().parent_revision_ids;
    data.ancestor_graph.push_back(std::move(parent_node));
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
    const auto encoded = format::SnapshotRevision::create(
        std::move(data), limits).encode();
    return container::RecoverablePasswordContainer::migrate(
        container_bytes, container_size, password, password_size,
        encoded.data(), encoded.size(), lease);
}

} // namespace scpefe::document
