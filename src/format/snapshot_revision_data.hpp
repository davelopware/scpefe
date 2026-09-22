#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace scpefe::format {

/* Version number encoded by SnapshotRevision. */
inline constexpr std::uint32_t snapshot_revision_format_version = 1u;
/* Fixed byte length of a revision identifier. */
inline constexpr std::size_t revision_id_size = 32u;
/* Fixed byte length of a password-slot identifier. */
inline constexpr std::size_t slot_id_size = 16u;
/* Fixed byte length of a snapshot content hash. */
inline constexpr std::size_t content_hash_size = 32u;

/* One authenticated ancestor node retained for revision-graph traversal. */
struct RevisionGraphNodeData {
    std::array<std::uint8_t, revision_id_size> revision_id{};
    std::vector<std::uint8_t> parent_revision_ids;
};

/* Semantic values owned by a SnapshotRevision. */
struct SnapshotRevisionData {
    /* Wipes decoded identity strings and slot identifiers on destruction. */
    ~SnapshotRevisionData();

    std::vector<std::uint8_t> parent_revision_ids;
    std::uint64_t timestamp_ms{};
    std::vector<std::uint8_t> slot_id;
    std::string slot_identity_name;
    std::string slot_identity_email;
    std::string client_profile_name;
    std::string client_profile_email;
    std::string device_name;
    std::vector<std::uint8_t> content_hash;
    std::string content;
    std::vector<RevisionGraphNodeData> ancestor_graph;
    bool manually_sealed{true};
    std::vector<std::uint8_t> provisional_base_revision;
    std::string event_type;
    std::string event_detail;
};

} // namespace scpefe::format
