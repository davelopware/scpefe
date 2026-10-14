#include "format/blake2b.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstring>

namespace scpefe::format {
namespace {

constexpr std::array<std::uint64_t, 8> iv{
    0x6a09e667f3bcc908ULL, 0xbb67ae8584caa73bULL,
    0x3c6ef372fe94f82bULL, 0xa54ff53a5f1d36f1ULL,
    0x510e527fade682d1ULL, 0x9b05688c2b3e6c1fULL,
    0x1f83d9abfb41bd6bULL, 0x5be0cd19137e2179ULL,
};
constexpr std::uint8_t sigma[12][16]{
    {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
    {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
    {11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4},
    {7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8},
    {9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13},
    {2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9},
    {12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11},
    {13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10},
    {6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5},
    {10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0},
    {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
    {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
};

std::uint64_t word(const std::uint8_t *bytes)
{
    std::uint64_t result = 0;
    for (unsigned i = 0; i < 8; ++i) result |= std::uint64_t(bytes[i]) << (8 * i);
    return result;
}

void mix(std::array<std::uint64_t, 16> &v, unsigned a, unsigned b,
    unsigned c, unsigned d, std::uint64_t x, std::uint64_t y)
{
    v[a] += v[b] + x; v[d] = std::rotr(v[d] ^ v[a], 32);
    v[c] += v[d]; v[b] = std::rotr(v[b] ^ v[c], 24);
    v[a] += v[b] + y; v[d] = std::rotr(v[d] ^ v[a], 16);
    v[c] += v[d]; v[b] = std::rotr(v[b] ^ v[c], 63);
}

void compress(std::array<std::uint64_t, 8> &h, const std::uint8_t *block,
    std::uint64_t low, std::uint64_t high, bool last)
{
    std::array<std::uint64_t, 16> m{}, v{};
    for (unsigned i = 0; i < 16; ++i) m[i] = word(block + i * 8);
    std::copy(h.begin(), h.end(), v.begin());
    std::copy(iv.begin(), iv.end(), v.begin() + 8);
    v[12] ^= low; v[13] ^= high;
    if (last) v[14] = ~v[14];
    for (unsigned r = 0; r < 12; ++r) {
        const auto &s = sigma[r];
        mix(v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
        mix(v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
        mix(v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
        mix(v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
        mix(v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
        mix(v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
        mix(v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
        mix(v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (unsigned i = 0; i < 8; ++i) h[i] ^= v[i] ^ v[i + 8];
}

} // namespace

std::array<std::uint8_t, 32> blake2b_256(const std::uint8_t *data, std::size_t size)
{
    auto h = iv;
    h[0] ^= 0x01010020ULL;
    std::uint64_t low = 0, high = 0;
    while (size > 128) {
        const auto previous = low;
        low += 128;
        if (low < previous) ++high;
        compress(h, data, low, high, false);
        data += 128; size -= 128;
    }
    std::array<std::uint8_t, 128> final{};
    if (size != 0) std::memcpy(final.data(), data, size);
    const auto previous = low;
    low += size;
    if (low < previous) ++high;
    compress(h, final.data(), low, high, true);
    std::array<std::uint8_t, 32> result{};
    for (unsigned i = 0; i < 4; ++i)
        for (unsigned j = 0; j < 8; ++j)
            result[i * 8 + j] = static_cast<std::uint8_t>(h[i] >> (8 * j));
    return result;
}

} // namespace scpefe::format
