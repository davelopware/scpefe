#include "document/provisional_save.hpp"

#include "container/container_error.hpp"
#include "container/recoverable_password_container.hpp"
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

void hash_bytes(std::array<std::uint8_t, format::revision_id_size> &output,
    const std::uint8_t *input, std::size_t input_size)
{
    if (crypto_generichash(output.data(), output.size(), input, input_size,
        nullptr, 0) != 0) {
        throw container::ContainerFailure{container::ContainerError::crypto_error};
    }
}

} // namespace

std::vector<std::uint8_t> ProvisionalSave::create(
    const std::uint8_t *container_bytes, std::size_t container_size,
    const std::uint8_t *password, std::size_t password_size,
    std::string_view profile_name, std::string_view profile_email,
    std::string_view device_name, std::string_view content,
    std::uint64_t timestamp_ms)
{
    if (sodium_init() < 0)
        throw container::ContainerFailure{container::ContainerError::crypto_error};
    const auto limits = format::RevisionLimits::defaults();
    const auto unlocked = container::RecoverablePasswordContainer::unlock(
        container_bytes, container_size, password, password_size, limits);
    if (unlocked.must_be_changed || (unlocked.permissions & 1u) == 0)
        throw container::ContainerFailure{container::ContainerError::invalid_argument};

    const auto current = format::SnapshotRevision::decode(
        unlocked.encoded_snapshot_revision.data(),
        unlocked.encoded_snapshot_revision.size(), limits);
    std::array<std::uint8_t, format::revision_id_size> current_id{};
    std::array<std::uint8_t, format::content_hash_size> content_hash{};
    hash_bytes(content_hash, reinterpret_cast<const std::uint8_t *>(content.data()),
        content.size());

    format::SnapshotRevisionData data;
    if (current.data().manually_sealed) {
        hash_bytes(current_id, unlocked.encoded_snapshot_revision.data(),
            unlocked.encoded_snapshot_revision.size());
        data.parent_revision_ids.assign(current_id.begin(), current_id.end());
        data.ancestor_graph = current.data().ancestor_graph;
        format::RevisionGraphNodeData parent;
        parent.revision_id = current_id;
        parent.parent_revision_ids = current.data().parent_revision_ids;
        data.ancestor_graph.push_back(std::move(parent));
        data.provisional_base_revision = unlocked.encoded_snapshot_revision;
    } else {
        data.parent_revision_ids = current.data().parent_revision_ids;
        data.ancestor_graph = current.data().ancestor_graph;
        data.provisional_base_revision = current.data().provisional_base_revision;
    }
    data.manually_sealed = false;
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
    data.content_hash.assign(content_hash.begin(), content_hash.end());
    data.content.assign(content);
    const auto encoded = format::SnapshotRevision::create(
        std::move(data), limits).encode();
    return container::RecoverablePasswordContainer::replace_snapshot(
        container_bytes, container_size, password, password_size,
        encoded.data(), encoded.size());
}

std::vector<std::uint8_t> ProvisionalSave::discard(
    const std::uint8_t *container_bytes, std::size_t container_size,
    const std::uint8_t *password, std::size_t password_size)
{
    const auto limits = format::RevisionLimits::defaults();
    const auto unlocked = container::RecoverablePasswordContainer::unlock(
        container_bytes, container_size, password, password_size, limits);
    if (unlocked.must_be_changed || (unlocked.permissions & 1u) == 0)
        throw container::ContainerFailure{container::ContainerError::invalid_argument};
    const auto current = format::SnapshotRevision::decode(
        unlocked.encoded_snapshot_revision.data(),
        unlocked.encoded_snapshot_revision.size(), limits);
    if (current.data().manually_sealed
        || current.data().provisional_base_revision.empty()) {
        throw container::ContainerFailure{container::ContainerError::invalid_argument};
    }
    const auto &base = current.data().provisional_base_revision;
    return container::RecoverablePasswordContainer::replace_snapshot(
        container_bytes, container_size, password, password_size,
        base.data(), base.size());
}

} // namespace scpefe::document
