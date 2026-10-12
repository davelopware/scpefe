#pragma once

#include "container/unlocked_container_data.hpp"
#include "format/revision_limits.hpp"

#include <cstddef>
#include <cstdint>
#include <vector>

namespace scpefe::container {

/* Authenticates the revised 72-byte-header v3 envelope and its revision graph. */
class RevisedV3Container {
public:
    /* Recognizes the revised envelope layout without deriving a password. */
    static bool recognizes(const std::uint8_t *bytes, std::size_t size);
    /* Validates bounded public framing before any KDF or allocation. */
    static void validate_structure(const std::uint8_t *bytes, std::size_t size);
    /* Authenticates one slot and the full payload before exposing semantic history. */
    static UnlockedContainerData unlock(const std::uint8_t *bytes, std::size_t size,
        const std::uint8_t *password, std::size_t password_size,
        const format::RevisionLimits &limits);
    /* Reencrypts one validated graph with the authenticated document key and fresh nonce. */
    static std::vector<std::uint8_t> replace_graph(const std::uint8_t *bytes,
        std::size_t size, const std::uint8_t *password, std::size_t password_size,
        const std::uint8_t *graph, std::size_t graph_size);
};

} // namespace scpefe::container
