#include "core/password_service.hpp"

namespace scpefe::core {

PasswordService::PasswordService(const EncryptionService &encryption)
    : encryption_(encryption) {}

security::PasswordPolicyAssessment PasswordService::assess(
    const std::uint8_t *password, std::size_t size) const
{
    return security::assess_password_policy(password, size);
}

std::array<std::uint8_t, 16> PasswordService::new_slot_salt() const
{
    std::array<std::uint8_t, 16> salt{};
    encryption_.random_bytes(salt.data(), salt.size());
    return salt;
}

} // namespace scpefe::core
