#pragma once

#include <cstddef>
#include <cstdint>
#include <string_view>
#include <vector>

namespace scpefe::document {

/* Seals an edited child or a content-preserving identity reconciliation. */
class ManualSave {
public:
    /* Publishes an attributed child built by the shared revision transition. */
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
};

} // namespace scpefe::document
