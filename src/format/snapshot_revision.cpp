#include "format/snapshot_revision.hpp"

#include "format/cbor_reader.hpp"
#include "format/cbor_writer.hpp"
#include "format/diagnostic_json_writer.hpp"
#include "format/revision_error.hpp"
#include "format/text_validation.hpp"

#include <algorithm>
#include <limits>
#include <string>
#include <unordered_map>
#include <utility>

namespace scpefe::format {
namespace {

std::string revision_key(const std::uint8_t *value)
{
    return std::string(reinterpret_cast<const char *>(value), revision_id_size);
}

void validate_ancestor_graph(
    const std::vector<RevisionGraphNodeData> &graph,
    const RevisionLimits &limits
)
{
    if (graph.size() > limits.max_collection_entries()
        || (!graph.empty() && limits.max_nesting_depth() < 4)) {
        throw RevisionFailure{RevisionError::limit_exceeded};
    }
    std::unordered_map<std::string, std::size_t> nodes;
    for (std::size_t index = 0; index < graph.size(); ++index) {
        const auto &node = graph[index];
        if (node.parent_revision_ids.size() % revision_id_size != 0) {
            throw RevisionFailure{RevisionError::invalid_argument};
        }
        const std::size_t count = node.parent_revision_ids.size() / revision_id_size;
        if (count > limits.max_parent_count()
            || count > limits.max_collection_entries()) {
            throw RevisionFailure{RevisionError::limit_exceeded};
        }
        if (!nodes.emplace(revision_key(node.revision_id.data()), index).second) {
            throw RevisionFailure{RevisionError::invalid_argument};
        }
    }
    std::vector<std::uint8_t> state(graph.size());
    const auto visit = [&](const auto &self, std::size_t index) -> void {
        if (state[index] == 1) throw RevisionFailure{RevisionError::invalid_argument};
        if (state[index] == 2) return;
        state[index] = 1;
        const auto &parents = graph[index].parent_revision_ids;
        for (std::size_t offset = 0; offset < parents.size(); offset += revision_id_size) {
            const auto found = nodes.find(revision_key(parents.data() + offset));
            if (found != nodes.end()) self(self, found->second);
        }
        state[index] = 2;
    };
    for (std::size_t index = 0; index < graph.size(); ++index) visit(visit, index);
}

} // namespace

void SnapshotRevision::validate_data(
    const SnapshotRevisionData &data,
    const RevisionLimits &limits
)
{
    if (data.parent_revision_ids.size() % revision_id_size != 0
        || data.slot_id.size() != slot_id_size
        || data.content_hash.size() != content_hash_size) {
        throw RevisionFailure{RevisionError::invalid_argument};
    }
    const std::size_t parent_count = data.parent_revision_ids.size()
        / revision_id_size;
    if (parent_count > limits.max_parent_count()
        || parent_count > limits.max_collection_entries()
        || limits.max_collection_entries() < 11
        || data.slot_identity_name.size() > limits.max_text_bytes()
        || data.slot_identity_email.size() > limits.max_text_bytes()
        || data.client_profile_name.size() > limits.max_text_bytes()
        || data.client_profile_email.size() > limits.max_text_bytes()
        || data.device_name.size() > limits.max_text_bytes()
        || data.content.size() > limits.max_text_bytes()
        || revision_id_size > limits.max_byte_string_bytes()
        || slot_id_size > limits.max_byte_string_bytes()
        || content_hash_size > limits.max_byte_string_bytes()
        || limits.max_nesting_depth() < 2) {
        throw RevisionFailure{RevisionError::limit_exceeded};
    }
    if (!valid_utf8(data.slot_identity_name.data(), data.slot_identity_name.size())
        || !valid_utf8(data.slot_identity_email.data(), data.slot_identity_email.size())
        || !valid_utf8(data.client_profile_name.data(), data.client_profile_name.size())
        || !valid_utf8(data.client_profile_email.data(), data.client_profile_email.size())
        || !valid_utf8(data.device_name.data(), data.device_name.size())
        || !valid_canonical_document_text(data.content.data(), data.content.size())) {
        throw RevisionFailure{RevisionError::invalid_argument};
    }
    validate_ancestor_graph(data.ancestor_graph, limits);
    if (data.manually_sealed != data.provisional_base_revision.empty()) {
        throw RevisionFailure{RevisionError::invalid_argument};
    }
    if (!data.provisional_base_revision.empty()) {
        if (data.provisional_base_revision.size() > limits.max_input_bytes()) {
            throw RevisionFailure{RevisionError::limit_exceeded};
        }
        const auto base = SnapshotRevision::decode(data.provisional_base_revision.data(),
            data.provisional_base_revision.size(), limits);
        if (!base.data().manually_sealed) {
            throw RevisionFailure{RevisionError::invalid_argument};
        }
    }
}

SnapshotRevision::SnapshotRevision(SnapshotRevisionData data)
    : data_(std::move(data))
{
}

SnapshotRevision SnapshotRevision::create(
    SnapshotRevisionData data,
    const RevisionLimits &limits
)
{
    validate_data(data, limits);
    return SnapshotRevision(std::move(data));
}

std::vector<std::uint8_t> SnapshotRevision::encode() const
{
    CborWriter writer;
    writer.map(11 + (data_.ancestor_graph.empty() ? 0 : 1)
        + (data_.manually_sealed ? 0 : 2));
    writer.unsigned_integer(1); writer.unsigned_integer(snapshot_revision_format_version);
    const std::size_t parent_count = data_.parent_revision_ids.size() / revision_id_size;
    writer.unsigned_integer(2); writer.array(parent_count);
    for (std::size_t index = 0; index < parent_count; ++index) {
        writer.bytes(data_.parent_revision_ids.data() + index * revision_id_size,
            revision_id_size);
    }
    writer.unsigned_integer(3); writer.unsigned_integer(data_.timestamp_ms);
    writer.unsigned_integer(4); writer.bytes(data_.slot_id.data(), data_.slot_id.size());
    writer.unsigned_integer(5); writer.text(data_.slot_identity_name.data(), data_.slot_identity_name.size());
    writer.unsigned_integer(6); writer.text(data_.slot_identity_email.data(), data_.slot_identity_email.size());
    writer.unsigned_integer(7); writer.text(data_.client_profile_name.data(), data_.client_profile_name.size());
    writer.unsigned_integer(8); writer.text(data_.client_profile_email.data(), data_.client_profile_email.size());
    writer.unsigned_integer(9); writer.text(data_.device_name.data(), data_.device_name.size());
    writer.unsigned_integer(10); writer.bytes(data_.content_hash.data(), data_.content_hash.size());
    writer.unsigned_integer(11); writer.map(3);
    writer.unsigned_integer(1); writer.unsigned_integer(0);
    writer.unsigned_integer(2); writer.unsigned_integer(data_.content.size());
    writer.unsigned_integer(3); writer.text(data_.content.data(), data_.content.size());
    if (!data_.ancestor_graph.empty()) {
        writer.unsigned_integer(12); writer.array(data_.ancestor_graph.size());
        for (const auto &node : data_.ancestor_graph) {
            writer.array(2);
            writer.bytes(node.revision_id.data(), node.revision_id.size());
            const std::size_t count = node.parent_revision_ids.size() / revision_id_size;
            writer.array(count);
            for (std::size_t index = 0; index < count; ++index) {
                writer.bytes(node.parent_revision_ids.data() + index * revision_id_size,
                    revision_id_size);
            }
        }
    }
    if (!data_.manually_sealed) {
        writer.unsigned_integer(13); writer.boolean(false);
        writer.unsigned_integer(14);
        writer.bytes(data_.provisional_base_revision.data(),
            data_.provisional_base_revision.size());
    }
    return writer.take_output();
}

SnapshotRevision SnapshotRevision::decode(
    const std::uint8_t *encoded,
    std::size_t encoded_size,
    const RevisionLimits &limits
)
{
    CborReader reader(encoded, encoded_size, limits);
    const std::size_t field_count = reader.map(1);
    if (field_count < 11 || field_count > 14)
        throw RevisionFailure{RevisionError::malformed_cbor};
    reader.expect_unsigned(1);
    if (reader.unsigned_integer() != snapshot_revision_format_version) {
        throw RevisionFailure{RevisionError::unsupported_format};
    }
    SnapshotRevision revision;
    reader.expect_unsigned(2);
    const std::size_t parent_count = reader.array(2);
    if (parent_count > limits.max_parent_count()
        || parent_count > std::numeric_limits<std::size_t>::max()
            / revision_id_size) {
        throw RevisionFailure{RevisionError::limit_exceeded};
    }
    revision.data_.parent_revision_ids.reserve(parent_count * revision_id_size);
    for (std::size_t index = 0; index < parent_count; ++index) {
        auto parent = reader.bytes(revision_id_size);
        revision.data_.parent_revision_ids.insert(
            revision.data_.parent_revision_ids.end(), parent.begin(), parent.end()
        );
    }
    reader.expect_unsigned(3); revision.data_.timestamp_ms = reader.unsigned_integer();
    reader.expect_unsigned(4); revision.data_.slot_id = reader.bytes(slot_id_size);
    reader.expect_unsigned(5); revision.data_.slot_identity_name = reader.text();
    reader.expect_unsigned(6); revision.data_.slot_identity_email = reader.text();
    reader.expect_unsigned(7); revision.data_.client_profile_name = reader.text();
    reader.expect_unsigned(8); revision.data_.client_profile_email = reader.text();
    reader.expect_unsigned(9); revision.data_.device_name = reader.text();
    reader.expect_unsigned(10); revision.data_.content_hash = reader.bytes(content_hash_size);
    reader.expect_unsigned(11);
    if (reader.map(2) != 3) throw RevisionFailure{RevisionError::malformed_cbor};
    reader.expect_unsigned(1);
    if (reader.unsigned_integer() != 0) throw RevisionFailure{RevisionError::unsupported_format};
    reader.expect_unsigned(2);
    const std::uint64_t uncompressed_size = reader.unsigned_integer();
    reader.expect_unsigned(3); revision.data_.content = reader.text();
    if (uncompressed_size != revision.data_.content.size()
        || !valid_canonical_document_text(
            revision.data_.content.data(), revision.data_.content.size()
        )) {
        throw RevisionFailure{RevisionError::malformed_cbor};
    }
    std::size_t remaining_fields = field_count - 11;
    if (remaining_fields != 0) {
        const auto next_key = reader.unsigned_integer();
        if (next_key == 12) {
            const std::size_t node_count = reader.array(2);
            if (node_count > limits.max_collection_entries())
                throw RevisionFailure{RevisionError::limit_exceeded};
            revision.data_.ancestor_graph.reserve(node_count);
            for (std::size_t index = 0; index < node_count; ++index) {
                if (reader.array(3) != 2)
                    throw RevisionFailure{RevisionError::malformed_cbor};
                RevisionGraphNodeData node;
                const auto id = reader.bytes(revision_id_size);
                std::copy(id.begin(), id.end(), node.revision_id.begin());
                const std::size_t count = reader.array(4);
                if (count > limits.max_parent_count()
                    || count > std::numeric_limits<std::size_t>::max()
                        / revision_id_size) {
                    throw RevisionFailure{RevisionError::limit_exceeded};
                }
                node.parent_revision_ids.reserve(count * revision_id_size);
                for (std::size_t parent = 0; parent < count; ++parent) {
                    const auto id_value = reader.bytes(revision_id_size);
                    node.parent_revision_ids.insert(node.parent_revision_ids.end(),
                        id_value.begin(), id_value.end());
                }
                revision.data_.ancestor_graph.push_back(std::move(node));
            }
            try {
                validate_ancestor_graph(revision.data_.ancestor_graph, limits);
            } catch (const RevisionFailure &failure) {
                if (failure.error == RevisionError::invalid_argument)
                    throw RevisionFailure{RevisionError::malformed_cbor};
                throw;
            }
            --remaining_fields;
        } else if (next_key == 13) {
            revision.data_.manually_sealed = reader.boolean();
            if (revision.data_.manually_sealed)
                throw RevisionFailure{RevisionError::malformed_cbor};
            --remaining_fields;
        } else {
            throw RevisionFailure{RevisionError::malformed_cbor};
        }
    }
    if (remaining_fields != 0 && revision.data_.manually_sealed) {
        reader.expect_unsigned(13);
        revision.data_.manually_sealed = reader.boolean();
        if (revision.data_.manually_sealed)
            throw RevisionFailure{RevisionError::malformed_cbor};
        --remaining_fields;
    }
    if (remaining_fields != 0) {
        reader.expect_unsigned(14);
        revision.data_.provisional_base_revision = reader.bytes(
            0, limits.max_input_bytes());
        --remaining_fields;
    }
    if (remaining_fields != 0 || !reader.finished())
        throw RevisionFailure{RevisionError::malformed_cbor};
    try {
        validate_data(revision.data_, limits);
    } catch (const RevisionFailure &failure) {
        if (failure.error == RevisionError::invalid_argument)
            throw RevisionFailure{RevisionError::malformed_cbor};
        throw;
    }
    return revision;
}

std::string SnapshotRevision::diagnostic_json(bool include_content) const
{
    DiagnosticJsonWriter json;
    json.raw("{\"format_version\":1,\"parent_revision_ids\":[");
    const std::size_t parent_count = data_.parent_revision_ids.size()
        / revision_id_size;
    for (std::size_t index = 0; index < parent_count; ++index) {
        if (index != 0) json.character(',');
        json.hex(data_.parent_revision_ids.data() + index * revision_id_size,
            revision_id_size);
    }
    json.raw("],\"timestamp_ms\":" + std::to_string(data_.timestamp_ms));
    json.raw(",\"slot_id\":"); json.hex(data_.slot_id.data(), data_.slot_id.size());
    json.raw(",\"slot_identity_name\":"); json.string(data_.slot_identity_name.data(), data_.slot_identity_name.size());
    json.raw(",\"slot_identity_email\":"); json.string(data_.slot_identity_email.data(), data_.slot_identity_email.size());
    json.raw(",\"client_profile_name\":"); json.string(data_.client_profile_name.data(), data_.client_profile_name.size());
    json.raw(",\"client_profile_email\":"); json.string(data_.client_profile_email.data(), data_.client_profile_email.size());
    json.raw(",\"device_name\":"); json.string(data_.device_name.data(), data_.device_name.size());
    json.raw(",\"content_hash\":"); json.hex(data_.content_hash.data(), data_.content_hash.size());
    json.raw(",\"ancestor_graph\":[");
    for (std::size_t node_index = 0; node_index < data_.ancestor_graph.size(); ++node_index) {
        if (node_index != 0) json.character(',');
        const auto &node = data_.ancestor_graph[node_index];
        json.raw("{\"revision_id\":");
        json.hex(node.revision_id.data(), node.revision_id.size());
        json.raw(",\"parent_revision_ids\":[");
        const std::size_t count = node.parent_revision_ids.size() / revision_id_size;
        for (std::size_t index = 0; index < count; ++index) {
            if (index != 0) json.character(',');
            json.hex(node.parent_revision_ids.data() + index * revision_id_size,
                revision_id_size);
        }
        json.raw("]}");
    }
    json.raw("]");
    if (!data_.manually_sealed) json.raw(",\"manually_sealed\":false");
    json.raw(",\"snapshot\":{\"codec\":\"none\",\"uncompressed_length\":"
        + std::to_string(data_.content.size()));
    if (include_content) {
        json.raw(",\"content\":"); json.string(data_.content.data(), data_.content.size());
    }
    json.raw("}}");
    return json.take_output();
}

} // namespace scpefe::format
