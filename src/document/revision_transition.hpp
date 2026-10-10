#pragma once

#include "container/unlocked_container_data.hpp"

#include <cstdint>
#include <string_view>
#include <vector>

namespace scpefe::document {

/* Selects whether a save seals a revision or updates provisional work. */
enum class SaveKind { manual, regular };

/* Carries an encoded save result and its narrow identity-only permission case. */
struct SaveTransitionResult {
    std::vector<std::uint8_t> encoded_revision;
    bool identity_only{};
};

/* Owns lineage rules for saves, merges, migration, and compaction. */
class RevisionTransition {
public:
    /* Builds an attributed saved revision from the authenticated current head. */
    static SaveTransitionResult save(
        const container::UnlockedContainerData &unlocked,
        SaveKind kind,
        std::string_view profile_name,
        std::string_view profile_email,
        std::string_view device_name,
        std::string_view content,
        std::uint64_t timestamp_ms
    );

    /* Joins related divergent authenticated heads in one attributed sealed revision. */
    static std::vector<std::uint8_t> merge(
        const container::UnlockedContainerData &current,
        const container::UnlockedContainerData &local,
        std::string_view profile_name,
        std::string_view profile_email,
        std::string_view device_name,
        std::string_view content,
        std::uint64_t timestamp_ms
    );

    /* Seals a content-preserving migration event parented to the current head. */
    static std::vector<std::uint8_t> migration(
        const container::UnlockedContainerData &unlocked,
        std::string_view profile_name,
        std::string_view profile_email,
        std::string_view device_name,
        std::uint64_t timestamp_ms
    );

    /* Seals a baseline with only the prior head ID retained as a shallow parent. */
    static std::vector<std::uint8_t> compact(
        const container::UnlockedContainerData &unlocked
    );

    /* Returns the sealed base embedded in a valid provisional head. */
    static std::vector<std::uint8_t> discard(
        const container::UnlockedContainerData &unlocked
    );
};

} // namespace scpefe::document
