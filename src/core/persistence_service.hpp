#pragma once

#include <cstddef>
#include <cstdint>

namespace scpefe::core {

/* Screens revised-v3 envelope framing before any password work. */
class PersistenceService {
public:
    /* Permits bounded parsing substitution in context tests. */
    virtual ~PersistenceService() = default;
    /* Checks exact envelope framing under the caller's byte limit. */
    virtual bool has_valid_v3_framing(const std::uint8_t *bytes,
        std::size_t size, std::size_t max_bytes) const;
};

} // namespace scpefe::core
