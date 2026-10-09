#pragma once

#include <cstddef>
#include <cstdint>
#include <string_view>
#include <vector>

namespace scpefe::document {

/* Authenticates merge inputs and replaces the current container with a resolved head. */
class MergeSave {
public:
    /* Authorizes the merge, delegates its lineage, and returns a replacement container. */
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
