#include "core/history_service.hpp"
#include "format/revision_graph.hpp"

#include <algorithm>

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
    std::size_t first_available = graph.records().size();
    for (const auto &record : graph.records())
        if (!record.foreign && record.kind != 2) {
            if (record.text_available && first_available == graph.records().size())
                first_available = count;
            ++count;
        }
    // A prior compaction may have removed the nominal cutoff's body. Keep its
    // existing checkpoint rather than selecting an unreconstructable revision.
    const auto cutoff = std::max(compaction_cutoff(count, retain_deltas),
        first_available);
    return graph.compact_at(cutoff, actor,
        client_name, client_email, device, timestamp_ms);
}

} // namespace scpefe::core
