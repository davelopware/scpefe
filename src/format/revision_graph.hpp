#pragma once

#include "format/revision_limits.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace scpefe::format {

/* Receives bounded, escaped diagnostic output. */
class DiagnosticJsonWriter;

using RevisionId = std::array<std::uint8_t, 32>;

/* Names a merge condition requiring a distinct host or user decision. */
enum class MergeProblem { unrelated_target, rollback, unavailable_base,
    revoked_access, permission_denied };

/* Carries one classified merge condition without losing its cause. */
struct MergeFailure { MergeProblem problem; };

/* Classifies one authenticated target relative to the local canonical head. */
enum class TargetLineage { unchanged, advanced, divergent };

/* Authenticated encrypted metadata for one ordered v3 password slot. */
struct RevisionSlot {
    std::array<std::uint8_t, 16> id{}, management_id{};
    std::uint8_t permissions{}, role{};
    bool must_be_changed{};
    std::string name, email;
};

/* Authenticated encrypted advisory editing lease metadata. */
struct RevisionLease {
    std::array<std::uint8_t, 16> session_id{};
    std::uint64_t heartbeat_counter{}, holder_utc_ms{}, duration_ms{};
    std::string holder_name, holder_email, device;
    bool active{};
};

/* One authenticated v3 record, including immutable attribution and current storage. */
struct RevisionRecord {
    /* Creates an empty record for authenticated decoding. */
    RevisionRecord() = default;
    /* Copies a record, keeping source bytes live for secure destruction. */
    RevisionRecord(const RevisionRecord &) = default;
    /* Copies record fields into an existing history value. */
    RevisionRecord &operator=(const RevisionRecord &) = default;
    /* Wipes decrypted record bodies, including partially decoded records. */
    ~RevisionRecord();
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
    std::vector<std::uint8_t> immutable_cbor, event_details_cbor, record_cbor;
    std::optional<RevisionId> resolved_by;
    std::optional<RevisionId> compaction_cutoff;
    std::optional<std::uint64_t> retained_deltas;
    std::optional<std::array<std::uint8_t, 16>> affected_slot;
    std::optional<std::uint8_t> activity_status;
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
    /* Creates an empty graph for bounded decoding. */
    RevisionGraph() = default;
    /* Copies a validated graph for independent session operations. */
    RevisionGraph(const RevisionGraph &) = default;
    /* Copies a graph into an existing session value. */
    RevisionGraph &operator=(const RevisionGraph &) = default;
    /* Transfers graph ownership without allocating. */
    RevisionGraph(RevisionGraph &&) noexcept = default;
    /* Transfers a graph into an existing session value without allocating. */
    RevisionGraph &operator=(RevisionGraph &&) noexcept = default;
    /* Wipes retained decrypted encodings, bodies, and identities before release. */
    ~RevisionGraph();
    /* Encodes one attributed baseline and ordered initial slot metadata. */
    static std::vector<std::uint8_t> create_baseline(const RevisionSlot &owner,
        const std::optional<RevisionSlot> &recovery, std::string_view device,
        std::string_view content, std::uint64_t timestamp_ms);
    /* Decodes a decrypted authenticated payload; the caller authenticates its envelope. */
    static RevisionGraph decode(const std::uint8_t *bytes, std::size_t size,
        const RevisionLimits &limits);
    /* Returns the original canonical encoding after complete validation. */
    const std::vector<std::uint8_t> &encode() const { return encoded_; }
    /* Returns all records in stored causal order. */
    const std::vector<RevisionRecord> &records() const { return records_; }
    /* Returns ordered semantic slot metadata after graph validation. */
    const std::vector<RevisionSlot> &slots() const { return slots_; }
    /* Returns the authenticated advisory lease fields. */
    const RevisionLease &lease() const { return lease_; }
    /* Replaces only authenticated lease metadata while preserving every revision ID. */
    std::vector<std::uint8_t> replace_lease(const RevisionLease &lease) const;
    /* Returns the final canonical revision ID. */
    const RevisionId &head() const { return head_; }
    /* Returns the final canonical content revision ID. */
    const RevisionId &content_head() const { return content_head_; }
    /* Locates an immutable ID, or returns null for an unknown ID. */
    const RevisionRecord *find(const RevisionId &id) const;
    /* Requires shared authenticated lineage and rejects a rolled-back target. */
    TargetLineage assess_target(const RevisionGraph &target) const;
    /* Reconstructs a canonical content revision, or returns null when pruned. */
    std::optional<std::string> reconstruct(const RevisionId &id) const;
    /* Computes a bounded readable line comparison for available revisions. */
    std::optional<std::string> compare(const RevisionId &before,
        const RevisionId &after) const;
    /* Builds a validated manual, regular, or provisional-discard graph. */
    std::vector<std::uint8_t> save_content(std::string_view content,
        std::string_view profile_name, std::string_view profile_email,
        std::string_view device, const RevisionSlot &actor,
        std::uint64_t timestamp_ms, bool regular, bool discard) const;
    /* Resolves a related foreign head onto this local content line using target slots. */
    std::vector<std::uint8_t> merge_with(const RevisionGraph &target,
        std::string_view content, std::string_view profile_name,
        std::string_view profile_email, std::string_view device,
        const RevisionSlot &actor, std::uint64_t timestamp_ms) const;
    /* Anchors an existing content revision and appends an attributed compaction event. */
    std::vector<std::uint8_t> compact_at(std::size_t content_cutoff,
        const RevisionSlot &actor, std::string_view client_name,
        std::string_view client_email, std::string_view device,
        std::uint64_t timestamp_ms) const;
    /* Appends a credential metadata event with a replacement slot collection. */
    std::vector<std::uint8_t> append_slot_event(
        const std::vector<RevisionSlot> &slots, const RevisionSlot &actor,
        const std::array<std::uint8_t, 16> &affected_slot,
        std::string_view event_type, std::string_view event_detail,
        std::string_view client_name, std::string_view client_email,
        std::string_view device, std::uint64_t timestamp_ms) const;
    /* Appends an attempt or observed outcome without changing content or slots. */
    std::vector<std::uint8_t> append_activity_event(
        const RevisionSlot &actor, std::string_view event_type,
        std::string_view event_detail, std::uint8_t activity_status,
        std::string_view client_name, std::string_view client_email,
        std::string_view device, std::uint64_t timestamp_ms) const;
    /* Returns a redacted JSON summary unless clear text is explicitly requested. */
    std::string diagnostic_json(bool include_content) const;
    /* Appends validated graph metadata to a shared bounded JSON writer. */
    void write_diagnostic_json(DiagnosticJsonWriter &json, bool include_content) const;

private:
    /* Encodes the common immutable event and preserves its content head. */
    std::vector<std::uint8_t> append_event(const std::vector<RevisionSlot> &slots,
        const RevisionSlot &actor, const std::array<std::uint8_t, 16> &affected_slot,
        std::string_view event_type, std::string_view event_detail,
        std::optional<std::uint8_t> activity_status,
        std::string_view client_name, std::string_view client_email,
        std::string_view device, std::uint64_t timestamp_ms) const;
    std::vector<std::uint8_t> encoded_;
    std::array<std::pair<std::size_t, std::size_t>, 10> field_ranges_{};
    std::vector<RevisionRecord> records_;
    std::vector<RevisionSlot> slots_;
    RevisionLease lease_;
    RevisionId head_{}, content_head_{};
    std::size_t max_text_bytes_{};
};

} // namespace scpefe::format
