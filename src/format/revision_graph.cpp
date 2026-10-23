#include "format/revision_graph.hpp"

#include "format/blake2b.hpp"
#include "format/cbor_reader.hpp"
#include "format/cbor_writer.hpp"
#include "format/diagnostic_json_writer.hpp"
#include "format/clear_memory.hpp"
#include "format/clear_buffer_on_exit.hpp"
#include "format/revision_error.hpp"
#include "format/text_validation.hpp"

#include <algorithm>
#include <cstring>
#include <limits>
#include <map>
#include <set>
#include <string_view>
#include <utility>

namespace scpefe::format {
namespace {

[[noreturn]] void malformed() { throw RevisionFailure{RevisionError::malformed_cbor}; }
[[noreturn]] void unsupported() { throw RevisionFailure{RevisionError::unsupported_format}; }
[[noreturn]] void limited() { throw RevisionFailure{RevisionError::limit_exceeded}; }

RevisionId digest(std::string_view prefix, const std::uint8_t *data, std::size_t size)
{
    std::vector<std::uint8_t> input;
    const ClearBufferOnExit clear_input(input);
    input.reserve(prefix.size() + size);
    input.insert(input.end(), prefix.begin(), prefix.end());
    input.insert(input.end(), data, data + size);
    return blake2b_256(input.data(), input.size());
}

constexpr std::string_view content_prefix{"SCPEFE-CONTENT-V3\0", 18};
constexpr std::string_view body_prefix{"SCPEFE-BODY-V3\0", 15};
constexpr std::string_view id_prefix{"SCPEFE-REV-ID-V3\0", 17};

RevisionId read_id(CborReader &reader)
{
    const auto bytes = reader.bytes(32);
    RevisionId id{};
    std::copy(bytes.begin(), bytes.end(), id.begin());
    return id;
}

std::array<std::uint8_t, 16> read_slot(CborReader &reader)
{
    const auto bytes = reader.bytes(16);
    std::array<std::uint8_t, 16> id{};
    std::copy(bytes.begin(), bytes.end(), id.begin());
    return id;
}

std::uint64_t read_time(CborReader &reader)
{
    const auto value = reader.unsigned_integer();
    if (value > std::numeric_limits<std::int64_t>::max()) malformed();
    return value;
}

void key(CborReader &reader, std::uint64_t &previous, std::uint64_t expected)
{
    const auto found = reader.unsigned_integer();
    if (found != expected || found <= previous) malformed();
    previous = found;
}

std::uint64_t next_key(CborReader &reader, std::uint64_t &previous)
{
    const auto found = reader.unsigned_integer();
    if (found <= previous) malformed();
    previous = found;
    return found;
}

struct OwnerIdentity {
    std::array<std::uint8_t, 16> id{};
    std::string name, email;
};

struct ParsedSlots {
    OwnerIdentity owner;
    std::vector<RevisionSlot> slots;
};

ParsedSlots parse_slots(CborReader &reader)
{
    const auto count = reader.array(2);
    if (count < 1 || count > 9) malformed();
    std::set<std::array<std::uint8_t, 16>> ids, management_ids;
    bool recovery = false;
    ParsedSlots parsed;
    parsed.slots.reserve(count);
    for (std::size_t i = 0; i < count; ++i) {
        if (reader.map(3) != 7) malformed();
        std::uint64_t k = 0;
        key(reader, k, 1); auto slot = read_slot(reader);
        if (i == 0) parsed.owner.id = slot;
        key(reader, k, 2); auto permissions = reader.unsigned_integer();
        key(reader, k, 3); auto claim = reader.boolean();
        key(reader, k, 4); auto role = reader.unsigned_integer();
        key(reader, k, 5); auto management = read_slot(reader);
        key(reader, k, 6); auto name = reader.text();
        key(reader, k, 7); auto email = reader.text();
        if (i == 0) { parsed.owner.name = name; parsed.owner.email = email; }
        if (!ids.insert(slot).second || !management_ids.insert(management).second
            || permissions > 7 || role > 2 || (i == 0) != (role == 0)
            || (role == 2 && (recovery || i + 1 != count))
            || (role == 1 && recovery) || (role != 1 && permissions != 7)
            || (role != 1 && claim)
            || (role != 2 && (name.empty() || (!claim && email.empty())))) malformed();
        recovery |= role == 2;
        RevisionSlot semantic;
        semantic.id = slot;
        semantic.management_id = management;
        semantic.permissions = static_cast<std::uint8_t>(permissions);
        semantic.must_be_changed = claim;
        semantic.role = static_cast<std::uint8_t>(role);
        semantic.name = std::move(name);
        semantic.email = std::move(email);
        parsed.slots.push_back(std::move(semantic));
    }
    return parsed;
}

OwnerIdentity parse_owner(CborReader &reader)
{
    if (reader.map(2) != 3) malformed();
    std::uint64_t k = 0;
    OwnerIdentity owner;
    key(reader, k, 1); owner.id = read_slot(reader);
    key(reader, k, 2); owner.name = reader.text();
    key(reader, k, 3); owner.email = reader.text();
    if (owner.name.empty() || owner.email.empty()) malformed();
    return owner;
}

RevisionLease parse_lease(CborReader &reader)
{
    if (reader.map(2) != 8) malformed();
    std::uint64_t k = 0;
    RevisionLease lease;
    key(reader, k, 1); lease.active = reader.boolean();
    key(reader, k, 2); lease.session_id = read_slot(reader);
    key(reader, k, 3); lease.heartbeat_counter = reader.unsigned_integer();
    key(reader, k, 4); lease.holder_utc_ms = read_time(reader);
    key(reader, k, 5); lease.duration_ms = reader.unsigned_integer();
    key(reader, k, 6); lease.holder_name = reader.text();
    key(reader, k, 7); lease.holder_email = reader.text();
    key(reader, k, 8); lease.device = reader.text();
    if (lease.duration_ms == 0 || lease.duration_ms > std::numeric_limits<std::int64_t>::max()
        || (!lease.active && (lease.session_id != std::array<std::uint8_t, 16>{}
            || !lease.holder_name.empty() || !lease.holder_email.empty()
            || !lease.device.empty()))
        || (lease.active && (lease.session_id == std::array<std::uint8_t, 16>{}
            || lease.holder_name.empty() || lease.holder_email.empty()
            || lease.device.empty()))) malformed();
    return lease;
}

struct EventFacts {
    std::optional<RevisionId> cutoff;
    std::optional<std::uint64_t> count;
    std::optional<std::array<std::uint8_t, 16>> affected_slot;
    std::optional<std::uint8_t> activity_status;
    std::string detail;
};

EventFacts parse_event_details(CborReader &reader)
{
    const auto count = reader.map(4);
    EventFacts facts{};
    std::uint64_t previous = 0;
    for (std::size_t i = 0; i < count; ++i) {
        switch (next_key(reader, previous)) {
        case 1: facts.affected_slot = read_slot(reader); break;
        case 2: facts.cutoff = read_id(reader); break;
        case 3: facts.count = reader.unsigned_integer(); break;
        case 4: {
            const auto status = reader.unsigned_integer();
            if (status > 2) malformed();
            facts.activity_status = static_cast<std::uint8_t>(status);
            break;
        }
        case 5: facts.detail = reader.text(); break;
        default: unsupported();
        }
    }
    return facts;
}

void parse_immutable(CborReader &reader, const std::uint8_t *encoded,
    RevisionRecord &record, const RevisionLimits &limits)
{
    const auto begin = reader.position();
    const auto count = reader.map(4);
    if (count < 10 || count > 15) malformed();
    std::uint64_t previous_key = 0;
    bool has_kind = false, has_sources = false, has_time = false, has_slot = false;
    bool has_name = false, has_email = false, has_client = false, has_client_email = false;
    bool has_device = false, has_hash = false, has_event_type = false, has_event_details = false;
    EventFacts event_facts{};
    for (std::size_t i = 0; i < count; ++i) {
        switch (next_key(reader, previous_key)) {
        case 1: { const auto kind = reader.unsigned_integer(); if (kind > 2) unsupported();
            record.kind = static_cast<std::uint8_t>(kind); has_kind = true; break; }
        case 2: record.previous = read_id(reader); break;
        case 3: record.content_parent = read_id(reader); break;
        case 4: {
            const auto size = reader.array(5);
            if (size > limits.max_parent_count()) limited();
            for (std::size_t source = 0; source < size; ++source) {
                auto id = read_id(reader);
                if (!record.merge_sources.empty() && id <= record.merge_sources.back()) malformed();
                record.merge_sources.push_back(id);
            }
            has_sources = true; break;
        }
        case 5: record.timestamp_ms = read_time(reader); has_time = true; break;
        case 6: record.actor_slot = read_slot(reader); has_slot = true; break;
        case 7: record.actor_name = reader.text(); has_name = true; break;
        case 8: record.actor_email = reader.text(); has_email = true; break;
        case 9: record.client_name = reader.text(); has_client = true; break;
        case 10: record.client_email = reader.text(); has_client_email = true; break;
        case 11: record.device = reader.text(); has_device = true; break;
        case 12: record.content_hash = read_id(reader); has_hash = true; break;
        case 13: record.body_digest = read_id(reader); record.has_body_digest = true; break;
        case 14: record.event_type = reader.text(); has_event_type = true; break;
        case 15: {
            const auto start = reader.position();
            event_facts = parse_event_details(reader);
            record.event_details_cbor.assign(encoded + start, encoded + reader.position());
            has_event_details = true; break;
        }
        default: unsupported();
        }
    }
    if (!has_kind || !has_sources || !has_time || !has_slot || !has_name
        || !has_email || !has_client || !has_client_email || !has_device || !has_hash
        || record.actor_name.empty() || record.actor_email.empty()
        || record.client_name.empty() || record.client_email.empty() || record.device.empty()) malformed();
    if (record.kind == 0) {
        if (record.previous || record.content_parent || !record.merge_sources.empty()
            || !record.has_body_digest || has_event_type || has_event_details) malformed();
    } else if (record.kind == 1) {
        if (!record.previous || !record.content_parent || !record.has_body_digest
            || has_event_type || has_event_details) malformed();
    } else if (!record.previous || record.content_parent || record.has_body_digest
        || !record.merge_sources.empty() || !has_event_type || !has_event_details
        || record.event_type.empty()) malformed();
    if (record.event_type == "compaction" && (!event_facts.cutoff || !event_facts.count)) malformed();
    record.compaction_cutoff = event_facts.cutoff;
    record.retained_deltas = event_facts.count;
    record.affected_slot = event_facts.affected_slot;
    record.activity_status = event_facts.activity_status;
    record.event_detail = std::move(event_facts.detail);
    if (digest(id_prefix, encoded + begin, reader.position() - begin) != record.id) malformed();
    record.immutable_cbor.assign(encoded + begin, encoded + reader.position());
}

void parse_body(CborReader &reader, RevisionRecord &record, const RevisionLimits &limits)
{
    if (reader.array(5) != 3) malformed();
    if (reader.unsigned_integer() != 0) unsupported();
    record.body_length = reader.unsigned_integer();
    if (record.body_length > limits.max_text_bytes()) limited();
    if (record.storage == 1 || record.storage == 3) {
        auto bytes = reader.bytes(0, limits.max_text_bytes());
        const ClearBufferOnExit clear_bytes(bytes);
        if (bytes.size() != record.body_length) malformed();
        record.body_text.assign(bytes.begin(), bytes.end());
        if (!valid_canonical_document_text(record.body_text.data(), record.body_text.size())) malformed();
    } else {
        const auto count = reader.array(6);
        record.segments.reserve(count);
        std::uint64_t inserted = 0;
        for (std::size_t i = 0; i < count; ++i) {
            const auto fields = reader.array(7);
            const auto type = reader.unsigned_integer();
            RevisionRecord::Segment segment{};
            const ClearBufferOnExit clear_segment(segment.text);
            if (type == 0 && fields == 3) {
                segment.start = reader.unsigned_integer();
                segment.count = reader.unsigned_integer();
                if (segment.count == 0) malformed();
            } else if (type == 1 && fields == 2) {
                auto bytes = reader.bytes(0, limits.max_text_bytes());
                const ClearBufferOnExit clear_bytes(bytes);
                if (bytes.empty()) malformed();
                segment.insert = true;
                segment.text.assign(bytes.begin(), bytes.end());
                segment.count = bytes.size();
            } else unsupported();
            if (segment.count > record.body_length - inserted) malformed();
            inserted += segment.count;
            record.segments.push_back(segment);
        }
        if (inserted != record.body_length) malformed();
    }
}

RevisionRecord parse_record(CborReader &reader, const std::uint8_t *encoded,
    const RevisionLimits &limits)
{
    const auto record_start = reader.position();
    const auto fields = reader.map(3);
    if (fields < 3 || fields > 7) malformed();
    RevisionRecord record;
    std::uint64_t k = 0;
    key(reader, k, 1); record.id = read_id(reader);
    key(reader, k, 2); parse_immutable(reader, encoded, record, limits);
    key(reader, k, 3); const auto storage = reader.unsigned_integer();
    if (storage > 5) unsupported();
    record.storage = static_cast<std::uint8_t>(storage);
    bool body = false;
    for (std::size_t i = 3; i < fields; ++i) {
        switch (next_key(reader, k)) {
        case 4: {
            if (record.storage != 1 && record.storage != 2 && record.storage != 3) malformed();
            const auto begin = reader.position();
            parse_body(reader, record, limits);
            record.body_cbor.assign(encoded + begin, encoded + reader.position());
            if (record.storage != 3 && digest(body_prefix, encoded + begin,
                reader.position() - begin) != record.body_digest) malformed();
            body = true; break;
        }
        case 5: if (!reader.boolean()) malformed(); record.provisional = true; break;
        case 6: record.resolved_by = read_id(reader); break;
        case 7: if (!reader.boolean()) malformed(); record.foreign = true; break;
        default: unsupported();
        }
    }
    if (body != (record.storage >= 1 && record.storage <= 3)
        || (record.kind == 0 && record.storage != 1 && record.storage != 3
            && record.storage != 4 && record.storage != 5)
        || (record.kind == 1 && record.storage != 2 && record.storage != 3
            && record.storage != 4 && record.storage != 5)
        || (record.kind == 2 && record.storage != 0 && record.storage != 5)
        || (record.foreign != (record.storage == 5))
        || (record.foreign != record.resolved_by.has_value())
        || (record.foreign && record.provisional)
        || (record.kind == 2 && record.provisional)) malformed();
    record.record_cbor.assign(encoded + record_start, encoded + reader.position());
    return record;
}

std::optional<std::string> reconstruct_at(const std::vector<RevisionRecord> &records,
    std::size_t index, const RevisionLimits &limits)
{
    const auto &wanted = records[index];
    if (wanted.foreign || wanted.kind == 2) return std::nullopt;
    std::size_t anchor = index;
    while (records[anchor].storage != 1 && records[anchor].storage != 3) {
        if (records[anchor].storage != 2 || !records[anchor].content_parent) return std::nullopt;
        const auto parent = std::find_if(records.begin(), records.begin() + anchor,
            [&](const auto &r) { return r.id == *records[anchor].content_parent; });
        if (parent == records.begin() + anchor) malformed();
        anchor = static_cast<std::size_t>(parent - records.begin());
    }
    std::string text = records[anchor].body_text;
    const ClearBufferOnExit clear_text(text);
    for (std::size_t i = anchor + 1; i <= index; ++i) {
        const auto &record = records[i];
        if (record.foreign || record.kind == 2) continue;
        if (record.storage == 1 || record.storage == 3) {
            clear_text.clear(); text = record.body_text; continue;
        }
        if (record.storage == 4) return std::nullopt;
        if (record.storage != 2) malformed();
        std::string next;
        const ClearBufferOnExit clear_next(next);
        next.reserve(static_cast<std::size_t>(record.body_length));
        for (const auto &segment : record.segments) {
            if (segment.insert) next += segment.text;
            else {
                if (segment.start > text.size() || segment.count > text.size() - segment.start)
                    malformed();
                next.append(text, static_cast<std::size_t>(segment.start),
                    static_cast<std::size_t>(segment.count));
            }
        }
        if (next.size() != record.body_length || next.size() > limits.max_text_bytes()
            || !valid_canonical_document_text(next.data(), next.size())) malformed();
        text.swap(next);
        if (digest(content_prefix, reinterpret_cast<const std::uint8_t *>(text.data()),
            text.size()) != record.content_hash) malformed();
    }
    // Return an independent value so the scope guard always clears the source.
    return std::optional<std::string>(std::in_place, text);
}

std::string apply_delta(const RevisionRecord &record, const std::string &source,
    const RevisionLimits &limits)
{
    std::string next;
    const ClearBufferOnExit clear_next(next);
    next.reserve(static_cast<std::size_t>(record.body_length));
    for (const auto &segment : record.segments) {
        if (segment.insert) next += segment.text;
        else {
            if (segment.start > source.size()
                || segment.count > source.size() - segment.start) malformed();
            next.append(source, static_cast<std::size_t>(segment.start),
                static_cast<std::size_t>(segment.count));
        }
    }
    if (next.size() != record.body_length || next.size() > limits.max_text_bytes()
        || !valid_canonical_document_text(next.data(), next.size())) malformed();
    return std::string(next);
}

void validate_graph(std::vector<RevisionRecord> &records, const RevisionId &head,
    const RevisionId &content_head, const RevisionLimits &limits)
{
    if (records.empty()) malformed();
    std::map<RevisionId, std::size_t> seen;
    std::optional<RevisionId> previous, content;
    std::size_t canonical = 0;
    for (std::size_t i = 0; i < records.size(); ++i) {
        const auto &r = records[i];
        const auto before = [&](const std::optional<RevisionId> &id) {
            return !id || seen.find(*id) != seen.end();
        };
        if (!before(r.previous) || !before(r.content_parent)) malformed();
        for (const auto &source : r.merge_sources)
            if (seen.find(source) == seen.end()) malformed();
        if (!seen.emplace(r.id, i).second) malformed();
        if (r.foreign) {
            if (!r.resolved_by || r.kind == 0) malformed();
            continue;
        }
        if (canonical == 0) {
            if (r.kind != 0 || r.previous || r.content_parent) malformed();
        } else if (!r.previous || *r.previous != *previous || r.kind == 0) malformed();
        if (r.kind == 1) {
            if (!content || !r.content_parent || *r.content_parent != *content) malformed();
            for (const auto &source : r.merge_sources) {
                const auto &foreign = records[seen.at(source)];
                if (!foreign.foreign || foreign.resolved_by != r.id) malformed();
            }
        } else if (!r.merge_sources.empty()) malformed();
        if (r.kind == 2) {
            if (!content || r.content_hash != records[seen.at(*content)].content_hash) malformed();
        } else content = r.id;
        if (r.provisional && (i + 1 != records.size() || r.kind != 1)) malformed();
        previous = r.id;
        ++canonical;
    }
    if (!previous || !content || *previous != head || *content != content_head) malformed();
    for (const auto &r : records) {
        if (!r.foreign) continue;
        const auto merge = seen.find(*r.resolved_by);
        if (merge == seen.end() || merge->second <= seen.at(r.id)
            || records[merge->second].foreign || records[merge->second].kind != 1
            || records[merge->second].merge_sources.empty()) malformed();
        if (!r.previous || !seen.count(*r.previous)
            || (r.kind == 1 && (!r.content_parent || !seen.count(*r.content_parent)))) malformed();
    }
    // Imported records must form a closed path from each source back to the
    // shared canonical line; each import belongs to exactly one merge.
    for (const auto &merge : records) {
        if (merge.foreign || merge.merge_sources.empty()) continue;
        std::set<RevisionId> reachable;
        bool shared = false;
        std::vector<RevisionId> pending(merge.merge_sources.begin(), merge.merge_sources.end());
        while (!pending.empty()) {
            const auto id = pending.back();
            pending.pop_back();
            if (!reachable.insert(id).second) continue;
            const auto &r = records[seen.at(id)];
            if (!r.foreign || r.resolved_by != merge.id) {
                // An earlier merge may already have imported this same foreign ID.
                shared = true;
                continue;
            }
            if (r.previous) pending.push_back(*r.previous);
            if (r.content_parent) pending.push_back(*r.content_parent);
            pending.insert(pending.end(), r.merge_sources.begin(), r.merge_sources.end());
        }
        if (!shared) malformed();
        for (const auto &r : records)
            if (r.foreign && r.resolved_by == merge.id && !reachable.count(r.id)) malformed();
        for (const auto &source : merge.merge_sources)
            for (const auto &r : records)
                if (r.foreign && r.resolved_by == merge.id && r.id != source
                    && (r.previous == source || r.content_parent == source)) malformed();
    }
    // A single forward pass validates every retained body. Pruned history has
    // no clear text until a later materialized checkpoint restores the line.
    std::optional<std::string> current;
    const ClearBufferOnExit clear_current(current);
    for (std::size_t i = 0; i < records.size(); ++i) {
        auto &r = records[i];
        if (r.foreign) continue;
        if (r.kind == 2) { r.text_available = current.has_value(); continue; }
        if (r.storage == 4) { clear_current.clear(); current.reset(); continue; }
        if (r.storage == 1 || r.storage == 3) {
            clear_current.clear(); current = r.body_text;
        } else if (r.storage == 2 && current) {
            auto next = apply_delta(r, *current, limits);
            const ClearBufferOnExit clear_next(next);
            clear_current.clear(); current = next;
        } else malformed();
        if (digest(content_prefix, reinterpret_cast<const std::uint8_t *>(current->data()),
            current->size()) != r.content_hash) malformed();
        r.text_available = true;
    }
    if (!current) malformed();
    std::size_t latest_compaction = records.size();
    std::size_t prior_cutoff = 0;
    for (std::size_t event_index = 0; event_index < records.size(); ++event_index) {
        const auto &r = records[event_index];
        if (r.foreign || r.event_type != "compaction") continue;
        if (!r.compaction_cutoff || !r.retained_deltas) malformed();
        const auto cutoff = seen.find(*r.compaction_cutoff);
        if (cutoff == seen.end() || cutoff->second >= event_index
            || cutoff->second < prior_cutoff || records[cutoff->second].foreign
            || records[cutoff->second].kind == 2)
            malformed();
        std::size_t deltas = 0;
        for (std::size_t i = cutoff->second + 1; i < event_index; ++i)
            if (!records[i].foreign && records[i].kind == 1) ++deltas;
        if (deltas != *r.retained_deltas) malformed();
        latest_compaction = event_index;
        prior_cutoff = cutoff->second;
    }
    if (latest_compaction != records.size()) {
        const auto cutoff = seen.at(*records[latest_compaction].compaction_cutoff);
        if (records[cutoff].storage != 3) malformed();
        for (std::size_t i = 0; i < cutoff; ++i)
            if (!records[i].foreign && records[i].kind != 2
                && records[i].storage != 4) malformed();
    }
}

} // namespace

std::vector<std::uint8_t> RevisionGraph::create_baseline(const RevisionSlot &owner,
    const std::optional<RevisionSlot> &recovery, std::string_view device,
    std::string_view content, std::uint64_t timestamp_ms)
{
    const auto limits = RevisionLimits::defaults();
    if (timestamp_ms > std::numeric_limits<std::int64_t>::max()
        || content.size() > limits.max_text_bytes()
        || !valid_canonical_document_text(content.data(), content.size()))
        throw RevisionFailure{RevisionError::invalid_argument};
    CborWriter body;
    body.array(3); body.unsigned_integer(0);
    body.unsigned_integer(content.size());
    body.bytes(reinterpret_cast<const std::uint8_t *>(content.data()), content.size());
    const auto body_bytes = body.take_output();
    const auto content_hash = digest(content_prefix,
        reinterpret_cast<const std::uint8_t *>(content.data()), content.size());
    const auto body_digest = digest(body_prefix, body_bytes.data(), body_bytes.size());
    CborWriter immutable;
    immutable.map(11);
    immutable.unsigned_integer(1); immutable.unsigned_integer(0);
    immutable.unsigned_integer(4); immutable.array(0);
    immutable.unsigned_integer(5); immutable.unsigned_integer(timestamp_ms);
    immutable.unsigned_integer(6); immutable.bytes(owner.id.data(), owner.id.size());
    immutable.unsigned_integer(7); immutable.text(owner.name.data(), owner.name.size());
    immutable.unsigned_integer(8); immutable.text(owner.email.data(), owner.email.size());
    immutable.unsigned_integer(9); immutable.text(owner.name.data(), owner.name.size());
    immutable.unsigned_integer(10); immutable.text(owner.email.data(), owner.email.size());
    immutable.unsigned_integer(11); immutable.text(device.data(), device.size());
    immutable.unsigned_integer(12); immutable.bytes(content_hash.data(), content_hash.size());
    immutable.unsigned_integer(13); immutable.bytes(body_digest.data(), body_digest.size());
    const auto immutable_bytes = immutable.take_output();
    const auto head = digest(id_prefix, immutable_bytes.data(), immutable_bytes.size());
    const std::array<std::uint8_t, 16> zero{};
    CborWriter writer;
    writer.map(8);
    writer.unsigned_integer(1); writer.unsigned_integer(1);
    writer.unsigned_integer(2); writer.array(recovery ? 2 : 1);
    const auto slot = [&](const RevisionSlot &entry) {
        writer.map(7);
        writer.unsigned_integer(1); writer.bytes(entry.id.data(), entry.id.size());
        writer.unsigned_integer(2); writer.unsigned_integer(entry.permissions);
        writer.unsigned_integer(3); writer.boolean(entry.must_be_changed);
        writer.unsigned_integer(4); writer.unsigned_integer(entry.role);
        writer.unsigned_integer(5);
        writer.bytes(entry.management_id.data(), entry.management_id.size());
        writer.unsigned_integer(6); writer.text(entry.name.data(), entry.name.size());
        writer.unsigned_integer(7); writer.text(entry.email.data(), entry.email.size());
    };
    slot(owner);
    if (recovery) slot(*recovery);
    writer.unsigned_integer(3); writer.map(3);
    writer.unsigned_integer(1); writer.bytes(owner.id.data(), owner.id.size());
    writer.unsigned_integer(2); writer.text(owner.name.data(), owner.name.size());
    writer.unsigned_integer(3); writer.text(owner.email.data(), owner.email.size());
    writer.unsigned_integer(4); writer.map(8);
    writer.unsigned_integer(1); writer.boolean(false);
    writer.unsigned_integer(2); writer.bytes(zero.data(), zero.size());
    writer.unsigned_integer(3); writer.unsigned_integer(0);
    writer.unsigned_integer(4); writer.unsigned_integer(0);
    writer.unsigned_integer(5); writer.unsigned_integer(600000);
    writer.unsigned_integer(6); writer.text("", 0);
    writer.unsigned_integer(7); writer.text("", 0);
    writer.unsigned_integer(8); writer.text("", 0);
    writer.unsigned_integer(5); writer.array(1); writer.map(4);
    writer.unsigned_integer(1); writer.bytes(head.data(), head.size());
    writer.unsigned_integer(2); writer.raw(immutable_bytes.data(), immutable_bytes.size());
    writer.unsigned_integer(3); writer.unsigned_integer(1);
    writer.unsigned_integer(4); writer.raw(body_bytes.data(), body_bytes.size());
    writer.unsigned_integer(6); writer.bytes(head.data(), head.size());
    writer.unsigned_integer(7); writer.bytes(head.data(), head.size());
    writer.unsigned_integer(8); writer.array(0);
    auto encoded = writer.take_output();
    (void)RevisionGraph::decode(encoded.data(), encoded.size(), limits);
    return encoded;
}

RevisionGraph RevisionGraph::decode(const std::uint8_t *bytes, std::size_t size,
    const RevisionLimits &limits)
{
    if (!bytes || size == 0) throw RevisionFailure{RevisionError::invalid_argument};
    if (size > limits.max_input_bytes()) limited();
    CborReader reader(bytes, size, limits);
    const auto fields = reader.map(1);
    if (fields != 8 && fields != 9) malformed();
    std::uint64_t k = 0;
    key(reader, k, 1); if (reader.unsigned_integer() != 1) unsupported();
    RevisionGraph graph;
    key(reader, k, 2); auto field_start = reader.position();
    auto parsed_slots = parse_slots(reader);
    graph.field_ranges_[2] = {field_start, reader.position() - field_start};
    key(reader, k, 3);
    field_start = reader.position();
    const auto owner = parse_owner(reader);
    graph.field_ranges_[3] = {field_start, reader.position() - field_start};
    if (owner.id != parsed_slots.owner.id || owner.name != parsed_slots.owner.name
        || owner.email != parsed_slots.owner.email) malformed();
    key(reader, k, 4); field_start = reader.position();
    auto lease = parse_lease(reader);
    graph.field_ranges_[4] = {field_start, reader.position() - field_start};
    key(reader, k, 5);
    const auto count = reader.array(2);
    if (count == 0) malformed();
    graph.records_.reserve(count);
    for (std::size_t i = 0; i < count; ++i)
        graph.records_.push_back(parse_record(reader, bytes, limits));
    key(reader, k, 6); graph.head_ = read_id(reader);
    key(reader, k, 7); graph.content_head_ = read_id(reader);
    key(reader, k, 8);
    field_start = reader.position();
    const auto feature_count = reader.array(2);
    if (feature_count != 0) unsupported();
    graph.field_ranges_[8] = {field_start, reader.position() - field_start};
    if (fields == 9) {
        key(reader, k, 9);
        field_start = reader.position();
        const auto extension_count = reader.map(2);
        std::uint64_t previous = 999;
        for (std::size_t i = 0; i < extension_count; ++i) {
            const auto extension_key = reader.unsigned_integer();
            if (extension_key <= previous) malformed();
            previous = extension_key;
            reader.skip_extension(3);
        }
        graph.field_ranges_[9] = {field_start, reader.position() - field_start};
    }
    if (!reader.finished()) malformed();
    validate_graph(graph.records_, graph.head_, graph.content_head_, limits);
    graph.slots_ = std::move(parsed_slots.slots);
    graph.lease_ = std::move(lease);
    graph.max_text_bytes_ = limits.max_text_bytes();
    graph.encoded_.assign(bytes, bytes + size);
    return graph;
}

const RevisionRecord *RevisionGraph::find(const RevisionId &id) const
{
    const auto it = std::find_if(records_.begin(), records_.end(),
        [&](const auto &record) { return record.id == id; });
    return it == records_.end() ? nullptr : &*it;
}

TargetLineage RevisionGraph::assess_target(const RevisionGraph &target) const
{
    if (head_ == target.head_) return TargetLineage::unchanged;
    if (const auto *present = target.find(head_); present && !present->foreign)
        return TargetLineage::advanced;
    if (find(target.head_))
        throw MergeFailure{MergeProblem::rollback};
    bool related = false;
    for (const auto &record : target.records_) {
        const auto *same = find(record.id);
        if (!same) continue;
        if (same->immutable_cbor != record.immutable_cbor) malformed();
        if (!same->foreign && !record.foreign) related = true;
    }
    if (!related) throw MergeFailure{MergeProblem::unrelated_target};
    return TargetLineage::divergent;
}

std::vector<std::uint8_t> RevisionGraph::replace_lease(const RevisionLease &lease) const
{
    CborWriter writer;
    writer.map(field_ranges_[9].second ? 9 : 8);
    writer.unsigned_integer(1); writer.unsigned_integer(1);
    const auto field = [&](unsigned key) {
        const auto [offset, length] = field_ranges_[key];
        writer.unsigned_integer(key);
        writer.raw(encoded_.data() + offset, length);
    };
    field(2); field(3);
    writer.unsigned_integer(4); writer.map(8);
    writer.unsigned_integer(1); writer.boolean(lease.active);
    writer.unsigned_integer(2); writer.bytes(lease.session_id.data(), lease.session_id.size());
    writer.unsigned_integer(3); writer.unsigned_integer(lease.heartbeat_counter);
    writer.unsigned_integer(4); writer.unsigned_integer(lease.holder_utc_ms);
    writer.unsigned_integer(5); writer.unsigned_integer(lease.duration_ms);
    writer.unsigned_integer(6); writer.text(lease.holder_name.data(), lease.holder_name.size());
    writer.unsigned_integer(7); writer.text(lease.holder_email.data(), lease.holder_email.size());
    writer.unsigned_integer(8); writer.text(lease.device.data(), lease.device.size());
    writer.unsigned_integer(5); writer.array(records_.size());
    for (const auto &record : records_)
        writer.raw(record.record_cbor.data(), record.record_cbor.size());
    writer.unsigned_integer(6); writer.bytes(head_.data(), head_.size());
    writer.unsigned_integer(7); writer.bytes(content_head_.data(), content_head_.size());
    field(8);
    if (field_ranges_[9].second) field(9);
    auto encoded = writer.take_output();
    (void)RevisionGraph::decode(encoded.data(), encoded.size(), RevisionLimits::defaults());
    return encoded;
}

std::optional<std::string> RevisionGraph::reconstruct(const RevisionId &id) const
{
    const auto it = std::find_if(records_.begin(), records_.end(),
        [&](const auto &record) { return record.id == id; });
    if (it == records_.end()) return std::nullopt;
    if (it->kind == 2 && !it->foreign) {
        auto current = it;
        while (current != records_.begin()) {
            --current;
            if (!current->foreign && current->kind != 2)
                return reconstruct_at(records_, current - records_.begin(),
                    RevisionLimits(encode().size(), 8, records_.size(), max_text_bytes_,
                        max_text_bytes_, 8));
        }
        return std::nullopt;
    }
    return reconstruct_at(records_, it - records_.begin(),
        RevisionLimits(encode().size(), 8, records_.size(), max_text_bytes_,
            max_text_bytes_, 8));
}

std::optional<std::string> RevisionGraph::compare(const RevisionId &before_id,
    const RevisionId &after_id) const
{
    const auto before = reconstruct(before_id);
    const auto after = reconstruct(after_id);
    if (!before || !after) return std::nullopt;
    if (*before == *after) return std::string{"No content change\n"};
    std::string result = "--- before\n+++ after\n@@\n";
    const auto append = [&](const std::string &text, char marker) {
        std::size_t start = 0;
        while (start < text.size()) {
            const auto end = text.find('\n', start);
            result.push_back(marker);
            result.append(text, start, end == std::string::npos
                ? text.size() - start : end + 1 - start);
            if (end == std::string::npos) { result.push_back('\n'); break; }
            start = end + 1;
        }
    };
    append(*before, '-');
    append(*after, '+');
    return result;
}

std::vector<std::uint8_t> RevisionGraph::save_content(std::string_view content,
    std::string_view profile_name, std::string_view profile_email,
    std::string_view device, const RevisionSlot &actor,
    std::uint64_t timestamp_ms, bool regular, bool discard) const
{
    const auto limits = RevisionLimits::defaults();
    if (timestamp_ms > std::numeric_limits<std::int64_t>::max()
        || content.size() > limits.max_text_bytes()
        || !valid_canonical_document_text(content.data(), content.size()))
        throw RevisionFailure{RevisionError::invalid_argument};
    std::size_t retained = records_.size();
    const bool provisional = records_.back().provisional;
    if (discard && !provisional)
        throw RevisionFailure{RevisionError::invalid_argument};
    RevisionId new_head = head_, new_content_head = content_head_;
    std::vector<std::uint8_t> new_record;
    if (provisional) {
        --retained;
        new_head = records_.back().previous.value();
        new_content_head = records_.back().content_parent.value();
    }
    if (!discard) {
        if (provisional && !regular && content == reconstruct(content_head_).value()
            && timestamp_ms == records_.back().timestamp_ms
            && actor.id == records_.back().actor_slot
            && actor.name == records_.back().actor_name
            && actor.email == records_.back().actor_email
            && profile_name == records_.back().client_name
            && profile_email == records_.back().client_email
            && device == records_.back().device) {
            CborWriter record;
            record.map(4);
            record.unsigned_integer(1); record.bytes(records_.back().id.data(), 32);
            record.unsigned_integer(2); record.raw(records_.back().immutable_cbor.data(),
                records_.back().immutable_cbor.size());
            record.unsigned_integer(3); record.unsigned_integer(records_.back().storage);
            record.unsigned_integer(4); record.raw(records_.back().body_cbor.data(),
                records_.back().body_cbor.size());
            new_record = record.take_output();
            new_head = new_content_head = records_.back().id;
        } else {
            CborWriter body;
            body.array(3); body.unsigned_integer(0);
            body.unsigned_integer(content.size());
            body.array(content.empty() ? 0 : 1);
            if (!content.empty()) {
                body.array(2); body.unsigned_integer(1);
                body.bytes(reinterpret_cast<const std::uint8_t *>(content.data()),
                    content.size());
            }
            const auto body_bytes = body.take_output();
            const auto content_hash = digest(content_prefix,
                reinterpret_cast<const std::uint8_t *>(content.data()), content.size());
            const auto body_digest = digest(body_prefix, body_bytes.data(), body_bytes.size());
            CborWriter immutable;
            immutable.map(13);
            immutable.unsigned_integer(1); immutable.unsigned_integer(1);
            immutable.unsigned_integer(2); immutable.bytes(new_head.data(), 32);
            immutable.unsigned_integer(3); immutable.bytes(new_content_head.data(), 32);
            immutable.unsigned_integer(4); immutable.array(0);
            immutable.unsigned_integer(5); immutable.unsigned_integer(timestamp_ms);
            immutable.unsigned_integer(6); immutable.bytes(actor.id.data(), actor.id.size());
            const auto actor_name = actor.name.empty() ? profile_name
                : std::string_view(actor.name);
            const auto actor_email = actor.email.empty() ? profile_email
                : std::string_view(actor.email);
            immutable.unsigned_integer(7); immutable.text(actor_name.data(), actor_name.size());
            immutable.unsigned_integer(8); immutable.text(actor_email.data(), actor_email.size());
            immutable.unsigned_integer(9); immutable.text(profile_name.data(), profile_name.size());
            immutable.unsigned_integer(10); immutable.text(profile_email.data(), profile_email.size());
            immutable.unsigned_integer(11); immutable.text(device.data(), device.size());
            immutable.unsigned_integer(12); immutable.bytes(content_hash.data(), 32);
            immutable.unsigned_integer(13); immutable.bytes(body_digest.data(), 32);
            const auto immutable_bytes = immutable.take_output();
            const auto id = digest(id_prefix, immutable_bytes.data(), immutable_bytes.size());
            CborWriter record;
            record.map(regular ? 5 : 4);
            record.unsigned_integer(1); record.bytes(id.data(), id.size());
            record.unsigned_integer(2); record.raw(immutable_bytes.data(), immutable_bytes.size());
            record.unsigned_integer(3); record.unsigned_integer(2);
            record.unsigned_integer(4); record.raw(body_bytes.data(), body_bytes.size());
            if (regular) { record.unsigned_integer(5); record.boolean(true); }
            new_record = record.take_output();
            new_head = new_content_head = id;
        }
    }
    CborWriter writer;
    writer.map(field_ranges_[9].second ? 9 : 8);
    writer.unsigned_integer(1); writer.unsigned_integer(1);
    const auto field = [&](unsigned key) {
        const auto [offset, length] = field_ranges_[key];
        writer.unsigned_integer(key);
        writer.raw(encoded_.data() + offset, length);
    };
    field(2); field(3); field(4);
    writer.unsigned_integer(5); writer.array(retained + (discard ? 0 : 1));
    for (std::size_t i = 0; i < retained; ++i)
        writer.raw(records_[i].record_cbor.data(), records_[i].record_cbor.size());
    if (!discard) writer.raw(new_record.data(), new_record.size());
    writer.unsigned_integer(6); writer.bytes(new_head.data(), new_head.size());
    writer.unsigned_integer(7); writer.bytes(new_content_head.data(), new_content_head.size());
    field(8);
    if (field_ranges_[9].second) field(9);
    auto encoded = writer.take_output();
    (void)RevisionGraph::decode(encoded.data(), encoded.size(), limits);
    return encoded;
}

std::vector<std::uint8_t> RevisionGraph::merge_with(
    const RevisionGraph &target, std::string_view content,
    std::string_view profile_name, std::string_view profile_email,
    std::string_view device, const RevisionSlot &actor,
    std::uint64_t timestamp_ms) const
{
    const auto limits = RevisionLimits::defaults();
    if (records_.back().provisional || target.records_.back().provisional
        || timestamp_ms > std::numeric_limits<std::int64_t>::max()
        || content.size() > limits.max_text_bytes()
        || !valid_canonical_document_text(content.data(), content.size())
        || profile_name.empty() || profile_email.empty() || device.empty())
        throw RevisionFailure{RevisionError::invalid_argument};
    const auto active = std::find_if(target.slots_.begin(), target.slots_.end(),
        [&](const auto &slot) { return slot.id == actor.id; });
    if (active == target.slots_.end() || !active->permissions
        || !(active->permissions & 1u) || active->must_be_changed)
        throw RevisionFailure{RevisionError::invalid_argument};
    if (assess_target(target) != TargetLineage::divergent)
        throw RevisionFailure{RevisionError::invalid_argument};

    std::set<RevisionId> local_ids;
    for (const auto &record : records_) local_ids.insert(record.id);
    std::optional<RevisionId> base;
    for (const auto &record : target.records_) {
        if (!local_ids.count(record.id)) continue;
        const auto *same = find(record.id);
        if (!same || same->immutable_cbor != record.immutable_cbor) malformed();
        if (!same->foreign && !record.foreign && record.kind != 2)
            base = record.id;
    }
    if (!base) throw MergeFailure{MergeProblem::unrelated_target};
    if (!reconstruct(*base) && !target.reconstruct(*base))
        throw MergeFailure{MergeProblem::unavailable_base};

    const auto local_text = reconstruct(content_head_);
    if (!local_text) throw MergeFailure{MergeProblem::unavailable_base};
    CborWriter body;
    body.array(3); body.unsigned_integer(0);
    body.unsigned_integer(content.size());
    std::size_t prefix = 0;
    while (prefix < local_text->size() && prefix < content.size()
        && (*local_text)[prefix] == content[prefix]) ++prefix;
    std::size_t suffix = 0;
    while (suffix < local_text->size() - prefix && suffix < content.size() - prefix
        && (*local_text)[local_text->size() - suffix - 1]
            == content[content.size() - suffix - 1]) ++suffix;
    const auto inserted = content.size() - prefix - suffix;
    body.array((prefix ? 1 : 0) + (inserted ? 1 : 0) + (suffix ? 1 : 0));
    if (prefix) {
        body.array(3); body.unsigned_integer(0);
        body.unsigned_integer(0); body.unsigned_integer(prefix);
    }
    if (inserted) {
        body.array(2); body.unsigned_integer(1);
        body.bytes(reinterpret_cast<const std::uint8_t *>(content.data() + prefix),
            inserted);
    }
    if (suffix) {
        body.array(3); body.unsigned_integer(0);
        body.unsigned_integer(local_text->size() - suffix);
        body.unsigned_integer(suffix);
    }
    const auto body_bytes = body.take_output();
    const auto content_hash = digest(content_prefix,
        reinterpret_cast<const std::uint8_t *>(content.data()), content.size());
    const auto body_digest = digest(body_prefix, body_bytes.data(), body_bytes.size());
    CborWriter immutable;
    immutable.map(13);
    immutable.unsigned_integer(1); immutable.unsigned_integer(1);
    immutable.unsigned_integer(2); immutable.bytes(head_.data(), head_.size());
    immutable.unsigned_integer(3); immutable.bytes(content_head_.data(), content_head_.size());
    immutable.unsigned_integer(4); immutable.array(1);
    immutable.bytes(target.head_.data(), target.head_.size());
    immutable.unsigned_integer(5); immutable.unsigned_integer(timestamp_ms);
    immutable.unsigned_integer(6); immutable.bytes(actor.id.data(), actor.id.size());
    const auto actor_name = actor.name.empty() ? profile_name
        : std::string_view(actor.name);
    const auto actor_email = actor.email.empty() ? profile_email
        : std::string_view(actor.email);
    immutable.unsigned_integer(7); immutable.text(actor_name.data(), actor_name.size());
    immutable.unsigned_integer(8); immutable.text(actor_email.data(), actor_email.size());
    immutable.unsigned_integer(9); immutable.text(profile_name.data(), profile_name.size());
    immutable.unsigned_integer(10); immutable.text(profile_email.data(), profile_email.size());
    immutable.unsigned_integer(11); immutable.text(device.data(), device.size());
    immutable.unsigned_integer(12); immutable.bytes(content_hash.data(), 32);
    immutable.unsigned_integer(13); immutable.bytes(body_digest.data(), 32);
    const auto immutable_bytes = immutable.take_output();
    const auto id = digest(id_prefix, immutable_bytes.data(), immutable_bytes.size());
    CborWriter merge_record;
    merge_record.map(4);
    merge_record.unsigned_integer(1); merge_record.bytes(id.data(), id.size());
    merge_record.unsigned_integer(2);
    merge_record.raw(immutable_bytes.data(), immutable_bytes.size());
    merge_record.unsigned_integer(3); merge_record.unsigned_integer(2);
    merge_record.unsigned_integer(4);
    merge_record.raw(body_bytes.data(), body_bytes.size());
    const auto merge_bytes = merge_record.take_output();

    CborWriter writer;
    writer.map(field_ranges_[9].second ? 9 : 8);
    writer.unsigned_integer(1); writer.unsigned_integer(1);
    const auto field = [&](const RevisionGraph &graph, unsigned key) {
        const auto [offset, length] = graph.field_ranges_[key];
        writer.unsigned_integer(key);
        writer.raw(graph.encoded_.data() + offset, length);
    };
    field(target, 2); field(target, 3); field(target, 4);
    const auto imported = std::count_if(target.records_.begin(), target.records_.end(),
        [&](const auto &record) { return !local_ids.count(record.id); });
    writer.unsigned_integer(5); writer.array(records_.size() + imported + 1);
    for (const auto &record : records_)
        writer.raw(record.record_cbor.data(), record.record_cbor.size());
    for (const auto &record : target.records_) {
        if (local_ids.count(record.id)) continue;
        writer.map(5);
        writer.unsigned_integer(1); writer.bytes(record.id.data(), record.id.size());
        writer.unsigned_integer(2);
        writer.raw(record.immutable_cbor.data(), record.immutable_cbor.size());
        writer.unsigned_integer(3); writer.unsigned_integer(5);
        writer.unsigned_integer(6); writer.bytes(id.data(), id.size());
        writer.unsigned_integer(7); writer.boolean(true);
    }
    writer.raw(merge_bytes.data(), merge_bytes.size());
    writer.unsigned_integer(6); writer.bytes(id.data(), id.size());
    writer.unsigned_integer(7); writer.bytes(id.data(), id.size());
    field(*this, 8);
    if (field_ranges_[9].second) field(*this, 9);
    auto encoded = writer.take_output();
    (void)RevisionGraph::decode(encoded.data(), encoded.size(), limits);
    return encoded;
}

std::vector<std::uint8_t> RevisionGraph::compact_at(std::size_t content_cutoff,
    const RevisionSlot &actor, std::string_view client_name,
    std::string_view client_email, std::string_view device,
    std::uint64_t timestamp_ms) const
{
    const auto limits = RevisionLimits::defaults();
    if (records_.back().provisional || timestamp_ms > std::numeric_limits<std::int64_t>::max()
        || client_name.empty() || client_email.empty() || device.empty()
        || (actor.permissions & 7u) != 7u || actor.must_be_changed)
        throw RevisionFailure{RevisionError::invalid_argument};
    const auto member = std::find_if(slots_.begin(), slots_.end(),
        [&](const auto &slot) { return slot.id == actor.id; });
    if (member == slots_.end() || member->permissions != actor.permissions
        || member->must_be_changed)
        throw RevisionFailure{RevisionError::invalid_argument};

    std::vector<std::size_t> content_indices;
    for (std::size_t i = 0; i < records_.size(); ++i)
        if (!records_[i].foreign && records_[i].kind != 2)
            content_indices.push_back(i);
    if (content_cutoff >= content_indices.size())
        throw RevisionFailure{RevisionError::invalid_argument};
    const auto cutoff = content_indices[content_cutoff];
    const auto text = reconstruct(records_[cutoff].id);
    if (!text) throw RevisionFailure{RevisionError::invalid_argument};

    CborWriter checkpoint;
    checkpoint.array(3); checkpoint.unsigned_integer(0);
    checkpoint.unsigned_integer(text->size());
    checkpoint.bytes(reinterpret_cast<const std::uint8_t *>(text->data()), text->size());
    const auto checkpoint_bytes = checkpoint.take_output();
    const auto retained_deltas = content_indices.size() - content_cutoff - 1;
    CborWriter details;
    details.map(2);
    details.unsigned_integer(2); details.bytes(records_[cutoff].id.data(), 32);
    details.unsigned_integer(3); details.unsigned_integer(retained_deltas);
    const auto detail_bytes = details.take_output();
    CborWriter immutable;
    immutable.map(13);
    immutable.unsigned_integer(1); immutable.unsigned_integer(2);
    immutable.unsigned_integer(2); immutable.bytes(head_.data(), 32);
    immutable.unsigned_integer(4); immutable.array(0);
    immutable.unsigned_integer(5); immutable.unsigned_integer(timestamp_ms);
    immutable.unsigned_integer(6); immutable.bytes(actor.id.data(), actor.id.size());
    const auto actor_name = actor.name.empty() ? client_name : std::string_view(actor.name);
    const auto actor_email = actor.email.empty() ? client_email : std::string_view(actor.email);
    immutable.unsigned_integer(7); immutable.text(actor_name.data(), actor_name.size());
    immutable.unsigned_integer(8); immutable.text(actor_email.data(), actor_email.size());
    immutable.unsigned_integer(9); immutable.text(client_name.data(), client_name.size());
    immutable.unsigned_integer(10); immutable.text(client_email.data(), client_email.size());
    immutable.unsigned_integer(11); immutable.text(device.data(), device.size());
    immutable.unsigned_integer(12); immutable.bytes(records_.back().content_hash.data(), 32);
    immutable.unsigned_integer(14); immutable.text("compaction", 10);
    immutable.unsigned_integer(15); immutable.raw(detail_bytes.data(), detail_bytes.size());
    const auto immutable_bytes = immutable.take_output();
    const auto event_id = digest(id_prefix, immutable_bytes.data(), immutable_bytes.size());

    CborWriter writer;
    writer.map(field_ranges_[9].second ? 9 : 8);
    writer.unsigned_integer(1); writer.unsigned_integer(1);
    const auto field = [&](unsigned key) {
        const auto [offset, length] = field_ranges_[key];
        writer.unsigned_integer(key); writer.raw(encoded_.data() + offset, length);
    };
    field(2); field(3); field(4);
    writer.unsigned_integer(5); writer.array(records_.size() + 1);
    for (std::size_t i = 0; i < records_.size(); ++i) {
        const auto &record = records_[i];
        if (record.foreign || record.kind == 2 || i > cutoff) {
            writer.raw(record.record_cbor.data(), record.record_cbor.size());
            continue;
        }
        const bool anchor = i == cutoff;
        writer.map(anchor ? 4 : 3);
        writer.unsigned_integer(1); writer.bytes(record.id.data(), 32);
        writer.unsigned_integer(2);
        writer.raw(record.immutable_cbor.data(), record.immutable_cbor.size());
        writer.unsigned_integer(3); writer.unsigned_integer(anchor ? 3 : 4);
        if (anchor) {
            writer.unsigned_integer(4);
            writer.raw(checkpoint_bytes.data(), checkpoint_bytes.size());
        }
    }
    writer.map(3);
    writer.unsigned_integer(1); writer.bytes(event_id.data(), event_id.size());
    writer.unsigned_integer(2); writer.raw(immutable_bytes.data(), immutable_bytes.size());
    writer.unsigned_integer(3); writer.unsigned_integer(0);
    writer.unsigned_integer(6); writer.bytes(event_id.data(), event_id.size());
    writer.unsigned_integer(7); writer.bytes(content_head_.data(), content_head_.size());
    field(8);
    if (field_ranges_[9].second) field(9);
    auto encoded = writer.take_output();
    (void)RevisionGraph::decode(encoded.data(), encoded.size(), limits);
    return encoded;
}

std::vector<std::uint8_t> RevisionGraph::append_slot_event(
    const std::vector<RevisionSlot> &slots, const RevisionSlot &actor,
    const std::array<std::uint8_t, 16> &affected_slot,
    std::string_view event_type, std::string_view event_detail,
    std::string_view client_name, std::string_view client_email,
    std::string_view device, std::uint64_t timestamp_ms) const
{
    return append_event(slots, actor, affected_slot, event_type, event_detail,
        std::nullopt, client_name, client_email, device, timestamp_ms);
}

std::vector<std::uint8_t> RevisionGraph::append_activity_event(
    const RevisionSlot &actor, std::string_view event_type,
    std::string_view event_detail, std::uint8_t activity_status,
    std::string_view client_name, std::string_view client_email,
    std::string_view device, std::uint64_t timestamp_ms) const
{
    if (activity_status > 2)
        throw RevisionFailure{RevisionError::invalid_argument};
    return append_event(slots_, actor, actor.id, event_type, event_detail,
        activity_status, client_name, client_email, device, timestamp_ms);
}

std::vector<std::uint8_t> RevisionGraph::append_event(
    const std::vector<RevisionSlot> &slots, const RevisionSlot &actor,
    const std::array<std::uint8_t, 16> &affected_slot,
    std::string_view event_type, std::string_view event_detail,
    std::optional<std::uint8_t> activity_status,
    std::string_view client_name, std::string_view client_email,
    std::string_view device, std::uint64_t timestamp_ms) const
{
    if (records_.back().provisional || slots.empty() || slots.size() > 9
        || event_type.empty() || timestamp_ms > std::numeric_limits<std::int64_t>::max())
        throw RevisionFailure{RevisionError::invalid_argument};
    CborWriter details;
    details.map(1 + (activity_status ? 1 : 0) + (event_detail.empty() ? 0 : 1));
    details.unsigned_integer(1); details.bytes(affected_slot.data(), affected_slot.size());
    if (activity_status) {
        details.unsigned_integer(4); details.unsigned_integer(*activity_status);
    }
    if (!event_detail.empty()) {
        details.unsigned_integer(5); details.text(event_detail.data(), event_detail.size());
    }
    const auto detail_bytes = details.take_output();
    CborWriter immutable;
    immutable.map(13);
    immutable.unsigned_integer(1); immutable.unsigned_integer(2);
    immutable.unsigned_integer(2); immutable.bytes(head_.data(), head_.size());
    immutable.unsigned_integer(4); immutable.array(0);
    immutable.unsigned_integer(5); immutable.unsigned_integer(timestamp_ms);
    immutable.unsigned_integer(6); immutable.bytes(actor.id.data(), actor.id.size());
    const auto actor_name = actor.name.empty() ? client_name : std::string_view(actor.name);
    const auto actor_email = actor.email.empty() ? client_email : std::string_view(actor.email);
    immutable.unsigned_integer(7); immutable.text(actor_name.data(), actor_name.size());
    immutable.unsigned_integer(8); immutable.text(actor_email.data(), actor_email.size());
    immutable.unsigned_integer(9); immutable.text(client_name.data(), client_name.size());
    immutable.unsigned_integer(10); immutable.text(client_email.data(), client_email.size());
    immutable.unsigned_integer(11); immutable.text(device.data(), device.size());
    immutable.unsigned_integer(12); immutable.bytes(records_.back().content_hash.data(), 32);
    immutable.unsigned_integer(14); immutable.text(event_type.data(), event_type.size());
    immutable.unsigned_integer(15); immutable.raw(detail_bytes.data(), detail_bytes.size());
    const auto immutable_bytes = immutable.take_output();
    const auto id = digest(id_prefix, immutable_bytes.data(), immutable_bytes.size());
    CborWriter record;
    record.map(3);
    record.unsigned_integer(1); record.bytes(id.data(), id.size());
    record.unsigned_integer(2); record.raw(immutable_bytes.data(), immutable_bytes.size());
    record.unsigned_integer(3); record.unsigned_integer(0);
    const auto record_bytes = record.take_output();
    CborWriter writer;
    writer.map(field_ranges_[9].second ? 9 : 8);
    writer.unsigned_integer(1); writer.unsigned_integer(1);
    writer.unsigned_integer(2); writer.array(slots.size());
    for (const auto &slot : slots) {
        writer.map(7);
        writer.unsigned_integer(1); writer.bytes(slot.id.data(), slot.id.size());
        writer.unsigned_integer(2); writer.unsigned_integer(slot.permissions);
        writer.unsigned_integer(3); writer.boolean(slot.must_be_changed);
        writer.unsigned_integer(4); writer.unsigned_integer(slot.role);
        writer.unsigned_integer(5); writer.bytes(slot.management_id.data(), slot.management_id.size());
        writer.unsigned_integer(6); writer.text(slot.name.data(), slot.name.size());
        writer.unsigned_integer(7); writer.text(slot.email.data(), slot.email.size());
    }
    writer.unsigned_integer(3); writer.map(3);
    writer.unsigned_integer(1); writer.bytes(slots.front().id.data(), 16);
    writer.unsigned_integer(2); writer.text(slots.front().name.data(), slots.front().name.size());
    writer.unsigned_integer(3); writer.text(slots.front().email.data(), slots.front().email.size());
    const auto field = [&](unsigned key) {
        const auto [offset, length] = field_ranges_[key];
        writer.unsigned_integer(key); writer.raw(encoded_.data() + offset, length);
    };
    field(4);
    writer.unsigned_integer(5); writer.array(records_.size() + 1);
    for (const auto &old : records_)
        writer.raw(old.record_cbor.data(), old.record_cbor.size());
    writer.raw(record_bytes.data(), record_bytes.size());
    writer.unsigned_integer(6); writer.bytes(id.data(), id.size());
    writer.unsigned_integer(7); writer.bytes(content_head_.data(), content_head_.size());
    field(8);
    if (field_ranges_[9].second) field(9);
    auto encoded = writer.take_output();
    (void)RevisionGraph::decode(encoded.data(), encoded.size(), RevisionLimits::defaults());
    return encoded;
}

RevisionRecord::~RevisionRecord()
{
    const auto clear = [](auto &value) { clear_memory(value.data(), value.size()); };
    clear(body_text); clear(body_cbor); clear(record_cbor);
    clear(immutable_cbor); clear(event_details_cbor);
    clear(actor_name); clear(actor_email); clear(client_name); clear(client_email);
    clear(device); clear(event_type); clear(event_detail);
    for (auto &segment : segments) clear(segment.text);
}

RevisionGraph::~RevisionGraph()
{
    const auto clear = [](auto &value) { clear_memory(value.data(), value.size()); };
    clear(encoded_);
    for (auto &slot : slots_) { clear(slot.name); clear(slot.email); }
    clear(lease_.holder_name); clear(lease_.holder_email); clear(lease_.device);
}

std::string RevisionGraph::diagnostic_json(bool include_content) const
{
    DiagnosticJsonWriter json;
    write_diagnostic_json(json, include_content);
    return json.take_output();
}

void RevisionGraph::write_diagnostic_json(DiagnosticJsonWriter &json,
    bool include_content) const
{
    if (include_content) {
        // A tiny copy delta can repeat a large text in every displayed record.
        // Reject that expansion before reconstructing any historical text.
        std::size_t minimum_content_bytes = 0;
        for (const auto &record : records_) {
            if (record.foreign || record.kind == 2 || !record.text_available) continue;
            if (record.body_length > DiagnosticJsonWriter::max_output_bytes
                - minimum_content_bytes)
                throw RevisionFailure{RevisionError::limit_exceeded};
            minimum_content_bytes += static_cast<std::size_t>(record.body_length);
        }
    }
    json.raw("{\"schema\":\"container-v3\",\"format_version\":1,\"validation\":\"valid\",\"head\":");
    json.hex(head_.data(), head_.size());
    json.raw(",\"content_head\":");
    json.hex(content_head_.data(), content_head_.size());
    json.raw(",\"record_count\":" + std::to_string(records_.size())
        + ",\"encoded_bytes\":" + std::to_string(encoded_.size())
        + ",\"required_features\":[],\"extension_bytes\":" + std::to_string(field_ranges_[9].second)
        + ",\"revisions\":[");
    for (std::size_t i = 0; i < records_.size(); ++i) {
        const auto &r = records_[i];
        if (i) json.character(',');
        json.raw("{\"id\":"); json.hex(r.id.data(), r.id.size());
        json.raw(",\"kind\":" + std::to_string(r.kind)
            + ",\"storage\":" + std::to_string(r.storage));
        json.raw(",\"actor_name\":"); json.string(r.actor_name.data(), r.actor_name.size());
        json.raw(",\"actor_email\":"); json.string(r.actor_email.data(), r.actor_email.size());
        json.raw(",\"actor_slot_id\":"); json.hex(r.actor_slot.data(), r.actor_slot.size());
        json.raw(",\"client_name\":"); json.string(r.client_name.data(), r.client_name.size());
        json.raw(",\"client_email\":"); json.string(r.client_email.data(), r.client_email.size());
        json.raw(",\"device\":"); json.string(r.device.data(), r.device.size());
        json.raw(",\"timestamp_ms\":" + std::to_string(r.timestamp_ms));
        json.raw(",\"provisional\":"); json.raw(r.provisional ? "true" : "false");
        json.raw(",\"manually_sealed\":"); json.raw(r.provisional ? "false" : "true");
        json.raw(",\"foreign\":"); json.raw(r.foreign ? "true" : "false");
        json.raw(",\"text_available\":"); json.raw(r.text_available ? "true" : "false");
        json.raw(",\"previous_head\":");
        if (r.previous) json.hex(r.previous->data(), r.previous->size());
        else json.raw("null");
        json.raw(",\"content_parent\":");
        if (r.content_parent) json.hex(r.content_parent->data(), r.content_parent->size());
        else json.raw("null");
        json.raw(",\"merge_sources\":[");
        for (std::size_t j = 0; j < r.merge_sources.size(); ++j) {
            if (j) json.character(',');
            json.hex(r.merge_sources[j].data(), r.merge_sources[j].size());
        }
        json.raw("],\"resolved_by\":");
        if (r.resolved_by) json.hex(r.resolved_by->data(), r.resolved_by->size());
        else json.raw("null");
        json.raw(",\"content_hash\":"); json.hex(r.content_hash.data(), r.content_hash.size());
        json.raw(",\"body_digest\":");
        if (r.has_body_digest) json.hex(r.body_digest.data(), r.body_digest.size());
        else json.raw("null");
        json.raw(",\"record_bytes\":" + std::to_string(r.record_cbor.size())
            + ",\"body_bytes\":" + std::to_string(r.body_cbor.size()));
        json.raw(",\"event_type\":"); json.string(r.event_type.data(), r.event_type.size());
        json.raw(",\"event_detail\":"); json.string(r.event_detail.data(), r.event_detail.size());
        json.raw(",\"affected_slot_id\":");
        if (r.affected_slot) json.hex(r.affected_slot->data(), r.affected_slot->size());
        else json.raw("null");
        json.raw(",\"activity_status\":");
        if (r.activity_status) json.raw(std::to_string(*r.activity_status));
        else json.raw("null");
        json.raw(",\"compaction_cutoff\":");
        if (r.compaction_cutoff) json.hex(r.compaction_cutoff->data(), r.compaction_cutoff->size());
        else json.raw("null");
        json.raw(",\"retained_deltas\":");
        if (r.retained_deltas) json.raw(std::to_string(*r.retained_deltas));
        else json.raw("null");
        if (include_content && !r.foreign && r.kind != 2) {
            auto text = reconstruct(r.id);
            const ClearBufferOnExit clear_text(text);
            if (text) {
                json.raw(",\"content\":"); json.string(text->data(), text->size());
            }
        }
        json.raw("}");
    }
    json.raw("]}");
}

} // namespace scpefe::format
