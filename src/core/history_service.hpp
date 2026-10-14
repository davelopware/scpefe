#pragma once

#include "format/revision_graph.hpp"

#include <cstddef>
#include <array>
#include <cstdint>
#include <string_view>
#include <vector>

namespace scpefe::core {

/* Computes history cutoffs for revised-v3 compaction. */
class HistoryService {
public:
    /* Permits deterministic history substitution in context tests. */
    virtual ~HistoryService() = default;
    /* Returns the content-revision index that becomes the new base. */
    virtual std::size_t compaction_cutoff(
        std::size_t content_revision_count, std::size_t retain_deltas) const;
    /* Chooses a canonical cutoff and builds a v3 compaction graph. */
    virtual std::vector<std::uint8_t> compact_graph(
        const format::RevisionGraph &graph, std::size_t retain_deltas,
        const format::RevisionSlot &actor, std::string_view client_name,
        std::string_view client_email, std::string_view device,
        std::uint64_t timestamp_ms) const;

};

} // namespace scpefe::core
