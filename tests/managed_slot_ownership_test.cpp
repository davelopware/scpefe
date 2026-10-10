#include "container/unlocked_container_data.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <type_traits>
#include <utility>

using scpefe::container::ManagedSlotData;

#define CHECK(condition) do { \
    if (!(condition)) { \
        std::fprintf(stderr, "managed-slot ownership check failed at line %d: %s\n", \
            __LINE__, #condition); \
        std::abort(); \
    } \
} while (false)

static_assert(!std::is_copy_constructible_v<ManagedSlotData>);
static_assert(!std::is_copy_assignable_v<ManagedSlotData>);
static_assert(std::is_nothrow_move_constructible_v<ManagedSlotData>);
static_assert(std::is_nothrow_move_assignable_v<ManagedSlotData>);

struct WipeWatch {
    const void *address{};
    std::size_t size{};
    char expected{};
    bool wiped{};
};

static std::array<WipeWatch, 15> watches;

extern "C" void sodium_memzero(void *buffer, std::size_t size)
{
    for (std::size_t index = 0; index < watches.size(); ++index) {
        auto &watch = watches[index];
        if (watch.address == buffer && size >= watch.size) {
            const auto *bytes = static_cast<const char *>(buffer);
            CHECK(watch.size == 5 && watch.expected == 'S'
                ? std::memcmp(bytes, "Short", watch.size) == 0
                : std::all_of(bytes, bytes + watch.size,
                    [&](char value) { return value == watch.expected; }));
            watch.wiped = true;
        }
    }
    std::memset(buffer, 0, size);
}

static ManagedSlotData populated(const std::string &identity, char id)
{
    ManagedSlotData slot;
    slot.slot_id.fill(static_cast<unsigned char>(id));
    slot.actual_slot_id.fill(static_cast<unsigned char>(id));
    slot.permissions = 3;
    slot.must_be_changed = true;
    slot.identity_name = identity;
    slot.identity_email = identity;
    return slot;
}

static void expect_cleared(const ManagedSlotData &slot)
{
    CHECK(std::all_of(slot.slot_id.begin(), slot.slot_id.end(),
        [](auto value) { return value == 0; }));
    CHECK(std::all_of(slot.actual_slot_id.begin(), slot.actual_slot_id.end(),
        [](auto value) { return value == 0; }));
    CHECK(slot.permissions == 0 && !slot.must_be_changed);
    CHECK(!slot.slot_id_known && !slot.permissions_known
        && !slot.must_be_changed_known && !slot.identity_known);
    CHECK(slot.identity_name.empty() && slot.identity_email.empty());
}

static void expect_owned(const ManagedSlotData &slot,
    const std::string &identity, char id)
{
    CHECK(slot.slot_id[0] == static_cast<unsigned char>(id));
    CHECK(slot.actual_slot_id[0] == static_cast<unsigned char>(id));
    CHECK(slot.permissions == 3 && slot.must_be_changed);
    CHECK(slot.slot_id_known && slot.permissions_known
        && slot.must_be_changed_known && slot.identity_known);
    CHECK(slot.identity_name == identity && slot.identity_email == identity);
}

int main()
{
    const std::string short_identity = "Short";
    const std::string long_identity(256, 'L');

    auto short_source = populated(short_identity, 'S');
    watches[0] = {short_source.identity_name.data(), short_identity.size(), 'S'};
    watches[1] = {short_source.identity_email.data(), short_identity.size(), 'S'};
    auto short_owner = std::move(short_source);
    expect_cleared(short_source);
    expect_owned(short_owner, short_identity, 'S');
    CHECK(watches[0].wiped && watches[1].wiped);
    watches[0] = {};
    watches[1] = {};

    auto long_source = populated(long_identity, 'L');
    const char *long_name = long_source.identity_name.data();
    const char *long_email = long_source.identity_email.data();
    auto long_owner = std::move(long_source);
    expect_cleared(long_source);
    expect_owned(long_owner, long_identity, 'L');
    CHECK(long_owner.identity_name.data() == long_name);
    CHECK(long_owner.identity_email.data() == long_email);

    auto replacement = populated(short_identity, 'S');
    watches[2] = {long_owner.identity_name.data(), long_identity.size(), 'L'};
    watches[3] = {long_owner.identity_email.data(), long_identity.size(), 'L'};
    watches[4] = {long_owner.slot_id.data(), long_owner.slot_id.size(), 'L'};
    long_owner = std::move(replacement);
    expect_cleared(replacement);
    expect_owned(long_owner, short_identity, 'S');
    CHECK(watches[2].wiped && watches[3].wiped && watches[4].wiped);
    watches[2] = {};
    watches[3] = {};
    watches[4] = {};

    auto long_replacement = populated(long_identity, 'L');
    short_owner = std::move(long_replacement);
    expect_cleared(long_replacement);
    expect_owned(short_owner, long_identity, 'L');
    short_owner = std::move(short_owner);
    expect_owned(short_owner, long_identity, 'L');

    auto long_destination = populated(std::string(256, 'D'), 'D');
    auto long_assignment_source = populated(long_identity, 'L');
    const char *assigned_name = long_assignment_source.identity_name.data();
    const char *assigned_email = long_assignment_source.identity_email.data();
    watches[11] = {long_destination.identity_name.data(), 256, 'D'};
    watches[12] = {long_destination.identity_email.data(), 256, 'D'};
    watches[13] = {long_destination.slot_id.data(),
        long_destination.slot_id.size(), 'D'};
    watches[14] = {long_destination.actual_slot_id.data(),
        long_destination.actual_slot_id.size(), 'D'};
    long_destination = std::move(long_assignment_source);
    expect_cleared(long_assignment_source);
    expect_owned(long_destination, long_identity, 'L');
    CHECK(long_destination.identity_name.data() == assigned_name);
    CHECK(long_destination.identity_email.data() == assigned_email);
    CHECK(watches[11].wiped && watches[12].wiped
        && watches[13].wiped && watches[14].wiped);
    watches[11] = {};
    watches[12] = {};
    watches[13] = {};
    watches[14] = {};

    {
        auto short_lifetime = populated(short_identity, 'S');
        watches[5] = {short_lifetime.identity_name.data(), short_identity.size(), 'S'};
        watches[6] = {short_lifetime.identity_email.data(), short_identity.size(), 'S'};
        watches[7] = {short_lifetime.actual_slot_id.data(),
            short_lifetime.actual_slot_id.size(), 'S'};
    }
    CHECK(watches[5].wiped && watches[6].wiped && watches[7].wiped);
    watches[5] = {};
    watches[6] = {};
    watches[7] = {};
    {
        auto long_lifetime = populated(long_identity, 'L');
        watches[8] = {long_lifetime.identity_name.data(), long_identity.size(), 'L'};
        watches[9] = {long_lifetime.identity_email.data(), long_identity.size(), 'L'};
        watches[10] = {long_lifetime.slot_id.data(), long_lifetime.slot_id.size(), 'L'};
    }
    CHECK(watches[8].wiped && watches[9].wiped && watches[10].wiped);
}
