#include "core/history_service.hpp"
#include "document/compaction.hpp"
#include "format/revision_graph.hpp"

namespace scpefe::core {

std::size_t HistoryService::compaction_cutoff(
    std::size_t content_revision_count, std::size_t retain_deltas) const
{
    if (content_revision_count == 0 || retain_deltas >= content_revision_count - 1)
        return 0;
    return content_revision_count - retain_deltas - 1;
}

std::vector<std::uint8_t> HistoryService::compact_graph(
    const format::RevisionGraph &graph, std::size_t retain_deltas,
    const format::RevisionSlot &actor, std::string_view client_name,
    std::string_view client_email, std::string_view device,
    std::uint64_t timestamp_ms) const
{
    std::size_t count = 0;
    for (const auto &record : graph.records())
        if (!record.foreign && record.kind != 2) ++count;
    return graph.compact_at(compaction_cutoff(count, retain_deltas), actor,
        client_name, client_email, device, timestamp_ms);
}

std::vector<std::uint8_t> HistoryService::compact_legacy_document(
    const std::uint8_t *bytes, std::size_t size,
    const std::uint8_t *password, std::size_t password_size,
    const std::array<std::uint8_t, 16> &lease_session_id,
    std::uint64_t heartbeat_counter) const
{
    return document::Compaction::create(bytes, size, password, password_size,
        lease_session_id, heartbeat_counter);
}

} // namespace scpefe::core
