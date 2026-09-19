#pragma once

#include <cstddef>

namespace scpefe::format {

class RevisionLimits {
public:
    static RevisionLimits defaults();
    RevisionLimits(
        std::size_t max_input_bytes,
        std::size_t max_nesting_depth,
        std::size_t max_collection_entries,
        std::size_t max_text_bytes,
        std::size_t max_byte_string_bytes,
        std::size_t max_parent_count
    );

    std::size_t max_input_bytes() const { return max_input_bytes_; }
    std::size_t max_nesting_depth() const { return max_nesting_depth_; }
    std::size_t max_collection_entries() const {
        return max_collection_entries_;
    }
    std::size_t max_text_bytes() const { return max_text_bytes_; }
    std::size_t max_byte_string_bytes() const {
        return max_byte_string_bytes_;
    }
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
