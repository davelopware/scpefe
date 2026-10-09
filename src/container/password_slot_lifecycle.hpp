#pragma once

#include "container/unlocked_container_data.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>

namespace scpefe::container {

/* Applies invitation policy and authenticated slot-state transitions. */
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

    /* Marks values hidden inside a legacy password wrapper as unknown. */
    static ManagedSlotData legacy_invitation(
        const std::array<std::uint8_t, 16> &management_id,
        std::size_t index);
};

} // namespace scpefe::container
