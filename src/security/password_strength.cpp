#include "security/password_strength.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <string_view>

namespace scpefe::security {
namespace {

constexpr double minimum_estimated_bits = 50.0;

constexpr std::array common_words{
    std::string_view{"admin"}, std::string_view{"dragon"},
    std::string_view{"football"}, std::string_view{"hello"},
    std::string_view{"iloveyou"}, std::string_view{"letmein"},
    std::string_view{"login"}, std::string_view{"master"},
    std::string_view{"monkey"}, std::string_view{"password"},
    std::string_view{"princess"}, std::string_view{"qwerty"},
    std::string_view{"secret"}, std::string_view{"trustnoone"},
    std::string_view{"welcome"},
};

std::uint8_t folded(std::uint8_t value)
{
    if (value >= 'A' && value <= 'Z') return value - 'A' + 'a';
    return value;
}

std::uint8_t normalized_word_character(std::uint8_t value)
{
    value = folded(value);
    switch (value) {
    case '0': return 'o';
    case '1': return 'i';
    case '3': return 'e';
    case '4': case '@': return 'a';
    case '5': case '$': return 's';
    case '7': return 't';
    default: return value;
    }
}

bool normalized_word_at(const std::uint8_t *password, std::size_t size,
    std::size_t offset, std::string_view word)
{
    if (offset > size || word.size() > size - offset) return false;
    for (std::size_t index = 0; index < word.size(); ++index) {
        if (normalized_word_character(password[offset + index])
            != static_cast<std::uint8_t>(word[index])) return false;
    }
    return true;
}

bool repeats_pattern(const std::uint8_t *password, std::size_t size)
{
    for (std::size_t period = 1; period <= size / 2; ++period) {
        if (size % period != 0) continue;
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

int keyboard_position(std::uint8_t value, std::string_view row)
{
    const std::size_t position = row.find(static_cast<char>(folded(value)));
    return position == std::string_view::npos
        ? -100 : static_cast<int>(position);
}

std::size_t longest_sequence(const std::uint8_t *password, std::size_t size)
{
    constexpr std::array rows{
        std::string_view{"1234567890"},
        std::string_view{"qwertyuiop"},
        std::string_view{"asdfghjkl"},
        std::string_view{"zxcvbnm"},
    };
    std::size_t longest = size == 0 ? 0 : 1;
    std::size_t linear = 1;
    int previous_delta = 0;
    for (std::size_t index = 1; index < size; ++index) {
        const int delta = static_cast<int>(folded(password[index]))
            - static_cast<int>(folded(password[index - 1]));
        if ((delta == 1 || delta == -1) && delta == previous_delta) {
            ++linear;
        } else {
            linear = (delta == 1 || delta == -1) ? 2 : 1;
        }
        previous_delta = delta;
        longest = std::max(longest, linear);
    }
    for (const std::string_view row : rows) {
        std::size_t run = 1;
        int previous_step = 0;
        for (std::size_t index = 1; index < size; ++index) {
            const int step = keyboard_position(password[index], row)
                - keyboard_position(password[index - 1], row);
            if ((step == 1 || step == -1) && step == previous_step) {
                ++run;
            } else {
                run = (step == 1 || step == -1) ? 2 : 1;
            }
            previous_step = step;
            longest = std::max(longest, run);
        }
    }
    return longest;
}

bool is_ascii_letter(std::uint8_t value)
{
    value = folded(value);
    return value >= 'a' && value <= 'z';
}

bool same_folded_word(const std::uint8_t *password,
    std::size_t first, std::size_t second, std::size_t size)
{
    for (std::size_t index = 0; index < size; ++index) {
        if (folded(password[first + index]) != folded(password[second + index]))
            return false;
    }
    return true;
}

bool is_common_word(const std::uint8_t *password,
    std::size_t offset, std::size_t size)
{
    for (const std::string_view word : common_words) {
        if (word.size() == size && normalized_word_at(
            password, offset + size, offset, word)) return true;
    }
    return false;
}

double separated_passphrase_bits(const std::uint8_t *password, std::size_t size)
{
    std::size_t words = 0;
    std::size_t previous_start = 0;
    std::size_t previous_size = 0;
    double bits = 0.0;
    for (std::size_t index = 0; index < size;) {
        if (!is_ascii_letter(password[index])) {
            ++index;
            continue;
        }
        const std::size_t start = index;
        while (index < size && is_ascii_letter(password[index])) ++index;
        const std::size_t word_size = index - start;
        ++words;
        if (word_size == previous_size
            && same_folded_word(password, previous_start, start, word_size)) {
            bits += 1.0;
        } else if (word_size < 3) {
            bits += 3.0;
        } else {
            bits += is_common_word(password, start, word_size) ? 6.0 : 12.0;
        }
        previous_start = start;
        previous_size = word_size;
    }
    return words >= 4 ? bits : 0.0;
}

bool has_common_structure(const std::uint8_t *password, std::size_t size)
{
    for (const std::string_view word : common_words) {
        if (word.size() > size) continue;
        for (std::size_t offset = 0; offset <= size - word.size(); ++offset) {
            if (!normalized_word_at(password, size, offset, word)) continue;
            if (size <= word.size() + 8) return true;
        }
    }
    return false;
}

double brute_force_bits(const std::uint8_t *password, std::size_t size)
{
    bool lower = false;
    bool upper = false;
    bool digit = false;
    bool space = false;
    bool symbol = false;
    bool non_ascii = false;
    std::array<std::size_t, 256> frequencies{};
    std::size_t unique = 0;
    std::size_t runs = size == 0 ? 0 : 1;
    std::size_t current_run = size == 0 ? 0 : 1;
    std::size_t longest_run = current_run;
    for (std::size_t index = 0; index < size; ++index) {
        const std::uint8_t value = password[index];
        if (frequencies[value]++ == 0) ++unique;
        if (index != 0) {
            if (value == password[index - 1]) {
                ++current_run;
                longest_run = std::max(longest_run, current_run);
            } else {
                ++runs;
                current_run = 1;
            }
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
    if (unique < 2) return 0.0;
    if (longest_run >= 4 && runs <= unique * 2) return 0.0;
    const std::size_t observed_alphabet = (lower ? 26u : 0u)
        + (upper ? 26u : 0u) + (digit ? 10u : 0u) + (space ? 1u : 0u)
        + (symbol ? 32u : 0u) + (non_ascii ? 128u : 0u);
    const std::size_t estimated_alphabet = std::min(
        observed_alphabet, std::max<std::size_t>(2, unique * 2));
    double sampled_bits = 0.0;
    for (const std::size_t frequency : frequencies) {
        if (frequency == 0) continue;
        sampled_bits += frequency * std::log2(
            static_cast<double>(size) / static_cast<double>(frequency));
    }
    const double unseen_symbol_allowance = 1.5 * static_cast<double>(unique);
    return std::min(
        size * std::log2(static_cast<double>(estimated_alphabet)),
        sampled_bits + unseen_symbol_allowance);
}

} // namespace

bool password_is_strong(const std::uint8_t *password, std::size_t password_size)
{
    if (password == nullptr || password_size == 0
        || repeats_pattern(password, password_size)
        || has_common_structure(password, password_size)) return false;

    const std::size_t sequence = longest_sequence(password, password_size);
    if (sequence >= 6 && sequence >= password_size - password_size / 2)
        return false;

    const double passphrase_bits = separated_passphrase_bits(
        password, password_size);
    const double estimated_bits = passphrase_bits > 0.0
        ? passphrase_bits : brute_force_bits(password, password_size);
    return estimated_bits >= minimum_estimated_bits;
}

} // namespace scpefe::security
