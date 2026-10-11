#pragma once

#include <cstddef>
#include <cstdint>
#include "container/unlocked_container_data.hpp"
#include "format/revision_limits.hpp"

namespace scpefe::core {

/* Screens revised-v3 framing and adapts the transitional 160-byte-header reader. */
class PersistenceService {
public:
    /* Permits bounded parsing substitution in context tests. */
    virtual ~PersistenceService() = default;
    /* Checks exact envelope framing under the caller's byte limit. */
    virtual bool has_valid_v3_framing(const std::uint8_t *bytes,
        std::size_t size, std::size_t max_bytes) const;
    /* Validates the transitional byte ABI envelope before Open, without a password. */
    virtual void validate_legacy_envelope(const std::uint8_t *bytes,
        std::size_t size) const;
    /* Authenticates the current byte ABI envelope and decodes its snapshot. */
    virtual container::UnlockedContainerData unlock_legacy_envelope(
        const std::uint8_t *bytes, std::size_t size,
        const std::uint8_t *password, std::size_t password_size,
        const format::RevisionLimits &limits) const;
};

} // namespace scpefe::core
