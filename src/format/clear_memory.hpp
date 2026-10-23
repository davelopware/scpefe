#pragma once

#include <cstddef>

namespace scpefe::format {

/* Overwrites live sensitive bytes without allowing dead-store elimination. */
inline void clear_memory(void *data, std::size_t size) noexcept
{
    volatile unsigned char *bytes = static_cast<unsigned char *>(data);
    for (std::size_t i = 0; i < size; ++i) bytes[i] = 0;
}

} // namespace scpefe::format
