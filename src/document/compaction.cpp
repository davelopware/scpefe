#include "document/compaction.hpp"

#include "container/container_error.hpp"
#include "container/recoverable_password_container.hpp"
#include "format/revision_limits.hpp"
#include "format/snapshot_revision.hpp"
#include "format/snapshot_revision_data.hpp"

#include <algorithm>
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

std::vector<std::uint8_t> Compaction::create(
    const std::uint8_t *container_bytes,
    std::size_t container_size,
    const std::uint8_t *password,
    std::size_t password_size,
    const std::array<std::uint8_t, 16> &lease_session_id,
    std::uint64_t lease_heartbeat_counter
)
{
    if (sodium_init() < 0)
        throw container::ContainerFailure{container::ContainerError::crypto_error};
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

    const auto current = format::SnapshotRevision::decode(
        unlocked.encoded_snapshot_revision.data(),
        unlocked.encoded_snapshot_revision.size(), limits);
    if (!current.data().manually_sealed) {
        throw container::ContainerFailure{container::ContainerError::invalid_argument};
    }

    std::array<std::uint8_t, format::revision_id_size> previous_head{};
    if (crypto_generichash(previous_head.data(), previous_head.size(),
        unlocked.encoded_snapshot_revision.data(),
        unlocked.encoded_snapshot_revision.size(), nullptr, 0) != 0) {
        throw container::ContainerFailure{container::ContainerError::crypto_error};
    }

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
    const auto encoded = format::SnapshotRevision::create(
        std::move(baseline), limits).encode();
    return container::RecoverablePasswordContainer::replace_snapshot(
        container_bytes, container_size, password, password_size,
        encoded.data(), encoded.size());
}

} // namespace scpefe::document
