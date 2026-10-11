#pragma once

#include <cstddef>

namespace scpefe::core {

/* Chooses a retained-history cutoff independently of graph ownership. */
class HistoryService {
public:
    /* Permits deterministic history substitution in context tests. */
    virtual ~HistoryService() = default;
    /* Returns the content-revision index that becomes the new base. */
    virtual std::size_t compaction_cutoff(
        std::size_t content_revision_count, std::size_t retain_deltas) const;
};

} // namespace scpefe::core
