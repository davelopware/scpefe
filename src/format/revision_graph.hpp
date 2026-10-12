#pragma once

#include "format/revision_limits.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace scpefe::format {

using RevisionId = std::array<std::uint8_t, 32>;

/* One authenticated v3 record, including immutable attribution and current storage. */
struct RevisionRecord {
    /* A byte-copy or insertion segment of an original delta. */
    struct Segment {
        bool insert{};
        std::uint64_t start{};
        std::uint64_t count{};
        std::string text;
    };
    RevisionId id{};
    std::optional<RevisionId> previous;
    std::optional<RevisionId> content_parent;
    std::vector<RevisionId> merge_sources;
    std::uint64_t timestamp_ms{};
    std::array<std::uint8_t, 16> actor_slot{};
    std::string actor_name, actor_email, client_name, client_email, device;
    RevisionId content_hash{}, body_digest{};
    std::string event_type, event_detail;
    std::vector<std::uint8_t> immutable_cbor, event_details_cbor;
    std::optional<RevisionId> resolved_by;
    std::optional<RevisionId> compaction_cutoff;
    std::optional<std::uint64_t> retained_deltas;
    std::string body_text;
    std::vector<std::uint8_t> body_cbor;
    std::vector<Segment> segments;
    std::uint64_t body_length{};
    std::uint8_t kind{}, storage{};
    bool has_body_digest{}, provisional{}, foreign{};
    bool text_available{};
};

/* Validates and owns one deterministic v3 payload and its canonical history. */
class RevisionGraph {
public:
    /* Decodes a decrypted authenticated payload; the caller authenticates its envelope. */
    static RevisionGraph decode(const std::uint8_t *bytes, std::size_t size,
        const RevisionLimits &limits);
    /* Returns the original canonical encoding after complete validation. */
    const std::vector<std::uint8_t> &encode() const { return encoded_; }
    /* Returns all records in stored causal order. */
    const std::vector<RevisionRecord> &records() const { return records_; }
    /* Returns the final canonical revision ID. */
    const RevisionId &head() const { return head_; }
    /* Returns the final canonical content revision ID. */
    const RevisionId &content_head() const { return content_head_; }
    /* Locates an immutable ID, or returns null for an unknown ID. */
    const RevisionRecord *find(const RevisionId &id) const;
    /* Reconstructs a canonical content revision, or returns null when pruned. */
    std::optional<std::string> reconstruct(const RevisionId &id) const;
    /* Computes a bounded readable line comparison for available revisions. */
    std::optional<std::string> compare(const RevisionId &before,
        const RevisionId &after) const;
    /* Returns a redacted JSON summary unless clear text is explicitly requested. */
    std::string diagnostic_json(bool include_content) const;

private:
    std::vector<std::uint8_t> encoded_;
    std::vector<RevisionRecord> records_;
    RevisionId head_{}, content_head_{};
    std::size_t max_text_bytes_{};
};

} // namespace scpefe::format
