#pragma once

#include "container/unlocked_container_data.hpp"
#include "format/revision_limits.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace scpefe::container {

/* Reads recoverable v2/v3 containers and creates mutable version-3 containers. */
class RecoverablePasswordContainer {
public:
    /* Reports whether the bytes carry a supported recoverable-container magic. */
    static bool recognizes(const std::uint8_t *container, std::size_t size);

    /* Returns the version-3 encoded size for a snapshot and selected slot count. */
    static std::size_t encoded_size(std::size_t snapshot_size, bool has_recovery);

    /* Creates a version-3 container using a caller-generated owner slot identifier. */
    static std::vector<std::uint8_t> create(
        const std::uint8_t *owner_password,
        std::size_t owner_password_size,
        const std::uint8_t *recovery_password,
        std::size_t recovery_password_size,
        const std::array<std::uint8_t, 16> &owner_slot_id,
        const std::uint8_t *encoded_snapshot_revision,
        std::size_t encoded_snapshot_revision_size
    );

    /* Authenticates either slot in a matched v2/v3 envelope and returns its snapshot. */
    static UnlockedContainerData unlock(
        const std::uint8_t *container,
        std::size_t container_size,
        const std::uint8_t *password,
        std::size_t password_size,
        const format::RevisionLimits &limits
    );

    /* Re-encrypts a version-3 head after an edit or validated identity-only update. */
    static std::vector<std::uint8_t> replace_snapshot(
        const std::uint8_t *container,
        std::size_t container_size,
        const std::uint8_t *password,
        std::size_t password_size,
        const std::uint8_t *encoded_snapshot_revision,
        std::size_t encoded_snapshot_revision_size,
        bool allow_identity_only = false
    );

    /* Re-wraps the slot selected by its current password with a strong new password. */
    static std::vector<std::uint8_t> change_password(
        const std::uint8_t *container,
        std::size_t container_size,
        const std::uint8_t *current_password,
        std::size_t current_password_size,
        const std::uint8_t *new_password,
        std::size_t new_password_size
    );

    /* Adds one constrained ordinary invitation slot to a current container. */
    static std::vector<std::uint8_t> add_invitation(
        const std::uint8_t *container, std::size_t container_size,
        const std::uint8_t *creator_password, std::size_t creator_password_size,
        const std::uint8_t *temporary_password, std::size_t temporary_password_size,
        std::uint8_t permissions, const std::string &temporary_label
    );

    /* Replaces an invitation password and binds its slot to a local profile. */
    static std::vector<std::uint8_t> claim_invitation(
        const std::uint8_t *container, std::size_t container_size,
        const std::uint8_t *temporary_password, std::size_t temporary_password_size,
        const std::uint8_t *new_password, std::size_t new_password_size,
        const std::string &profile_name, const std::string &profile_email
    );

    /* Changes a managed ordinary slot's cooperative permissions. */
    static std::vector<std::uint8_t> update_slot_permissions(
        const std::uint8_t *container, std::size_t container_size,
        const std::uint8_t *administrator_password,
        std::size_t administrator_password_size,
        const std::array<std::uint8_t, 16> &slot_id,
        std::uint8_t permissions
    );

    /* Removes a managed ordinary slot while retaining permanent base slots. */
    static std::vector<std::uint8_t> remove_slot(
        const std::uint8_t *container, std::size_t container_size,
        const std::uint8_t *administrator_password,
        std::size_t administrator_password_size,
        const std::array<std::uint8_t, 16> &slot_id
    );

    /* Rebinds the authenticated ordinary slot to an explicitly chosen profile. */
    static std::vector<std::uint8_t> reconcile_identity(
        const std::uint8_t *container, std::size_t container_size,
        const std::uint8_t *password, std::size_t password_size,
        const std::string &profile_name, const std::string &profile_email
    );

    /* Re-encrypts only shared lease metadata while preserving revision ciphertext semantics. */
    static std::vector<std::uint8_t> replace_editing_lease(
        const std::uint8_t *container,
        std::size_t container_size,
        const std::uint8_t *password,
        std::size_t password_size,
        const EditingLeaseData &lease
    );
};

} // namespace scpefe::container
