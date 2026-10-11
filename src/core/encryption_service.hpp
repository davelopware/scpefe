#pragma once

#include <cstddef>
#include <cstdint>

namespace scpefe::core {

/* Supplies cryptographically secure random bytes to document components. */
class EncryptionService {
public:
    /* Permits deterministic cryptography substitution in context tests. */
    virtual ~EncryptionService() = default;
    /* Fills a caller-owned buffer with fresh random bytes. */
    virtual void random_bytes(std::uint8_t *out, std::size_t size) const;
};

} // namespace scpefe::core
