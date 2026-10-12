#include "core/password_service.hpp"
#include "container/revised_v3_container.hpp"
#include "container/container_error.hpp"
#include "format/revision_limits.hpp"

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

void PasswordService::require_unused(const std::uint8_t *container,
    std::size_t size, const std::uint8_t *password,
    std::size_t password_size) const
{
    try {
        (void)container::RevisedV3Container::unlock(container, size,
            password, password_size, format::RevisionLimits::defaults());
    } catch (const container::ContainerFailure &failure) {
        if (failure.error == container::ContainerError::authentication_failed)
            return;
        throw;
    }
    throw container::ContainerFailure{
        container::ContainerError::password_already_in_use};
}

} // namespace scpefe::core
