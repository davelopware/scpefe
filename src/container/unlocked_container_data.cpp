#include "container/unlocked_container_data.hpp"

#include <type_traits>
#include <utility>

extern "C" void sodium_memzero(void *buffer, std::size_t size);

namespace scpefe::container {
namespace {

void clear_string(std::string &value) noexcept
{
    if (!value.empty()) sodium_memzero(value.data(), value.size());
    value.clear();
}

} // namespace

static_assert(!std::is_copy_constructible_v<UnlockedContainerData>);
static_assert(!std::is_copy_assignable_v<UnlockedContainerData>);
static_assert(std::is_nothrow_move_constructible_v<UnlockedContainerData>);
static_assert(std::is_nothrow_move_assignable_v<UnlockedContainerData>);

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
    must_be_changed = other.must_be_changed;
    slot_identity_name = std::move(other.slot_identity_name);
    slot_identity_email = std::move(other.slot_identity_email);
    editing_lease = std::move(other.editing_lease);
    encoded_snapshot_revision = std::move(other.encoded_snapshot_revision);
    sodium_memzero(other.document_id.data(), other.document_id.size());
    sodium_memzero(other.slot_id.data(), other.slot_id.size());
    sodium_memzero(other.work_journal_key.data(), other.work_journal_key.size());
    other.permissions = 0;
    other.recovery_slot = false;
    other.must_be_changed = false;
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
    if (!encoded_snapshot_revision.empty()) {
        sodium_memzero(encoded_snapshot_revision.data(),
            encoded_snapshot_revision.size());
    }
    encoded_snapshot_revision.clear();
}

} // namespace scpefe::container
