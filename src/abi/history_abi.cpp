#include "scpefe/scpefe.h"

#include "format/revision_graph.hpp"
#include "format/revision_error.hpp"
#include "format/text_validation.hpp"

#include <algorithm>
#include <cstring>
#include <limits>
#include <memory>
#include <new>
#include <string>
#include <utility>
#include <vector>

using scpefe::format::RevisionGraph;
using scpefe::format::RevisionId;
using scpefe::format::RevisionLimits;
using scpefe::format::RevisionRecord;
static_assert(sizeof(RevisionId) == SCPEFE_REVISION_ID_SIZE);

struct scpefe_revision_graph { RevisionGraph value; };
struct scpefe_revision_page { std::vector<RevisionRecord> records; };
struct scpefe_revision_result {
    std::vector<std::uint8_t> body_cbor;
    std::string text;
};

namespace {

scpefe_status map_error(scpefe::format::RevisionError error)
{
    using scpefe::format::RevisionError;
    switch (error) {
    case RevisionError::invalid_argument: return SCPEFE_STATUS_INVALID_ARGUMENT;
    case RevisionError::malformed_cbor: return SCPEFE_STATUS_MALFORMED_CBOR;
    case RevisionError::limit_exceeded: return SCPEFE_STATUS_LIMIT_EXCEEDED;
    case RevisionError::unsupported_format: return SCPEFE_STATUS_UNSUPPORTED_FORMAT;
    }
    return SCPEFE_STATUS_MALFORMED_CBOR;
}

RevisionId id_from(const std::uint8_t *bytes)
{
    RevisionId result{};
    std::copy_n(bytes, result.size(), result.begin());
    return result;
}

scpefe_status find_record(const scpefe_revision_graph *graph, const std::uint8_t *id,
    const RevisionRecord *&record)
{
    if (!graph || !id) return SCPEFE_STATUS_INVALID_ARGUMENT;
    record = graph->value.find(id_from(id));
    return record ? SCPEFE_STATUS_OK : SCPEFE_STATUS_REVISION_NOT_FOUND;
}

void fill_id(std::uint8_t *target, const std::optional<RevisionId> &source)
{
    if (source) std::copy(source->begin(), source->end(), target);
    else std::fill_n(target, SCPEFE_REVISION_ID_SIZE, 0);
}

RevisionRecord copy_metadata(const RevisionRecord &source)
{
    RevisionRecord copy;
    copy.id = source.id;
    copy.previous = source.previous;
    copy.content_parent = source.content_parent;
    copy.merge_sources = source.merge_sources;
    copy.timestamp_ms = source.timestamp_ms;
    copy.actor_slot = source.actor_slot;
    copy.actor_name = source.actor_name;
    copy.actor_email = source.actor_email;
    copy.client_name = source.client_name;
    copy.client_email = source.client_email;
    copy.device = source.device;
    copy.content_hash = source.content_hash;
    copy.body_digest = source.body_digest;
    copy.event_type = source.event_type;
    copy.immutable_cbor = source.immutable_cbor;
    copy.event_details_cbor = source.event_details_cbor;
    copy.resolved_by = source.resolved_by;
    copy.kind = source.kind;
    copy.storage = source.storage;
    copy.has_body_digest = source.has_body_digest;
    copy.provisional = source.provisional;
    copy.foreign = source.foreign;
    copy.text_available = source.text_available;
    return copy;
}

} // namespace

scpefe_status scpefe_revision_graph_decode(const uint8_t *payload,
    size_t payload_size, const scpefe_revision_limits_v1 *limits,
    scpefe_revision_graph **graph)
{
    if (graph) *graph = nullptr;
    if (!graph || !payload || payload_size == 0 || !limits
        || limits->struct_size < sizeof(*limits)) return SCPEFE_STATUS_INVALID_ARGUMENT;
    try {
        const RevisionLimits bounded{limits->max_input_bytes,
            limits->max_nesting_depth, limits->max_collection_entries,
            limits->max_text_bytes, limits->max_byte_string_bytes,
            limits->max_parent_count};
        auto owned = std::make_unique<scpefe_revision_graph>(
            scpefe_revision_graph{RevisionGraph::decode(payload, payload_size, bounded)});
        *graph = owned.release();
        return SCPEFE_STATUS_OK;
    } catch (const scpefe::format::RevisionFailure &failure) {
        return map_error(failure.error);
    } catch (const std::bad_alloc &) { return SCPEFE_STATUS_OUT_OF_MEMORY; }
}

scpefe_status scpefe_revision_graph_encode(const scpefe_revision_graph *graph,
    uint8_t *output, size_t capacity, size_t *output_size)
{
    if (!graph || !output_size) return SCPEFE_STATUS_INVALID_ARGUMENT;
    const auto &bytes = graph->value.encode();
    *output_size = bytes.size();
    if (!output || capacity < bytes.size()) return SCPEFE_STATUS_BUFFER_TOO_SMALL;
    std::memcpy(output, bytes.data(), bytes.size());
    return SCPEFE_STATUS_OK;
}

void scpefe_revision_graph_destroy(scpefe_revision_graph *graph) { delete graph; }

scpefe_status scpefe_revision_graph_heads(const scpefe_revision_graph *graph,
    uint8_t *head, uint8_t *content_head)
{
    if (!graph || !head || !content_head) return SCPEFE_STATUS_INVALID_ARGUMENT;
    std::copy(graph->value.head().begin(), graph->value.head().end(), head);
    std::copy(graph->value.content_head().begin(), graph->value.content_head().end(), content_head);
    return SCPEFE_STATUS_OK;
}

scpefe_status scpefe_revision_graph_list(const scpefe_revision_graph *graph,
    size_t offset, size_t count, scpefe_revision_page **page)
{
    if (!graph || !page) return SCPEFE_STATUS_INVALID_ARGUMENT;
    *page = nullptr;
    if (count > RevisionLimits::defaults().max_collection_entries())
        return SCPEFE_STATUS_LIMIT_EXCEEDED;
    try {
        auto owned = std::make_unique<scpefe_revision_page>();
        const auto &records = graph->value.records();
        if (offset < records.size()) {
            const auto take = std::min(count, records.size() - offset);
            owned->records.reserve(take);
            for (size_t i = 0; i < take; ++i)
                owned->records.push_back(copy_metadata(
                    records[records.size() - offset - i - 1]));
        }
        *page = owned.release();
        return SCPEFE_STATUS_OK;
    } catch (const std::bad_alloc &) { return SCPEFE_STATUS_OUT_OF_MEMORY; }
}

scpefe_status scpefe_revision_page_count(const scpefe_revision_page *page, size_t *count)
{
    if (!page || !count) return SCPEFE_STATUS_INVALID_ARGUMENT;
    *count = page->records.size();
    return SCPEFE_STATUS_OK;
}

scpefe_status scpefe_revision_page_metadata(const scpefe_revision_page *page,
    size_t index, scpefe_revision_metadata_v1 *metadata)
{
    if (!page || !metadata || metadata->struct_size < sizeof(*metadata)
        || index >= page->records.size()) return SCPEFE_STATUS_INVALID_ARGUMENT;
    const auto &r = page->records[index];
    scpefe_revision_metadata_v1 result{};
    result.struct_size = sizeof(result);
    std::copy(r.id.begin(), r.id.end(), result.id);
    fill_id(result.previous_head, r.previous);
    fill_id(result.content_parent, r.content_parent);
    fill_id(result.resolved_by, r.resolved_by);
    result.merge_source_ids = r.merge_sources.empty() ? nullptr
        : r.merge_sources.front().data();
    result.merge_source_count = r.merge_sources.size();
    result.timestamp_ms = r.timestamp_ms;
    std::copy(r.actor_slot.begin(), r.actor_slot.end(), result.actor_slot_id);
    result.actor_name = r.actor_name.data(); result.actor_name_size = r.actor_name.size();
    result.actor_email = r.actor_email.data(); result.actor_email_size = r.actor_email.size();
    result.client_name = r.client_name.data(); result.client_name_size = r.client_name.size();
    result.client_email = r.client_email.data(); result.client_email_size = r.client_email.size();
    result.device = r.device.data(); result.device_size = r.device.size();
    result.event_type = r.event_type.data(); result.event_type_size = r.event_type.size();
    result.immutable_cbor = r.immutable_cbor.data();
    result.immutable_cbor_size = r.immutable_cbor.size();
    result.event_details_cbor = r.event_details_cbor.data();
    result.event_details_cbor_size = r.event_details_cbor.size();
    std::copy(r.content_hash.begin(), r.content_hash.end(), result.content_hash);
    std::copy(r.body_digest.begin(), r.body_digest.end(), result.original_body_digest);
    result.original_kind = r.kind; result.storage_kind = r.storage;
    result.has_previous_head = r.previous.has_value();
    result.has_content_parent = r.content_parent.has_value();
    result.has_original_body_digest = r.has_body_digest;
    result.has_resolved_by = r.resolved_by.has_value();
    result.foreign = r.foreign; result.provisional = r.provisional;
    result.body_available = r.storage >= 1 && r.storage <= 3;
    result.text_available = r.text_available;
    *metadata = result;
    return SCPEFE_STATUS_OK;
}

void scpefe_revision_page_destroy(scpefe_revision_page *page) { delete page; }

scpefe_status scpefe_revision_graph_body(const scpefe_revision_graph *graph,
    const uint8_t *revision_id, scpefe_revision_result **result)
{
    if (!result) return SCPEFE_STATUS_INVALID_ARGUMENT;
    *result = nullptr;
    const RevisionRecord *record = nullptr;
    const auto status = find_record(graph, revision_id, record);
    if (status != SCPEFE_STATUS_OK) return status;
    if (record->body_cbor.empty()) return SCPEFE_STATUS_BODY_UNAVAILABLE;
    try {
        auto owned = std::make_unique<scpefe_revision_result>();
        owned->body_cbor = record->body_cbor;
        *result = owned.release();
        return SCPEFE_STATUS_OK;
    } catch (const std::bad_alloc &) { return SCPEFE_STATUS_OUT_OF_MEMORY; }
}

scpefe_status scpefe_revision_graph_reconstruct(const scpefe_revision_graph *graph,
    const uint8_t *revision_id, scpefe_revision_result **result)
{
    if (!result) return SCPEFE_STATUS_INVALID_ARGUMENT;
    *result = nullptr;
    const RevisionRecord *record = nullptr;
    const auto status = find_record(graph, revision_id, record);
    if (status != SCPEFE_STATUS_OK) return status;
    if (record->foreign) return SCPEFE_STATUS_BODY_UNAVAILABLE;
    try {
        auto text = graph->value.reconstruct(record->id);
        if (!text) return SCPEFE_STATUS_BODY_UNAVAILABLE;
        auto owned = std::make_unique<scpefe_revision_result>();
        owned->text = std::move(*text);
        *result = owned.release();
        return SCPEFE_STATUS_OK;
    } catch (const scpefe::format::RevisionFailure &failure) {
        return map_error(failure.error);
    } catch (const std::bad_alloc &) { return SCPEFE_STATUS_OUT_OF_MEMORY; }
}

scpefe_status scpefe_revision_graph_compare(const scpefe_revision_graph *graph,
    const uint8_t *before_id, const uint8_t *after_id,
    scpefe_revision_result **result)
{
    if (!result) return SCPEFE_STATUS_INVALID_ARGUMENT;
    *result = nullptr;
    const RevisionRecord *before_record = nullptr, *after_record = nullptr;
    auto status = find_record(graph, before_id, before_record);
    if (status != SCPEFE_STATUS_OK) return status;
    status = find_record(graph, after_id, after_record);
    if (status != SCPEFE_STATUS_OK) return status;
    if (before_record->foreign || after_record->foreign)
        return SCPEFE_STATUS_BODY_UNAVAILABLE;
    try {
        auto comparison = graph->value.compare(before_record->id, after_record->id);
        if (!comparison) return SCPEFE_STATUS_BODY_UNAVAILABLE;
        auto owned = std::make_unique<scpefe_revision_result>();
        owned->text = std::move(*comparison);
        *result = owned.release();
        return SCPEFE_STATUS_OK;
    } catch (const scpefe::format::RevisionFailure &failure) {
        return map_error(failure.error);
    } catch (const std::bad_alloc &) { return SCPEFE_STATUS_OUT_OF_MEMORY; }
}

scpefe_status scpefe_revision_result_view(const scpefe_revision_result *result,
    scpefe_revision_result_view_v1 *view)
{
    if (!result || !view || view->struct_size < sizeof(*view))
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    *view = {sizeof(*view), result->body_cbor.data(), result->body_cbor.size(),
        result->text.data(), result->text.size()};
    return SCPEFE_STATUS_OK;
}

void scpefe_revision_result_destroy(scpefe_revision_result *result) { delete result; }

scpefe_status scpefe_revision_graph_diagnostic_json(const scpefe_revision_graph *graph,
    int include_content, char *output, size_t capacity, size_t *output_size)
{
    if (!graph || !output_size) return SCPEFE_STATUS_INVALID_ARGUMENT;
    *output_size = 0;
    try {
        const auto json = graph->value.diagnostic_json(include_content != 0);
        *output_size = json.size();
        if (!output || capacity <= json.size()) return SCPEFE_STATUS_BUFFER_TOO_SMALL;
        std::memcpy(output, json.data(), json.size());
        output[json.size()] = '\0';
        return SCPEFE_STATUS_OK;
    } catch (const scpefe::format::RevisionFailure &failure) {
        return map_error(failure.error);
    } catch (const std::bad_alloc &) { return SCPEFE_STATUS_OUT_OF_MEMORY; }
}
