#pragma once

#include "container/unlocked_container_data.hpp"
#include "format/revision_limits.hpp"

#include <cstddef>
#include <cstdint>
#include <string_view>
#include <vector>

namespace scpefe::core { /* Supplies encryption for new baselines. */ class EncryptionService; }

namespace scpefe::container {

/* Authenticates and rewrites revised-v3 envelopes and their slot wrappers. */
class RevisedV3Container {
public:
    /* Maximum encrypted image accepted before authentication. */
    static constexpr std::size_t max_container_bytes() { return 33u * 1024u * 1024u; }
    /* Creates an encrypted baseline with immutable content type and owner access. */
    static std::vector<std::uint8_t> create(std::string_view profile_name,
        std::string_view profile_email, std::string_view device_name,
        std::string_view content, std::uint8_t content_type,
        std::uint64_t timestamp_ms,
        const std::uint8_t *owner_password, std::size_t owner_password_size,
        const std::uint8_t *recovery_password, std::size_t recovery_password_size,
        const core::EncryptionService &encryption);
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
    /* Rewrites semantic slots and an optional wrapper while preserving unknown passwords. */
    static std::vector<std::uint8_t> replace_slots(const std::uint8_t *bytes,
        std::size_t size, const std::uint8_t *actor_password,
        std::size_t actor_password_size, const std::uint8_t *graph,
        std::size_t graph_size, unsigned mode, std::size_t index,
        const std::uint8_t *new_password, std::size_t new_password_size,
        const std::array<std::uint8_t, 16> &new_slot_id,
        std::uint8_t permissions, bool must_change);
};

} // namespace scpefe::container
