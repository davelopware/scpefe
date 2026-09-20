#include "format/revision_limits.hpp"

namespace scpefe::format {

RevisionLimits::RevisionLimits(
    std::size_t max_input_bytes,
    std::size_t max_nesting_depth,
    std::size_t max_collection_entries,
    std::size_t max_text_bytes,
    std::size_t max_byte_string_bytes,
    std::size_t max_parent_count
) : max_input_bytes_(max_input_bytes),
    max_nesting_depth_(max_nesting_depth),
    max_collection_entries_(max_collection_entries),
    max_text_bytes_(max_text_bytes),
    max_byte_string_bytes_(max_byte_string_bytes),
    max_parent_count_(max_parent_count)
{
}

RevisionLimits RevisionLimits::defaults()
{
    return RevisionLimits(
        32u * 1024u * 1024u,
        8u,
        1024u,
        8u * 1024u * 1024u,
        1024u * 1024u,
        8u
    );
}

} // namespace scpefe::format
