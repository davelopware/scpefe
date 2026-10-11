#pragma once

#include <cstddef>
#include <array>
#include <cstdint>
#include <vector>

namespace scpefe::core {

/* Computes history cutoffs and adapts current byte ABI compaction. */
class HistoryService {
public:
    /* Permits deterministic history substitution in context tests. */
    virtual ~HistoryService() = default;
    /* Returns the content-revision index that becomes the new base. */
    virtual std::size_t compaction_cutoff(
        std::size_t content_revision_count, std::size_t retain_deltas) const;
    /* Compacts one authenticated prerefactor byte ABI document candidate. */
    virtual std::vector<std::uint8_t> compact_legacy_document(
        const std::uint8_t *bytes, std::size_t size,
        const std::uint8_t *password, std::size_t password_size,
        const std::array<std::uint8_t, 16> &lease_session_id,
        std::uint64_t heartbeat_counter) const;
};

} // namespace scpefe::core
