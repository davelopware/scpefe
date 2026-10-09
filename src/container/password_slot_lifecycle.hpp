#pragma once

#include "container/unlocked_container_data.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>

namespace scpefe::container {

/* Applies invitation, identity, and managed-slot administration policy. */
class PasswordSlotLifecycle {
public:
    /* Validates a proposed invitation password, permissions, and temporary label. */
    static void validate_add_request(const std::uint8_t *password,
        std::size_t password_size, std::uint8_t permissions,
        const std::string &temporary_label);

    /* Checks the creator's authority without changing the requested role. */
    static void authorize_add(const UnlockedContainerData &creator,
        std::uint8_t permissions);

    /* Rejects a proposed password already accepted by another slot. */
    static void require_available_password(
        const std::function<bool()> &matches_existing_slot);

    /* Enforces the owner-plus-seven-invitations ordinary-slot limit. */
    static void require_invitation_room(std::size_t invitation_count);

    /* Creates known metadata for a new, unclaimed ordinary slot. */
    static ManagedSlotData new_invitation(std::uint8_t permissions,
        const std::string &temporary_label);

    /* Validates a claimant's proposed lasting password and local identity. */
    static void validate_claim_request(const std::uint8_t *password,
        std::size_t password_size, const std::string &profile_name,
        const std::string &profile_email);

    /* Binds a claimed identity while retaining the immutable slot and management IDs. */
    static ManagedSlotData claim_invitation(const UnlockedContainerData &access,
        const ManagedSlotData *previous_metadata,
        const std::string &profile_name, const std::string &profile_email);

    /* Validates a newly proposed password for any existing slot. */
    static void validate_rotation_password(const std::uint8_t *password,
        std::size_t password_size);

    /* Allows a claimed ordinary slot or the recovery slot to rotate itself. */
    static void authorize_rotation(const UnlockedContainerData &access);

    /* Validates the profile to bind to a claimed ordinary slot. */
    static void validate_reconciliation_identity(const std::string &profile_name,
        const std::string &profile_email);

    /* Refuses identity binding for unclaimed and recovery slots. */
    static void authorize_reconciliation(const UnlockedContainerData &access);

    /* Rebinds one managed slot without changing its ID, role, or claim state. */
    static void reconcile_managed_identity(ManagedSlotData &metadata,
        const UnlockedContainerData &access,
        const std::string &profile_name, const std::string &profile_email);

    /* Validates a managed ordinary slot's proposed cooperative permissions. */
    static void validate_managed_permissions(std::uint8_t permissions);

    /* Requires both administrative permissions and rejects unclaimed invitations. */
    static void authorize_permissions_update(const UnlockedContainerData &access);

    /* Changes only the authenticated permissions of a managed ordinary slot. */
    static void update_managed_permissions(ManagedSlotData &metadata,
        std::uint8_t permissions);

    /* Requires remove-password permission and rejects unclaimed invitations. */
    static void authorize_removal(const UnlockedContainerData &access);

    /* Marks values hidden inside a legacy password wrapper as unknown. */
    static ManagedSlotData legacy_invitation(
        const std::array<std::uint8_t, 16> &management_id,
        std::size_t index);
};

} // namespace scpefe::container
