#pragma once

#include <cstddef>
#include <cstdint>
#include <string_view>
#include <vector>

namespace scpefe::document {

/* Creates, amends, and discards the single provisional revision in a container. */
class ProvisionalSave {
public:
    /* Creates or amends a provisional revision from the latest working copy. */
    static std::vector<std::uint8_t> create(
        const std::uint8_t *container,
        std::size_t container_size,
        const std::uint8_t *password,
        std::size_t password_size,
        std::string_view profile_name,
        std::string_view profile_email,
        std::string_view device_name,
        std::string_view content,
        std::uint64_t timestamp_ms
    );

    /* Replaces a provisional head with its authenticated sealed base revision. */
    static std::vector<std::uint8_t> discard(
        const std::uint8_t *container,
        std::size_t container_size,
        const std::uint8_t *password,
        std::size_t password_size
    );
};

} // namespace scpefe::document
