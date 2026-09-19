#include "format/text_validation.hpp"

#include <algorithm>
#include <cstdint>

namespace scpefe::format {

bool span_is_valid(const void *data, std::size_t size)
{
    return size == 0 || data != nullptr;
}

bool valid_utf8(const char *data, std::size_t size)
{
    if (!span_is_valid(data, size)) return false;
    const auto *bytes = reinterpret_cast<const std::uint8_t *>(data);
    for (std::size_t index = 0; index < size;) {
        const std::uint8_t first = bytes[index++];
        if (first <= 0x7f) continue;

        std::size_t continuation_count = 0;
        std::uint32_t code_point = 0;
        std::uint32_t minimum = 0;
        if (first >= 0xc2 && first <= 0xdf) {
            continuation_count = 1; code_point = first & 0x1fu; minimum = 0x80u;
        } else if (first >= 0xe0 && first <= 0xef) {
            continuation_count = 2; code_point = first & 0x0fu; minimum = 0x800u;
        } else if (first >= 0xf0 && first <= 0xf4) {
            continuation_count = 3; code_point = first & 0x07u; minimum = 0x10000u;
        } else {
            return false;
        }
        if (continuation_count > size - index) return false;
        for (std::size_t offset = 0; offset < continuation_count; ++offset) {
            const std::uint8_t next = bytes[index++];
            if ((next & 0xc0u) != 0x80u) return false;
            code_point = (code_point << 6u) | (next & 0x3fu);
        }
        if (code_point < minimum || code_point > 0x10ffffu
            || (code_point >= 0xd800u && code_point <= 0xdfffu)) {
            return false;
        }
    }
    return true;
}

bool valid_canonical_document_text(const char *data, std::size_t size)
{
    if (!valid_utf8(data, size)) return false;
    if (size == 0) return true;
    const auto *bytes = reinterpret_cast<const std::uint8_t *>(data);
    if (size >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb
        && bytes[2] == 0xbf) {
        return false;
    }
    return std::find(data, data + size, '\r') == data + size;
}

} // namespace scpefe::format
