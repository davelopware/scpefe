#pragma once

#include "security/password_strength.hpp"
#include "core/encryption_service.hpp"

#include <array>
#include <cstddef>
#include <cstdint>

namespace scpefe::core {

/* Assesses proposed passwords, checks slot reuse, and creates fresh salts. */
class PasswordService {
public:
    /* Injects only the cryptographic randomness used for new slot salts. */
    explicit PasswordService(const EncryptionService &encryption);
    /* Permits deterministic service substitution in context tests. */
    virtual ~PasswordService() = default;
    /* Assesses a newly proposed password without retaining it. */
    virtual security::PasswordPolicyAssessment assess(
        const std::uint8_t *password, std::size_t size) const;
    /* Generates a fresh Argon2id salt for one password slot. */
    virtual std::array<std::uint8_t, 16> new_slot_salt() const;
    /* Rejects a credential accepted by any existing authenticated slot wrapper. */
    virtual void require_unused(const std::uint8_t *container, std::size_t size,
        const std::uint8_t *password, std::size_t password_size) const;

private:
    const EncryptionService &encryption_;
};

} // namespace scpefe::core
