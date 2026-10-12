#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace scpefe::format {

/* Computes unkeyed BLAKE2b-256 without native crypto dependencies. */
std::array<std::uint8_t, 32> blake2b_256(const std::uint8_t *data, std::size_t size);

} // namespace scpefe::format
