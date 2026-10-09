#pragma once

#include <cstddef>
#include <cstdint>
#include <string_view>
#include <vector>

namespace scpefe::document {

/* Creates, amends, and discards the single provisional revision in a container. */
class ProvisionalSave {
public:
    /* Publishes a provisional revision built by the shared transition. */
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

    /* Publishes the validated sealed base of a provisional head. */
    static std::vector<std::uint8_t> discard(
        const std::uint8_t *container,
        std::size_t container_size,
        const std::uint8_t *password,
        std::size_t password_size
    );
};

} // namespace scpefe::document
