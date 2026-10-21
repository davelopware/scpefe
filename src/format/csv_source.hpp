#pragma once

#include <cstddef>
#include <string_view>

namespace scpefe::format {

/* Checks quoted CSV fields and a rectangular heading plus data rows. */
inline bool valid_csv_source(std::string_view source)
{
    std::size_t headings = 0, cells = 0;
    bool quoted = false, after_quote = false, at_start = true;
    bool any_row = false;
    for (std::size_t i = 0; i < source.size(); ++i) {
        const char c = source[i];
        if (c == '\r') return false;
        if (quoted) {
            if (c == '"' && i + 1 < source.size() && source[i + 1] == '"') ++i;
            else if (c == '"') { quoted = false; after_quote = true; }
        } else if (after_quote) {
            if (c == ',') { ++cells; at_start = true; after_quote = false; }
            else if (c == '\n') {
                ++cells;
                if (headings == 0) headings = cells;
                else if (cells != headings) return false;
                cells = 0; at_start = true; after_quote = false; any_row = true;
            } else return false;
        } else if (c == '"') {
            if (!at_start) return false;
            quoted = true; at_start = false;
        } else if (c == ',') { ++cells; at_start = true; }
        else if (c == '\n') {
            ++cells;
            if (headings == 0) headings = cells;
            else if (cells != headings) return false;
            cells = 0; at_start = true; any_row = true;
        } else at_start = false;
    }
    if (quoted) return false;
    if (source.empty() || source.back() != '\n') {
        ++cells;
        if (headings != 0 && cells != headings) return false;
        any_row = true;
    }
    return any_row;
}

} // namespace scpefe::format
