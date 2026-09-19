#pragma once

#include "container/unlocked_container_data.hpp"
#include "format/revision_limits.hpp"

#include <cstddef>
#include <cstdint>
#include <vector>

namespace scpefe::container {

/* Creates and unlocks the version-1 single-owner password container. */
class PasswordContainer {
public:
    /* Returns the encoded size required for a snapshot of the supplied size. */
    static std::size_t encoded_size(std::size_t snapshot_size);

    /* Creates a container using fresh document, slot, key, salt, and nonce values. */
    static std::vector<std::uint8_t> create(
        const std::uint8_t *password,
        std::size_t password_size,
        const std::uint8_t *encoded_snapshot_revision,
        std::size_t encoded_snapshot_revision_size
    );

    /* Authenticates the owner slot under the supplied structural limits. */
    static UnlockedContainerData unlock(
        const std::uint8_t *container,
        std::size_t container_size,
        const std::uint8_t *password,
        std::size_t password_size,
        const format::RevisionLimits &limits
    );
};

} // namespace scpefe::container
