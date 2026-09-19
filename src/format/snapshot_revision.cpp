#include "format/snapshot_revision.hpp"

#include "format/cbor_reader.hpp"
#include "format/cbor_writer.hpp"
#include "format/diagnostic_json_writer.hpp"
#include "format/revision_error.hpp"
#include "format/text_validation.hpp"

#include <limits>
#include <utility>

namespace scpefe::format {

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
    writer.map(11);
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
    return writer.take_output();
}

SnapshotRevision SnapshotRevision::decode(
    const std::uint8_t *encoded,
    std::size_t encoded_size,
    const RevisionLimits &limits
)
{
    CborReader reader(encoded, encoded_size, limits);
    if (reader.map(1) != 11) throw RevisionFailure{RevisionError::malformed_cbor};
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
        )
        || !reader.finished()) {
        throw RevisionFailure{RevisionError::malformed_cbor};
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
    json.raw(",\"snapshot\":{\"codec\":\"none\",\"uncompressed_length\":"
        + std::to_string(data_.content.size()));
    if (include_content) {
        json.raw(",\"content\":"); json.string(data_.content.data(), data_.content.size());
    }
    json.raw("}}");
    return json.take_output();
}

} // namespace scpefe::format
