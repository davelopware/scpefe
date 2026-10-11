#include "core/history_service.hpp"

namespace scpefe::core {

std::size_t HistoryService::compaction_cutoff(
    std::size_t content_revision_count, std::size_t retain_deltas) const
{
    if (content_revision_count == 0 || retain_deltas >= content_revision_count - 1)
        return 0;
    return content_revision_count - retain_deltas - 1;
}

} // namespace scpefe::core
