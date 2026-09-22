#pragma once

#include <cstddef>
#include <cstdint>
#include <string_view>
#include <vector>

namespace scpefe::document {

/* Creates a user-resolved revision joining two authenticated branch heads. */
class MergeSave {
public:
    /* Creates a replacement current container with both branch heads as parents. */
    static std::vector<std::uint8_t> create(
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
    );
};

} // namespace scpefe::document
