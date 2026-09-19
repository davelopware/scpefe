#pragma once

#include <array>
#include <cstdint>
#include <vector>

namespace scpefe::container {

/* Authenticated semantic values recovered from one encrypted container. */
struct UnlockedContainerData {
    std::array<std::uint8_t, 16> document_id{};
    std::array<std::uint8_t, 16> slot_id{};
    std::array<std::uint8_t, 32> work_journal_key{};
    std::uint8_t permissions{};
    bool recovery_slot{};
    std::vector<std::uint8_t> encoded_snapshot_revision;
};

} // namespace scpefe::container
