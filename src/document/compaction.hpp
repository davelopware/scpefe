#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace scpefe::document {

/* Rewrites a sealed document head as a shallow continuity baseline. */
class Compaction {
public:
    /* Creates a compacted container after validating administrator and lease state. */
    static std::vector<std::uint8_t> create(
        const std::uint8_t *container,
        std::size_t container_size,
        const std::uint8_t *password,
        std::size_t password_size,
        const std::array<std::uint8_t, 16> &lease_session_id,
        std::uint64_t lease_heartbeat_counter
    );
};

} // namespace scpefe::document
