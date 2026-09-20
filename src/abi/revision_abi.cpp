#include "scpefe/scpefe.h"

#include "format/revision_error.hpp"
#include "format/revision_limits.hpp"
#include "format/snapshot_revision.hpp"
#include "format/snapshot_revision_data.hpp"
#include "format/text_validation.hpp"

#include <algorithm>
#include <cstring>
#include <cstddef>
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

constexpr std::size_t snapshot_revision_v1_base_size =
    offsetof(scpefe_snapshot_revision_v1, ancestor_graph);

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
    const scpefe_snapshot_revision_v1 &revision,
    const RevisionLimits &limits
)
{
    const bool has_ancestor_graph =
        revision.struct_size >= offsetof(scpefe_snapshot_revision_v1, manually_sealed);
    const bool has_provisional_fields =
        revision.struct_size >= sizeof(scpefe_snapshot_revision_v1);
    if (revision.struct_size < snapshot_revision_v1_base_size
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
            revision.content_size)
        || (has_ancestor_graph && !scpefe::format::span_is_valid(
            revision.ancestor_graph, revision.ancestor_count))) {
        throw RevisionFailure{RevisionError::invalid_argument};
    }
    if (revision.parent_count > limits.max_parent_count()
        || (has_ancestor_graph
            && (revision.ancestor_count > limits.max_collection_entries()
                || (revision.ancestor_count != 0
                    && limits.max_nesting_depth() < 4)))) {
        throw RevisionFailure{RevisionError::limit_exceeded};
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
    const std::size_t ancestor_count = has_ancestor_graph
        ? revision.ancestor_count : 0;
    data.ancestor_graph.reserve(ancestor_count);
    for (std::size_t index = 0; index < ancestor_count; ++index) {
        const auto &external = revision.ancestor_graph[index];
        if (external.parent_count > limits.max_parent_count()) {
            throw RevisionFailure{RevisionError::limit_exceeded};
        }
        if (external.parent_count > std::numeric_limits<std::size_t>::max()
                / SCPEFE_REVISION_ID_SIZE
            || !scpefe::format::span_is_valid(external.revision_id,
                SCPEFE_REVISION_ID_SIZE)
            || !scpefe::format::span_is_valid(external.parent_revision_ids,
                external.parent_count * SCPEFE_REVISION_ID_SIZE)) {
            throw RevisionFailure{RevisionError::invalid_argument};
        }
        scpefe::format::RevisionGraphNodeData node;
        std::memcpy(node.revision_id.data(), external.revision_id,
            node.revision_id.size());
        if (external.parent_count != 0) {
            node.parent_revision_ids.assign(external.parent_revision_ids,
                external.parent_revision_ids
                    + external.parent_count * SCPEFE_REVISION_ID_SIZE);
        }
        data.ancestor_graph.push_back(std::move(node));
    }
    if (has_provisional_fields) {
        data.manually_sealed = revision.manually_sealed != 0
            || revision.provisional_base_revision_size == 0;
        if (revision.provisional_base_revision_size != 0) {
            if (!scpefe::format::span_is_valid(revision.provisional_base_revision,
                    revision.provisional_base_revision_size)) {
                throw RevisionFailure{RevisionError::invalid_argument};
            }
            data.provisional_base_revision.assign(revision.provisional_base_revision,
                revision.provisional_base_revision
                    + revision.provisional_base_revision_size);
        }
    }
    return data;
}

void populate_external_view(
    const SnapshotRevisionData &data,
    const std::vector<scpefe_revision_graph_node_v1> &ancestor_views,
    scpefe_snapshot_revision_v1 &view
)
{
    const std::uint32_t struct_size = view.struct_size;
    const scpefe_snapshot_revision_v1 complete{
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
        ancestor_views.data(), ancestor_views.size(),
        data.manually_sealed,
        data.provisional_base_revision.data(),
        data.provisional_base_revision.size(),
    };
    std::memcpy(&view, &complete,
        std::min<std::size_t>(struct_size, sizeof(complete)));
}

} // namespace

struct scpefe_decoded_snapshot_revision {
    explicit scpefe_decoded_snapshot_revision(SnapshotRevision value)
        : implementation(std::move(value))
    {
        const auto &graph = implementation.data().ancestor_graph;
        ancestor_views.reserve(graph.size());
        for (const auto &node : graph) {
            ancestor_views.push_back(scpefe_revision_graph_node_v1{
                node.revision_id.data(), node.parent_revision_ids.data(),
                node.parent_revision_ids.size() / SCPEFE_REVISION_ID_SIZE,
            });
        }
    }
    SnapshotRevision implementation;
    std::vector<scpefe_revision_graph_node_v1> ancestor_views;
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
            data_from_external(*revision, internal_limits), internal_limits
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
        || view->struct_size < snapshot_revision_v1_base_size) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    populate_external_view(revision->implementation.data(),
        revision->ancestor_views, *view);
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
