#include "security/password_strength.hpp"

#include "zxcvbn.h"

#include <algorithm>
#include <cstdint>
#include <limits>
#include <string_view>
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

bool is_uuid_v4(const std::uint8_t *password, std::size_t password_size)
{
    if (password_size != 36) return false;
    const std::string_view value{
        reinterpret_cast<const char *>(password), password_size};
    for (std::size_t index = 0; index < value.size(); ++index) {
        if (index == 8 || index == 13 || index == 18 || index == 23) {
            if (value[index] != '-') return false;
            continue;
        }
        const char character = value[index];
        const bool hexadecimal = (character >= '0' && character <= '9')
            || (character >= 'a' && character <= 'f')
            || (character >= 'A' && character <= 'F');
        if (!hexadecimal) return false;
    }
    const char version = value[14];
    const char variant = value[19];
    return version == '4'
        && (variant == '8' || variant == '9'
            || variant == 'a' || variant == 'A'
            || variant == 'b' || variant == 'B');
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

PasswordPolicyAssessment assess_password_policy(
    const std::uint8_t *password,
    std::size_t password_size
)
{
    if (password == nullptr || password_size == 0
        || password_size == std::numeric_limits<std::size_t>::max()) {
        return PasswordPolicyAssessment::invalid;
    }
    if (contains_nul(password, password_size)) {
        return PasswordPolicyAssessment::invalid;
    }
    if (password_size < 12) return PasswordPolicyAssessment::minimum_length;

    if (is_uuid_v4(password, password_size)) {
        return PasswordPolicyAssessment::accepted;
    }

    std::vector<char> terminated(password_size + 1, '\0');
    std::copy(password, password + password_size, terminated.begin());
    ZxcMatch_t *matches = nullptr;
    const double estimated_bits = ZxcvbnMatch(
        terminated.data(), nullptr, &matches);
    const bool strong = estimated_bits >= minimum_estimated_bits
        && !consists_only_of_repeat_matches(matches);
    ZxcvbnFreeInfo(matches);
    sodium_memzero(terminated.data(), terminated.size());
    return strong ? PasswordPolicyAssessment::accepted
        : PasswordPolicyAssessment::predictable;
}

} // namespace scpefe::security
