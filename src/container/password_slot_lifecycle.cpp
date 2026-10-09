#include "container/password_slot_lifecycle.hpp"

#include "container/container_error.hpp"
#include "security/password_strength.hpp"

extern "C" {
void randombytes_buf(void *buffer, std::size_t size);
void sodium_memzero(void *buffer, std::size_t size);
}

namespace scpefe::container {
namespace {

constexpr std::size_t max_holder_field_size = 4096;
constexpr std::size_t max_invitations = 7;
constexpr std::uint8_t permission_mask = 7;

void require_strong_password(const std::uint8_t *password, std::size_t size)
{
    if (security::assess_password_policy(password, size)
        != security::PasswordPolicyAssessment::accepted)
        throw ContainerFailure{ContainerError::weak_password};
}

} // namespace

void PasswordSlotLifecycle::validate_add_request(const std::uint8_t *password,
    std::size_t password_size, std::uint8_t permissions,
    const std::string &temporary_label)
{
    require_strong_password(password, password_size);
    if ((permissions & ~permission_mask) != 0
        || ((permissions & 6u) != 0 && (permissions & 1u) == 0)
        || temporary_label.empty() || temporary_label.size() > max_holder_field_size)
        throw ContainerFailure{ContainerError::invalid_argument};
}

void PasswordSlotLifecycle::authorize_add(const UnlockedContainerData &creator,
    std::uint8_t permissions)
{
    if (creator.must_be_changed || (creator.permissions & 2u) == 0
        || (permissions & ~creator.permissions) != 0)
        throw ContainerFailure{ContainerError::invalid_argument};
}

void PasswordSlotLifecycle::require_available_password(
    const std::function<bool()> &matches_existing_slot)
{
    if (matches_existing_slot())
        throw ContainerFailure{ContainerError::password_already_in_use};
}

void PasswordSlotLifecycle::require_invitation_room(std::size_t invitation_count)
{
    if (invitation_count >= max_invitations)
        throw ContainerFailure{ContainerError::limit_exceeded};
}

ManagedSlotData PasswordSlotLifecycle::new_invitation(
    std::uint8_t permissions, const std::string &temporary_label)
{
    ManagedSlotData result;
    randombytes_buf(result.slot_id.data(), result.slot_id.size());
    result.actual_slot_id = result.slot_id;
    result.permissions = permissions;
    result.must_be_changed = true;
    result.identity_name = temporary_label;
    return result;
}

void PasswordSlotLifecycle::validate_claim_request(const std::uint8_t *password,
    std::size_t password_size, const std::string &profile_name,
    const std::string &profile_email)
{
    require_strong_password(password, password_size);
    if (profile_name.empty() || profile_email.empty()
        || profile_name.size() > max_holder_field_size
        || profile_email.size() > max_holder_field_size)
        throw ContainerFailure{ContainerError::invalid_argument};
}

void PasswordSlotLifecycle::validate_rotation_password(
    const std::uint8_t *password, std::size_t password_size)
{
    require_strong_password(password, password_size);
}

void PasswordSlotLifecycle::authorize_rotation(const UnlockedContainerData &access)
{
    if (access.must_be_changed)
        throw ContainerFailure{ContainerError::invalid_argument};
}

void PasswordSlotLifecycle::validate_reconciliation_identity(
    const std::string &profile_name, const std::string &profile_email)
{
    if (profile_name.empty() || profile_email.empty()
        || profile_name.size() > max_holder_field_size
        || profile_email.size() > max_holder_field_size)
        throw ContainerFailure{ContainerError::invalid_argument};
}

void PasswordSlotLifecycle::authorize_reconciliation(
    const UnlockedContainerData &access)
{
    if (access.recovery_slot || access.must_be_changed)
        throw ContainerFailure{ContainerError::invalid_argument};
}

void PasswordSlotLifecycle::reconcile_managed_identity(
    ManagedSlotData &metadata, const UnlockedContainerData &access,
    const std::string &profile_name, const std::string &profile_email)
{
    authorize_reconciliation(access);
    if (access.owner_slot || metadata.must_be_changed)
        throw ContainerFailure{ContainerError::invalid_argument};
    if (metadata.slot_id_known && metadata.actual_slot_id != access.slot_id)
        throw ContainerFailure{ContainerError::malformed_container};
    metadata.actual_slot_id = access.slot_id;
    metadata.slot_id_known = true;
    if (!metadata.identity_name.empty())
        sodium_memzero(metadata.identity_name.data(), metadata.identity_name.size());
    if (!metadata.identity_email.empty())
        sodium_memzero(metadata.identity_email.data(), metadata.identity_email.size());
    metadata.identity_name = profile_name;
    metadata.identity_email = profile_email;
    metadata.identity_known = true;
}

ManagedSlotData PasswordSlotLifecycle::claim_invitation(
    const UnlockedContainerData &access, const ManagedSlotData *previous_metadata,
    const std::string &profile_name, const std::string &profile_email)
{
    if (!access.must_be_changed)
        throw ContainerFailure{ContainerError::invalid_argument};
    ManagedSlotData result;
    result.slot_id = previous_metadata == nullptr
        ? access.slot_id : previous_metadata->slot_id;
    result.actual_slot_id = access.slot_id;
    result.permissions = previous_metadata != nullptr
        && previous_metadata->permissions_known
        ? previous_metadata->permissions : access.permissions;
    result.must_be_changed = false;
    result.identity_name = profile_name;
    result.identity_email = profile_email;
    return result;
}

ManagedSlotData PasswordSlotLifecycle::legacy_invitation(
    const std::array<std::uint8_t, 16> &management_id, std::size_t index)
{
    ManagedSlotData result;
    result.slot_id = management_id;
    result.slot_id_known = false;
    result.permissions_known = false;
    result.must_be_changed_known = false;
    result.identity_known = false;
    result.identity_name = "Legacy invitation " + std::to_string(index + 1);
    return result;
}

} // namespace scpefe::container
