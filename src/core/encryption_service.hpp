#pragma once

#include <cstddef>
#include <cstdint>
#include <array>
#include "format/snapshot_revision_data.hpp"

namespace scpefe::core {

/* Supplies random bytes and content hashing to document components. */
class EncryptionService {
public:
    /* Permits deterministic cryptography substitution in context tests. */
    virtual ~EncryptionService() = default;
    /* Fills a caller-owned buffer with fresh random bytes. */
    virtual void random_bytes(std::uint8_t *out, std::size_t size) const;
    /* Hashes submitted clear content for a revision's authenticated digest. */
    virtual std::array<std::uint8_t, format::content_hash_size> hash_content(
        const std::uint8_t *bytes, std::size_t size) const;
};

} // namespace scpefe::core
