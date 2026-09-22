#include "container/unlocked_container_data.hpp"

#include <cstring>
#include <type_traits>
#include <utility>
#include <vector>

extern "C" void sodium_memzero(void *buffer, std::size_t size);

namespace scpefe::container {
namespace {

void clear_string(std::string &value) noexcept
{
    if (!value.empty()) sodium_memzero(value.data(), value.size());
    value.clear();
}

void move_string_without_allocation(
    std::string &destination, std::string &source) noexcept
{
    if (source.size() <= destination.capacity()) {
        destination.resize(source.size());
        if (!source.empty()) {
            std::memcpy(destination.data(), source.data(), source.size());
            sodium_memzero(source.data(), source.size());
        }
        source.clear();
        return;
    }
    destination = std::move(source);
    clear_string(source);
}

void move_lease_without_allocation(
    EditingLeaseData &destination, EditingLeaseData &source) noexcept
{
    destination.session_id = source.session_id;
    destination.heartbeat_counter = source.heartbeat_counter;
    destination.holder_utc_ms = source.holder_utc_ms;
    destination.duration_ms = source.duration_ms;
    destination.active = source.active;
    move_string_without_allocation(destination.holder_name, source.holder_name);
    move_string_without_allocation(destination.holder_email, source.holder_email);
    move_string_without_allocation(destination.device_name, source.device_name);
}

} // namespace

static_assert(!std::is_copy_constructible_v<UnlockedContainerData>);
static_assert(!std::is_copy_assignable_v<UnlockedContainerData>);
static_assert(std::is_nothrow_move_constructible_v<UnlockedContainerData>);
static_assert(std::is_nothrow_move_assignable_v<UnlockedContainerData>);
static_assert(std::is_nothrow_move_assignable_v<std::string>);
static_assert(std::is_nothrow_move_assignable_v<EditingLeaseData>);
static_assert(std::is_nothrow_move_assignable_v<std::vector<ManagedSlotData>>);
static_assert(std::is_nothrow_move_assignable_v<std::vector<std::uint8_t>>);

ManagedSlotData::~ManagedSlotData()
{
    sodium_memzero(slot_id.data(), slot_id.size());
    sodium_memzero(actual_slot_id.data(), actual_slot_id.size());
    permissions = 0;
    must_be_changed = false;
    slot_id_known = false;
    permissions_known = false;
    must_be_changed_known = false;
    identity_known = false;
    clear_string(identity_name);
    clear_string(identity_email);
}

UnlockedContainerData::UnlockedContainerData(UnlockedContainerData &&other) noexcept
{
    *this = std::move(other);
}

UnlockedContainerData &UnlockedContainerData::operator=(
    UnlockedContainerData &&other) noexcept
{
    if (this == &other) return *this;
    clear();
    document_id = other.document_id;
    slot_id = other.slot_id;
    work_journal_key = other.work_journal_key;
    permissions = other.permissions;
    recovery_slot = other.recovery_slot;
    owner_slot = other.owner_slot;
    must_be_changed = other.must_be_changed;
    move_string_without_allocation(slot_identity_name, other.slot_identity_name);
    move_string_without_allocation(slot_identity_email, other.slot_identity_email);
    move_lease_without_allocation(editing_lease, other.editing_lease);
    managed_slots = std::move(other.managed_slots);
    encoded_snapshot_revision = std::move(other.encoded_snapshot_revision);
    other.clear();
    return *this;
}

UnlockedContainerData::~UnlockedContainerData()
{
    clear();
}

void UnlockedContainerData::clear() noexcept
{
    sodium_memzero(document_id.data(), document_id.size());
    sodium_memzero(slot_id.data(), slot_id.size());
    sodium_memzero(work_journal_key.data(), work_journal_key.size());
    permissions = 0;
    recovery_slot = false;
    owner_slot = false;
    must_be_changed = false;
    clear_string(slot_identity_name);
    clear_string(slot_identity_email);
    sodium_memzero(editing_lease.session_id.data(), editing_lease.session_id.size());
    editing_lease.heartbeat_counter = 0;
    editing_lease.holder_utc_ms = 0;
    editing_lease.duration_ms = 0;
    clear_string(editing_lease.holder_name);
    clear_string(editing_lease.holder_email);
    clear_string(editing_lease.device_name);
    editing_lease.active = false;
    for (auto &slot : managed_slots) {
        sodium_memzero(slot.slot_id.data(), slot.slot_id.size());
        sodium_memzero(slot.actual_slot_id.data(), slot.actual_slot_id.size());
        slot.permissions = 0;
        slot.must_be_changed = false;
        slot.slot_id_known = false;
        slot.permissions_known = false;
        slot.must_be_changed_known = false;
        slot.identity_known = false;
        clear_string(slot.identity_name);
        clear_string(slot.identity_email);
    }
    managed_slots.clear();
    if (!encoded_snapshot_revision.empty()) {
        sodium_memzero(encoded_snapshot_revision.data(),
            encoded_snapshot_revision.size());
    }
    encoded_snapshot_revision.clear();
}

} // namespace scpefe::container
