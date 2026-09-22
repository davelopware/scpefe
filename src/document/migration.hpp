#pragma once

#include "container/unlocked_container_data.hpp"

#include <cstddef>
#include <cstdint>
#include <string_view>
#include <vector>

namespace scpefe::document {

/* Builds a latest-format container and records a non-text migration revision. */
class Migration {
public:
    /* Migrates one supported older container while acquiring the supplied lease. */
    static std::vector<std::uint8_t> create(
        const std::uint8_t *container, std::size_t container_size,
        const std::uint8_t *password, std::size_t password_size,
        std::string_view profile_name, std::string_view profile_email,
        std::string_view device_name, std::uint64_t timestamp_ms,
        const container::EditingLeaseData &lease);
};

} // namespace scpefe::document
