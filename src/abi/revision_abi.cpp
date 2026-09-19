#include "scpefe/scpefe.h"

#include "format/revision_error.hpp"
#include "format/revision_limits.hpp"
#include "format/snapshot_revision.hpp"
#include "format/snapshot_revision_data.hpp"
#include "format/text_validation.hpp"

#include <cstring>
#include <new>
#include <limits>
#include <string>
#include <utility>
#include <vector>

using scpefe::format::RevisionError;
using scpefe::format::RevisionFailure;
using scpefe::format::RevisionLimits;
using scpefe::format::SnapshotRevision;
using scpefe::format::SnapshotRevisionData;

namespace {

bool has_complete_limits(const scpefe_revision_limits_v1 *limits)
{
    return limits != nullptr
        && limits->struct_size >= sizeof(scpefe_revision_limits_v1);
}

scpefe_status external_status(RevisionError error)
{
    switch (error) {
    case RevisionError::invalid_argument: return SCPEFE_STATUS_INVALID_ARGUMENT;
    case RevisionError::malformed_cbor: return SCPEFE_STATUS_MALFORMED_CBOR;
    case RevisionError::limit_exceeded: return SCPEFE_STATUS_LIMIT_EXCEEDED;
    case RevisionError::unsupported_format: return SCPEFE_STATUS_UNSUPPORTED_FORMAT;
    }
    return SCPEFE_STATUS_INVALID_ARGUMENT;
}

RevisionLimits limits_from_external(const scpefe_revision_limits_v1 &limits)
{
    return RevisionLimits(
        limits.max_input_bytes,
        limits.max_nesting_depth,
        limits.max_collection_entries,
        limits.max_text_bytes,
        limits.max_byte_string_bytes,
        limits.max_parent_count
    );
}

SnapshotRevisionData data_from_external(
    const scpefe_snapshot_revision_v1 &revision
)
{
    if (revision.struct_size < sizeof(scpefe_snapshot_revision_v1)
        || revision.format_version != SCPEFE_REVISION_FORMAT_VERSION
        || revision.slot_id_size != SCPEFE_SLOT_ID_SIZE
        || revision.content_hash_size != SCPEFE_CONTENT_HASH_SIZE
        || revision.parent_count > std::numeric_limits<std::size_t>::max()
            / SCPEFE_REVISION_ID_SIZE
        || !scpefe::format::span_is_valid(revision.parent_revision_ids,
            revision.parent_count * SCPEFE_REVISION_ID_SIZE)
        || !scpefe::format::span_is_valid(revision.slot_id, revision.slot_id_size)
        || !scpefe::format::span_is_valid(revision.slot_identity_name,
            revision.slot_identity_name_size)
        || !scpefe::format::span_is_valid(revision.slot_identity_email,
            revision.slot_identity_email_size)
        || !scpefe::format::span_is_valid(revision.client_profile_name,
            revision.client_profile_name_size)
        || !scpefe::format::span_is_valid(revision.client_profile_email,
            revision.client_profile_email_size)
        || !scpefe::format::span_is_valid(revision.device_name,
            revision.device_name_size)
        || !scpefe::format::span_is_valid(revision.content_hash,
            revision.content_hash_size)
        || !scpefe::format::span_is_valid(revision.content,
            revision.content_size)) {
        throw RevisionFailure{RevisionError::invalid_argument};
    }

    SnapshotRevisionData data;
    if (revision.parent_count != 0) {
        data.parent_revision_ids.assign(
            revision.parent_revision_ids,
            revision.parent_revision_ids
                + revision.parent_count * SCPEFE_REVISION_ID_SIZE
        );
    }
    data.timestamp_ms = revision.timestamp_ms;
    data.slot_id.assign(revision.slot_id, revision.slot_id + revision.slot_id_size);
    if (revision.slot_identity_name_size != 0) {
        data.slot_identity_name.assign(
            revision.slot_identity_name, revision.slot_identity_name_size
        );
    }
    if (revision.slot_identity_email_size != 0) {
        data.slot_identity_email.assign(
            revision.slot_identity_email, revision.slot_identity_email_size
        );
    }
    if (revision.client_profile_name_size != 0) {
        data.client_profile_name.assign(
            revision.client_profile_name, revision.client_profile_name_size
        );
    }
    if (revision.client_profile_email_size != 0) {
        data.client_profile_email.assign(
            revision.client_profile_email, revision.client_profile_email_size
        );
    }
    if (revision.device_name_size != 0) {
        data.device_name.assign(revision.device_name, revision.device_name_size);
    }
    data.content_hash.assign(
        revision.content_hash, revision.content_hash + revision.content_hash_size
    );
    if (revision.content_size != 0) {
        data.content.assign(revision.content, revision.content_size);
    }
    return data;
}

void populate_external_view(
    const SnapshotRevisionData &data,
    scpefe_snapshot_revision_v1 &view
)
{
    const std::uint32_t struct_size = view.struct_size;
    view = scpefe_snapshot_revision_v1{
        struct_size, SCPEFE_REVISION_FORMAT_VERSION,
        data.parent_revision_ids.data(),
        data.parent_revision_ids.size() / SCPEFE_REVISION_ID_SIZE,
        data.timestamp_ms, data.slot_id.data(), data.slot_id.size(),
        data.slot_identity_name.data(), data.slot_identity_name.size(),
        data.slot_identity_email.data(), data.slot_identity_email.size(),
        data.client_profile_name.data(), data.client_profile_name.size(),
        data.client_profile_email.data(), data.client_profile_email.size(),
        data.device_name.data(), data.device_name.size(),
        data.content_hash.data(), data.content_hash.size(),
        data.content.data(), data.content.size(),
    };
}

} // namespace

struct scpefe_decoded_snapshot_revision {
    explicit scpefe_decoded_snapshot_revision(SnapshotRevision value)
        : implementation(std::move(value)) {}
    SnapshotRevision implementation;
};

scpefe_status scpefe_revision_limits_default(scpefe_revision_limits_v1 *limits)
{
    if (limits == nullptr
        || limits->struct_size < sizeof(scpefe_revision_limits_v1)) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    const RevisionLimits defaults = RevisionLimits::defaults();
    *limits = scpefe_revision_limits_v1{
        sizeof(scpefe_revision_limits_v1),
        defaults.max_input_bytes(),
        defaults.max_nesting_depth(),
        defaults.max_collection_entries(),
        defaults.max_text_bytes(),
        defaults.max_byte_string_bytes(),
        defaults.max_parent_count(),
    };
    return SCPEFE_STATUS_OK;
}

scpefe_status scpefe_snapshot_revision_encode(
    const scpefe_snapshot_revision_v1 *revision,
    const scpefe_revision_limits_v1 *limits,
    std::uint8_t *output,
    std::size_t output_capacity,
    std::size_t *output_size
)
{
    if (revision == nullptr || !has_complete_limits(limits)
        || output_size == nullptr) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    try {
        const RevisionLimits internal_limits = limits_from_external(*limits);
        const SnapshotRevision value = SnapshotRevision::create(
            data_from_external(*revision), internal_limits
        );
        const std::vector<std::uint8_t> encoded = value.encode();
        if (encoded.size() > internal_limits.max_input_bytes()) {
            return SCPEFE_STATUS_LIMIT_EXCEEDED;
        }
        *output_size = encoded.size();
        if (output == nullptr || output_capacity < encoded.size()) {
            return SCPEFE_STATUS_BUFFER_TOO_SMALL;
        }
        std::memcpy(output, encoded.data(), encoded.size());
        return SCPEFE_STATUS_OK;
    } catch (const RevisionFailure &failure) {
        return external_status(failure.error);
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_snapshot_revision_decode(
    const std::uint8_t *encoded,
    std::size_t encoded_size,
    const scpefe_revision_limits_v1 *limits,
    scpefe_decoded_snapshot_revision **revision
)
{
    if (!scpefe::format::span_is_valid(encoded, encoded_size) || encoded_size == 0
        || !has_complete_limits(limits) || revision == nullptr) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    *revision = nullptr;
    const RevisionLimits internal_limits = limits_from_external(*limits);
    if (encoded_size > internal_limits.max_input_bytes()) {
        return SCPEFE_STATUS_LIMIT_EXCEEDED;
    }
    try {
        auto decoded = SnapshotRevision::decode(encoded, encoded_size, internal_limits);
        auto *owned = new (std::nothrow) scpefe_decoded_snapshot_revision(
            std::move(decoded)
        );
        if (owned == nullptr) return SCPEFE_STATUS_OUT_OF_MEMORY;
        *revision = owned;
        return SCPEFE_STATUS_OK;
    } catch (const RevisionFailure &failure) {
        return external_status(failure.error);
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_decoded_snapshot_revision_view(
    const scpefe_decoded_snapshot_revision *revision,
    scpefe_snapshot_revision_v1 *view
)
{
    if (revision == nullptr || view == nullptr
        || view->struct_size < sizeof(scpefe_snapshot_revision_v1)) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    populate_external_view(revision->implementation.data(), *view);
    return SCPEFE_STATUS_OK;
}

void scpefe_decoded_snapshot_revision_destroy(
    scpefe_decoded_snapshot_revision *revision
)
{
    delete revision;
}

scpefe_status scpefe_snapshot_revision_diagnostic_json(
    const std::uint8_t *encoded,
    std::size_t encoded_size,
    const scpefe_revision_limits_v1 *limits,
    int include_content,
    char *output,
    std::size_t output_capacity,
    std::size_t *output_size
)
{
    if (!scpefe::format::span_is_valid(encoded, encoded_size) || encoded_size == 0
        || !has_complete_limits(limits) || output_size == nullptr) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    const RevisionLimits internal_limits = limits_from_external(*limits);
    if (encoded_size > internal_limits.max_input_bytes()) {
        return SCPEFE_STATUS_LIMIT_EXCEEDED;
    }
    try {
        const SnapshotRevision revision = SnapshotRevision::decode(
            encoded, encoded_size, internal_limits
        );
        const std::string json = revision.diagnostic_json(include_content != 0);
        *output_size = json.size();
        if (output == nullptr || output_capacity <= json.size()) {
            return SCPEFE_STATUS_BUFFER_TOO_SMALL;
        }
        std::memcpy(output, json.data(), json.size());
        output[json.size()] = '\0';
        return SCPEFE_STATUS_OK;
    } catch (const RevisionFailure &failure) {
        return external_status(failure.error);
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}
