#include "security/password_strength.hpp"

#include "zxcvbn.h"

#include <algorithm>
#include <cstdint>
#include <limits>
#include <vector>

extern "C" void sodium_memzero(void *buffer, std::size_t size);

namespace scpefe::security {
namespace {

/* Requires substantial resistance to offline guessing with the document KDF. */
constexpr double minimum_estimated_bits = 80.0;

bool contains_nul(const std::uint8_t *password, std::size_t password_size)
{
    return std::find(password, password + password_size, std::uint8_t{0})
        != password + password_size;
}

bool consists_only_of_repeat_matches(const ZxcMatch_t *match)
{
    if (match == nullptr) return false;
    for (const ZxcMatch_t *current = match; current != nullptr;
        current = current->Next) {
        const int type = static_cast<int>(current->Type);
        const int base_type = type & ~static_cast<int>(MULTIPLE_MATCH);
        if (base_type != static_cast<int>(REPEATS_MATCH)
            && (type & static_cast<int>(MULTIPLE_MATCH)) == 0) return false;
    }
    return true;
}

} // namespace

bool password_is_strong(const std::uint8_t *password, std::size_t password_size)
{
    if (password == nullptr || password_size == 0
        || password_size == std::numeric_limits<std::size_t>::max()
        || contains_nul(password, password_size)) return false;

    std::vector<char> terminated(password_size + 1, '\0');
    std::copy(password, password + password_size, terminated.begin());
    ZxcMatch_t *matches = nullptr;
    const double estimated_bits = ZxcvbnMatch(
        terminated.data(), nullptr, &matches);
    const bool strong = estimated_bits >= minimum_estimated_bits
        && !consists_only_of_repeat_matches(matches);
    ZxcvbnFreeInfo(matches);
    sodium_memzero(terminated.data(), terminated.size());
    return strong;
}

} // namespace scpefe::security
