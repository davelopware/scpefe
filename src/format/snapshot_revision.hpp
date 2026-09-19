#pragma once

#include "format/revision_limits.hpp"
#include "format/snapshot_revision_data.hpp"

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace scpefe::format {

/* Owns and validates one version-1 snapshot revision. */
class SnapshotRevision {
public:
    /* Creates a validated revision from semantic values. */
    static SnapshotRevision create(
        SnapshotRevisionData data,
        const RevisionLimits &limits
    );
    /* Decodes and validates one deterministic-CBOR revision. */
    static SnapshotRevision decode(
        const std::uint8_t *encoded,
        std::size_t encoded_size,
        const RevisionLimits &limits
    );

    /* Encodes the revision as deterministic CBOR. */
    std::vector<std::uint8_t> encode() const;
    /* Renders readable diagnostic JSON, optionally including document text. */
    std::string diagnostic_json(bool include_content) const;
    /* Returns the owned semantic values. */
    const SnapshotRevisionData &data() const { return data_; }

private:
    /* Creates an empty instance for the decoder to populate. */
    SnapshotRevision() = default;
    /* Takes ownership of already validated semantic values. */
    explicit SnapshotRevision(SnapshotRevisionData data);
    /* Validates semantic values against format invariants and limits. */
    static void validate_data(
        const SnapshotRevisionData &data,
        const RevisionLimits &limits
    );

    SnapshotRevisionData data_;
};

} // namespace scpefe::format
