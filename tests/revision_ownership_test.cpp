#include "format/snapshot_revision_data.hpp"

#include <array>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <string>
#include <type_traits>
#include <utility>

using scpefe::format::RevisionGraphNodeData;
using scpefe::format::SnapshotRevisionData;

#define CHECK(condition) do { \
    if (!(condition)) { \
        std::fprintf(stderr, "ownership check failed at line %d: %s\n", \
            __LINE__, #condition); \
        std::abort(); \
    } \
} while (false)

static_assert(!std::is_copy_constructible_v<SnapshotRevisionData>);
static_assert(!std::is_copy_assignable_v<SnapshotRevisionData>);
static_assert(std::is_nothrow_move_constructible_v<SnapshotRevisionData>);
static_assert(std::is_nothrow_move_assignable_v<SnapshotRevisionData>);

struct WipeWatch {
    const void *address{};
    std::size_t size{};
    bool wiped{};
};

static std::array<WipeWatch, 5> wipe_watches;

extern "C" void sodium_memzero(void *buffer, std::size_t size)
{
    for (auto &watch : wipe_watches) {
        if (watch.address == buffer && size >= watch.size) watch.wiped = true;
    }
    std::memset(buffer, 0, size);
}

static SnapshotRevisionData populated(const std::string &text)
{
    SnapshotRevisionData data;
    data.parent_revision_ids.assign(32, 0x11);
    data.timestamp_ms = 123;
    data.slot_id.assign(16, 0x22);
    data.slot_identity_name = text;
    data.slot_identity_email = text;
    data.client_profile_name = text;
    data.client_profile_email = text;
    data.device_name = text;
    data.content_hash.assign(32, 0x33);
    data.content = text;
    RevisionGraphNodeData node;
    node.revision_id.fill(0x44);
    node.parent_revision_ids.assign(32, 0x55);
    data.ancestor_graph.push_back(std::move(node));
    data.manually_sealed = false;
    data.provisional_base_revision.assign(64, 0x66);
    data.event_type = text;
    data.event_detail = text;
    return data;
}

static void expect_cleared(const SnapshotRevisionData &data)
{
    CHECK(data.parent_revision_ids.empty());
    CHECK(data.timestamp_ms == 0);
    CHECK(data.slot_id.empty());
    CHECK(data.slot_identity_name.empty());
    CHECK(data.slot_identity_email.empty());
    CHECK(data.client_profile_name.empty());
    CHECK(data.client_profile_email.empty());
    CHECK(data.device_name.empty());
    CHECK(data.content_hash.empty());
    CHECK(data.content.empty());
    CHECK(data.ancestor_graph.empty());
    CHECK(data.manually_sealed);
    CHECK(data.provisional_base_revision.empty());
    CHECK(data.event_type.empty());
    CHECK(data.event_detail.empty());
}

static void expect_transferred(const SnapshotRevisionData &data,
    const std::string &text)
{
    CHECK(data.parent_revision_ids.size() == 32);
    CHECK(data.timestamp_ms == 123);
    CHECK(data.slot_id.size() == 16 && data.slot_id[0] == 0x22);
    CHECK(data.slot_identity_name == text);
    CHECK(data.slot_identity_email == text);
    CHECK(data.client_profile_name == text);
    CHECK(data.client_profile_email == text);
    CHECK(data.device_name == text);
    CHECK(data.content_hash.size() == 32 && data.content_hash[0] == 0x33);
    CHECK(data.content == text);
    CHECK(data.ancestor_graph.size() == 1);
    CHECK(data.ancestor_graph[0].revision_id[0] == 0x44);
    CHECK(data.ancestor_graph[0].parent_revision_ids[0] == 0x55);
    CHECK(!data.manually_sealed);
    CHECK(data.provisional_base_revision.size() == 64
        && data.provisional_base_revision[0] == 0x66);
    CHECK(data.event_type == text);
    CHECK(data.event_detail == text);
}

int main()
{
    const std::string short_text = "short";
    const std::string long_text(256, 'L');

    auto short_source = populated(short_text);
    wipe_watches[0] = {short_source.content.data(), short_source.content.size()};
    wipe_watches[1] = {short_source.device_name.data(),
        short_source.device_name.size()};
    auto short_owner = std::move(short_source);
    expect_cleared(short_source);
    expect_transferred(short_owner, short_text);
    CHECK(wipe_watches[0].wiped && wipe_watches[1].wiped);

    auto long_source = populated(long_text);
    const char *long_content = long_source.content.data();
    const std::uint8_t *long_base = long_source.provisional_base_revision.data();
    auto long_owner = std::move(long_source);
    expect_cleared(long_source);
    expect_transferred(long_owner, long_text);
    CHECK(long_owner.content.data() == long_content);
    CHECK(long_owner.provisional_base_revision.data() == long_base);

    auto short_replacement = populated(short_text);
    wipe_watches[2] = {long_owner.content.data(), long_owner.content.size()};
    wipe_watches[3] = {long_owner.provisional_base_revision.data(),
        long_owner.provisional_base_revision.size()};
    long_owner = std::move(short_replacement);
    expect_cleared(short_replacement);
    expect_transferred(long_owner, short_text);
    CHECK(wipe_watches[2].wiped && wipe_watches[3].wiped);

    auto long_assignment_destination = populated(std::string(256, 'D'));
    auto long_assignment_source = populated(long_text);
    const char *assigned_content = long_assignment_source.content.data();
    const char *assigned_slot_identity =
        long_assignment_source.slot_identity_name.data();
    const char *assigned_profile_identity =
        long_assignment_source.client_profile_name.data();
    const char *assigned_device = long_assignment_source.device_name.data();
    wipe_watches[4] = {long_assignment_destination.content.data(),
        long_assignment_destination.content.size()};
    long_assignment_destination = std::move(long_assignment_source);
    expect_cleared(long_assignment_source);
    expect_transferred(long_assignment_destination, long_text);
    CHECK(long_assignment_destination.content.data() == assigned_content);
    CHECK(long_assignment_destination.slot_identity_name.data()
        == assigned_slot_identity);
    CHECK(long_assignment_destination.client_profile_name.data()
        == assigned_profile_identity);
    CHECK(long_assignment_destination.device_name.data() == assigned_device);
    CHECK(wipe_watches[4].wiped);

    auto long_replacement = populated(long_text);
    short_owner = std::move(long_replacement);
    expect_cleared(long_replacement);
    expect_transferred(short_owner, long_text);

    short_owner = std::move(short_owner);
    expect_transferred(short_owner, long_text);
}
