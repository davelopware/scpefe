#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace scpefe::container {

/* Authenticated holder and timing fields for the shared advisory editing lease. */
struct EditingLeaseData {
    std::array<std::uint8_t, 16> session_id{};
    std::uint64_t heartbeat_counter{};
    std::uint64_t holder_utc_ms{};
    std::uint64_t duration_ms{600000};
    std::string holder_name;
    std::string holder_email;
    std::string device_name;
    bool active{};
};

/* Authenticated semantic values recovered from one encrypted container. */
struct UnlockedContainerData {
    /* Creates empty unlocked values. */
    UnlockedContainerData() = default;
    /* Transfers unlocked values and wipes fixed secrets in the source. */
    UnlockedContainerData(UnlockedContainerData &&other) noexcept;
    /* Replaces unlocked values and wipes fixed secrets in the source. */
    UnlockedContainerData &operator=(UnlockedContainerData &&other) noexcept;
    /* Wipes all owned authenticated plaintext before releasing storage. */
    ~UnlockedContainerData();
    /* Prevents duplicating authenticated plaintext through construction. */
    UnlockedContainerData(const UnlockedContainerData &) = delete;
    /* Prevents duplicating authenticated plaintext through assignment. */
    UnlockedContainerData &operator=(const UnlockedContainerData &) = delete;

    std::array<std::uint8_t, 16> document_id{};
    std::array<std::uint8_t, 16> slot_id{};
    std::array<std::uint8_t, 32> work_journal_key{};
    std::uint8_t permissions{};
    bool recovery_slot{};
    bool must_be_changed{};
    std::string slot_identity_name;
    std::string slot_identity_email;
    EditingLeaseData editing_lease;
    std::vector<std::uint8_t> encoded_snapshot_revision;

private:
    /* Wipes all currently owned authenticated plaintext in place. */
    void clear() noexcept;
};

} // namespace scpefe::container
