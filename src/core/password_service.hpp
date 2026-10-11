#pragma once

#include "security/password_strength.hpp"
#include "core/encryption_service.hpp"

#include <array>
#include <cstddef>
#include <cstdint>

namespace scpefe::core {

/* Provides password-policy decisions and salt creation within one context. */
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

private:
    const EncryptionService &encryption_;
};

} // namespace scpefe::core
