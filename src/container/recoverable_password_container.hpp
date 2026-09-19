#pragma once

#include "container/unlocked_container_data.hpp"
#include "format/revision_limits.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace scpefe::container {

/* Creates and unlocks version-2 containers with owner and optional recovery slots. */
class RecoverablePasswordContainer {
public:
    /* Reports whether the bytes carry the version-2 container magic. */
    static bool recognizes(const std::uint8_t *container, std::size_t size);

    /* Returns the encoded size for a snapshot and selected slot count. */
    static std::size_t encoded_size(std::size_t snapshot_size, bool has_recovery);

    /* Creates a container using a caller-generated owner slot identifier. */
    static std::vector<std::uint8_t> create(
        const std::uint8_t *owner_password,
        std::size_t owner_password_size,
        const std::uint8_t *recovery_password,
        std::size_t recovery_password_size,
        const std::array<std::uint8_t, 16> &owner_slot_id,
        const std::uint8_t *encoded_snapshot_revision,
        std::size_t encoded_snapshot_revision_size
    );

    /* Authenticates either slot and returns the validated encrypted snapshot. */
    static UnlockedContainerData unlock(
        const std::uint8_t *container,
        std::size_t container_size,
        const std::uint8_t *password,
        std::size_t password_size,
        const format::RevisionLimits &limits
    );

    /* Re-encrypts a new head while preserving the document and password slots. */
    static std::vector<std::uint8_t> replace_snapshot(
        const std::uint8_t *container,
        std::size_t container_size,
        const std::uint8_t *password,
        std::size_t password_size,
        const std::uint8_t *encoded_snapshot_revision,
        std::size_t encoded_snapshot_revision_size
    );
};

} // namespace scpefe::container
