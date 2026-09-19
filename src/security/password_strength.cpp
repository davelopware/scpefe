#include "security/password_strength.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <string_view>

namespace scpefe::security {
namespace {

constexpr double minimum_estimated_bits = 50.0;

bool repeats_short_pattern(const std::uint8_t *password, std::size_t size)
{
    for (std::size_t period = 1; period <= 4 && period * 2 <= size; ++period) {
        bool repeats = true;
        for (std::size_t index = period; index < size; ++index) {
            if (password[index] != password[index % period]) {
                repeats = false;
                break;
            }
        }
        if (repeats) return true;
    }
    return false;
}

bool is_common_password(const std::uint8_t *password, std::size_t size)
{
    constexpr std::array common{
        std::string_view{"passwordpassword"},
        std::string_view{"password123456"},
        std::string_view{"123456789012"},
        std::string_view{"qwertyuiopasdf"},
        std::string_view{"letmeinletmein"},
    };
    const std::string_view candidate{
        reinterpret_cast<const char *>(password), size};
    return std::find(common.begin(), common.end(), candidate) != common.end();
}

} // namespace

bool password_is_strong(const std::uint8_t *password, std::size_t password_size)
{
    if (password == nullptr || password_size == 0
        || repeats_short_pattern(password, password_size)
        || is_common_password(password, password_size)) {
        return false;
    }

    bool lower = false;
    bool upper = false;
    bool digit = false;
    bool space = false;
    bool symbol = false;
    bool non_ascii = false;
    std::array<bool, 256> seen{};
    std::size_t unique = 0;
    for (std::size_t index = 0; index < password_size; ++index) {
        const std::uint8_t value = password[index];
        if (!seen[value]) {
            seen[value] = true;
            ++unique;
        }
        lower = lower || (value >= 'a' && value <= 'z');
        upper = upper || (value >= 'A' && value <= 'Z');
        digit = digit || (value >= '0' && value <= '9');
        space = space || value == ' ';
        symbol = symbol || (value >= 0x21 && value <= 0x7e
            && !(value >= 'a' && value <= 'z')
            && !(value >= 'A' && value <= 'Z')
            && !(value >= '0' && value <= '9'));
        non_ascii = non_ascii || value >= 0x80;
    }
    const std::size_t observed_alphabet = (lower ? 26u : 0u) + (upper ? 26u : 0u)
        + (digit ? 10u : 0u) + (space ? 1u : 0u) + (symbol ? 32u : 0u)
        + (non_ascii ? 128u : 0u);
    const std::size_t estimated_alphabet = std::min(
        observed_alphabet, std::max<std::size_t>(2, unique * 2));
    return unique > 1
        && password_size * std::log2(static_cast<double>(estimated_alphabet))
            >= minimum_estimated_bits;
}

} // namespace scpefe::security
