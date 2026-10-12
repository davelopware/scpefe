#include "container/password_slots.hpp"
#include "container/container_error.hpp"
#include "format/text_validation.hpp"

#include <algorithm>

namespace scpefe::container {
namespace {

void require(bool condition)
{
    if (!condition) throw ContainerFailure{ContainerError::invalid_argument};
}

void validate_identity(std::string_view name, std::string_view email)
{
    require(!name.empty() && !email.empty() && name.size() <= 4096
        && email.size() <= 4096
        && format::valid_utf8(name.data(), name.size())
        && format::valid_utf8(email.data(), email.size()));
}

void validate_permissions(std::uint8_t permissions)
{
    require((permissions & ~7u) == 0
        && ((permissions & 6u) == 0 || (permissions & 1u) != 0));
}

} // namespace

PasswordSlots::PasswordSlots(const format::RevisionGraph &graph,
    const UnlockedContainerData &active, const core::PasswordService &password,
    const core::EncryptionService &encryption,
    const std::uint8_t *container, std::size_t container_size)
    : graph_(graph), active_(active), password_(password),
      encryption_(encryption), container_(container), container_size_(container_size) {}

SlotChangeResult PasswordSlots::apply(const SlotChange &change) const
{
    SlotChangeResult result;
    result.slots = graph_.slots();
    const auto active = std::find_if(result.slots.begin(), result.slots.end(),
        [&](const auto &slot) { return slot.id == active_.slot_id; });
    if (active == result.slots.end())
        throw ContainerFailure{ContainerError::malformed_container};
    const auto active_index = static_cast<std::size_t>(active - result.slots.begin());
    auto target = std::find_if(result.slots.begin(), result.slots.end(),
        [&](const auto &slot) { return slot.id == change.target_id; });
    const bool password_change = change.kind == SlotChangeKind::change_password
        || change.kind == SlotChangeKind::add_invitation
        || change.kind == SlotChangeKind::claim_invitation;
    if (password_change) {
        require(change.new_password && change.new_password_size > 0
            && change.new_password_size <= 4096);
        if (password_.assess(change.new_password, change.new_password_size)
            != security::PasswordPolicyAssessment::accepted)
            throw ContainerFailure{ContainerError::weak_password};
    } else require(change.new_password == nullptr && change.new_password_size == 0);
    switch (change.kind) {
    case SlotChangeKind::change_password:
        require(!active_.must_be_changed);
        result.affected_id = active->id;
        result.wrapper_mode = 2;
        result.wrapper_index = active_index;
        result.event_type = "password-changed";
        break;
    case SlotChangeKind::add_invitation: {
        require(!active_.must_be_changed && (active_.permissions & 2u)
            && (change.permissions & ~active_.permissions) == 0);
        validate_permissions(change.permissions);
        require(!change.name.empty() && change.name.size() <= 4096
            && format::valid_utf8(change.name.data(), change.name.size()));
        const auto ordinary = std::count_if(result.slots.begin(), result.slots.end(),
            [](const auto &slot) { return slot.role == 1; });
        if (ordinary >= 7) throw ContainerFailure{ContainerError::limit_exceeded};
        format::RevisionSlot invitation;
        invitation.role = 1;
        invitation.permissions = change.permissions;
        invitation.must_be_changed = true;
        invitation.name = change.name;
        do { encryption_.random_bytes(invitation.id.data(), invitation.id.size()); }
        while (std::any_of(result.slots.begin(), result.slots.end(),
            [&](const auto &slot) { return slot.id == invitation.id; }));
        do { encryption_.random_bytes(invitation.management_id.data(),
            invitation.management_id.size()); }
        while (std::any_of(result.slots.begin(), result.slots.end(),
            [&](const auto &slot) {
                return slot.management_id == invitation.management_id;
            }));
        const auto recovery = std::find_if(result.slots.begin(), result.slots.end(),
            [](const auto &slot) { return slot.role == 2; });
        result.wrapper_index = static_cast<std::size_t>(recovery - result.slots.begin());
        result.affected_id = invitation.id;
        result.slots.insert(recovery, std::move(invitation));
        result.wrapper_mode = 1;
        result.event_type = "invitation-created";
        result.event_detail = "permissions=" + std::to_string(change.permissions);
        break;
    }
    case SlotChangeKind::claim_invitation:
        require(active->role == 1 && active_.must_be_changed);
        validate_identity(change.name, change.email);
        active->must_be_changed = false;
        active->name = change.name;
        active->email = change.email;
        result.affected_id = active->id;
        result.wrapper_mode = 2;
        result.wrapper_index = active_index;
        result.event_type = "invitation-claimed";
        break;
    case SlotChangeKind::reconcile_identity:
        require(!active_.must_be_changed && active->role != 2);
        validate_identity(change.name, change.email);
        active->name = change.name;
        active->email = change.email;
        result.affected_id = active->id;
        result.event_type = "identity-reconciled";
        break;
    case SlotChangeKind::update_permissions:
        require(!active_.must_be_changed && (active_.permissions & 6u) == 6u);
        require(target != result.slots.end() && target->role == 1
            && !target->must_be_changed);
        validate_permissions(change.permissions);
        target->permissions = change.permissions;
        result.affected_id = target->id;
        result.event_type = "permissions-updated";
        result.event_detail = "permissions=" + std::to_string(change.permissions);
        break;
    case SlotChangeKind::remove_slot:
        require(!active_.must_be_changed && (active_.permissions & 4u));
        require(target != result.slots.end() && target->role == 1);
        result.wrapper_index = static_cast<std::size_t>(target - result.slots.begin());
        result.affected_id = target->id;
        result.remove_active = target->id == active->id;
        result.slots.erase(target);
        result.wrapper_mode = 3;
        result.event_type = "slot-removed";
        break;
    }
    if (password_change)
        password_.require_unused(container_, container_size_,
            change.new_password, change.new_password_size);
    return result;
}

} // namespace scpefe::container
