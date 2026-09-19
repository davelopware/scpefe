#pragma once

#include <cstddef>

namespace scpefe::format {

/* Immutable allocation and structural limits for revision processing. */
class RevisionLimits {
public:
    /* Returns the common-core default limits. */
    static RevisionLimits defaults();
    /* Creates an explicit limit set. */
    RevisionLimits(
        std::size_t max_input_bytes,
        std::size_t max_nesting_depth,
        std::size_t max_collection_entries,
        std::size_t max_text_bytes,
        std::size_t max_byte_string_bytes,
        std::size_t max_parent_count
    );

    /* Returns the maximum encoded input size. */
    std::size_t max_input_bytes() const { return max_input_bytes_; }
    /* Returns the maximum CBOR nesting depth. */
    std::size_t max_nesting_depth() const { return max_nesting_depth_; }
    /* Returns the maximum entries in one collection. */
    std::size_t max_collection_entries() const {
        return max_collection_entries_;
    }
    /* Returns the maximum bytes in one text string. */
    std::size_t max_text_bytes() const { return max_text_bytes_; }
    /* Returns the maximum bytes in one byte string. */
    std::size_t max_byte_string_bytes() const {
        return max_byte_string_bytes_;
    }
    /* Returns the maximum parent revisions in one record. */
    std::size_t max_parent_count() const { return max_parent_count_; }

private:
    std::size_t max_input_bytes_;
    std::size_t max_nesting_depth_;
    std::size_t max_collection_entries_;
    std::size_t max_text_bytes_;
    std::size_t max_byte_string_bytes_;
    std::size_t max_parent_count_;
};

} // namespace scpefe::format
