#pragma once

#include <cstddef>
#include <cstdint>
#include <string_view>
#include <vector>

namespace scpefe::document {

/* Builds a validated initial revision and its self-contained encrypted container. */
class NewDocument {
public:
    /* Returns the container size without deriving password keys or random data. */
    static std::size_t encoded_size(
        std::string_view profile_name,
        std::string_view profile_email,
        std::string_view device_name,
        std::string_view content,
        std::uint64_t timestamp_ms,
        bool has_recovery
    );

    /* Creates an owner document with an optional independent recovery password. */
    static std::vector<std::uint8_t> create(
        std::string_view profile_name,
        std::string_view profile_email,
        std::string_view device_name,
        std::string_view content,
        std::uint64_t timestamp_ms,
        const std::uint8_t *owner_password,
        std::size_t owner_password_size,
        const std::uint8_t *recovery_password,
        std::size_t recovery_password_size
    );
};

} // namespace scpefe::document
