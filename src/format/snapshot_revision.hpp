#pragma once

#include "format/revision_limits.hpp"
#include "format/snapshot_revision_data.hpp"

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace scpefe::format {

class SnapshotRevision {
public:
    static SnapshotRevision create(
        SnapshotRevisionData data,
        const RevisionLimits &limits
    );
    static SnapshotRevision decode(
        const std::uint8_t *encoded,
        std::size_t encoded_size,
        const RevisionLimits &limits
    );

    std::vector<std::uint8_t> encode() const;
    std::string diagnostic_json(bool include_content) const;
    const SnapshotRevisionData &data() const { return data_; }

private:
    SnapshotRevision() = default;
    explicit SnapshotRevision(SnapshotRevisionData data);
    static void validate_data(
        const SnapshotRevisionData &data,
        const RevisionLimits &limits
    );

    SnapshotRevisionData data_;
};

} // namespace scpefe::format
