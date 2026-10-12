#pragma once

#include "container/unlocked_container_data.hpp"
#include "core/password_service.hpp"
#include "core/encryption_service.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace scpefe::container {

/* Names one authenticated credential or slot metadata change. */
enum class SlotChangeKind { change_password, add_invitation, claim_invitation,
    reconcile_identity, update_permissions, remove_slot };

/* Carries transient inputs for one slot operation; password spans are never owned. */
struct SlotChange {
    SlotChangeKind kind;
    std::array<std::uint8_t, 16> target_id{};
    const std::uint8_t *new_password{};
    std::size_t new_password_size{};
    std::uint8_t permissions{};
    std::string_view name, email;
};

/* Describes a validated metadata and wrapper update for candidate preparation. */
struct SlotChangeResult {
    std::vector<format::RevisionSlot> slots;
    std::array<std::uint8_t, 16> affected_id{};
    std::size_t wrapper_index{};
    unsigned wrapper_mode{};
    bool remove_active{};
    std::string_view event_type;
    std::string event_detail;
};

/* Builds a proposed slot collection while enforcing cooperative permissions. */
class PasswordSlots {
public:
    /* Copies the authenticated collection and keeps only required services. */
    PasswordSlots(const format::RevisionGraph &graph,
        const UnlockedContainerData &active, const core::PasswordService &password,
        const core::EncryptionService &encryption,
        const std::uint8_t *container, std::size_t container_size);
    /* Applies one operation only after validating authority, limits, and reuse. */
    SlotChangeResult apply(const SlotChange &change) const;

private:
    const format::RevisionGraph &graph_;
    const UnlockedContainerData &active_;
    const core::PasswordService &password_;
    const core::EncryptionService &encryption_;
    const std::uint8_t *container_;
    std::size_t container_size_;
};

} // namespace scpefe::container
