#include "format/diagnostic_json_writer.hpp"
#include "format/revision_error.hpp"
#include "format/clear_memory.hpp"

#include <algorithm>
#include <utility>

namespace scpefe::format {

DiagnosticJsonWriter::~DiagnosticJsonWriter()
{
    clear_memory(output_.data(), output_.size());
}

void DiagnosticJsonWriter::ensure_room(std::size_t additional)
{
    if (additional > max_output_bytes - output_.size())
        throw RevisionFailure{RevisionError::limit_exceeded};
    if (output_.size() + additional <= output_.capacity()) return;
    std::string grown;
    const auto required = output_.size() + additional;
    grown.reserve(std::max(required, std::min(max_output_bytes, output_.capacity() * 2)));
    grown.assign(output_);
    clear_memory(output_.data(), output_.size());
    output_.swap(grown);
}

void DiagnosticJsonWriter::raw(const std::string &value)
{
    ensure_room(value.size());
    output_ += value;
}

void DiagnosticJsonWriter::character(char value)
{
    ensure_room(1);
    output_.push_back(value);
}

void DiagnosticJsonWriter::string(const char *data, std::size_t size)
{
    static constexpr char hex_digits[] = "0123456789abcdef";
    ensure_room(2);
    if (size > max_output_bytes - output_.size() - 2)
        throw RevisionFailure{RevisionError::limit_exceeded};
    std::size_t encoded_size = 2;
    for (std::size_t index = 0; index < size; ++index) {
        const auto value = static_cast<unsigned char>(data[index]);
        const std::size_t additional = value < 0x20
            ? (value == '\b' || value == '\f' || value == '\n'
                || value == '\r' || value == '\t' ? 2 : 6)
            : (value == '"' || value == '\\' ? 2 : 1);
        if (additional > max_output_bytes - output_.size() - encoded_size)
            throw RevisionFailure{RevisionError::limit_exceeded};
        encoded_size += additional;
    }
    ensure_room(encoded_size);
    output_.push_back('"');
    for (std::size_t index = 0; index < size; ++index) {
        const unsigned char value = static_cast<unsigned char>(data[index]);
        switch (value) {
        case '"': output_ += "\\\""; break;
        case '\\': output_ += "\\\\"; break;
        case '\b': output_ += "\\b"; break;
        case '\f': output_ += "\\f"; break;
        case '\n': output_ += "\\n"; break;
        case '\r': output_ += "\\r"; break;
        case '\t': output_ += "\\t"; break;
        default:
            if (value < 0x20) {
                output_ += "\\u00";
                output_.push_back(hex_digits[value >> 4u]);
                output_.push_back(hex_digits[value & 0x0fu]);
            } else {
                output_.push_back(static_cast<char>(value));
            }
        }
    }
    output_.push_back('"');
}

void DiagnosticJsonWriter::hex(const std::uint8_t *data, std::size_t size)
{
    static constexpr char hex_digits[] = "0123456789abcdef";
    ensure_room(2);
    if (size > (max_output_bytes - output_.size() - 2) / 2)
        throw RevisionFailure{RevisionError::limit_exceeded};
    ensure_room(2 + size * 2);
    output_.push_back('"');
    for (std::size_t index = 0; index < size; ++index) {
        output_.push_back(hex_digits[data[index] >> 4u]);
        output_.push_back(hex_digits[data[index] & 0x0fu]);
    }
    output_.push_back('"');
}

std::string DiagnosticJsonWriter::take_output()
{
    return std::move(output_);
}

std::string DiagnosticJsonWriter::take_pretty_output()
{
    DiagnosticJsonWriter pretty;
    std::size_t depth = 0;
    bool in_string = false, escaped = false;
    const auto new_line = [&] {
        if (depth > max_output_bytes / 2)
            throw RevisionFailure{RevisionError::limit_exceeded};
        pretty.character('\n');
        pretty.raw(std::string(depth * 2, ' '));
    };
    // This only formats trusted JSON already produced by this writer. Strings,
    // including escaped quotes, punctuation and UTF-8 bytes, stay byte-identical.
    for (std::size_t i = 0; i < output_.size(); ++i) {
        const char value = output_[i];
        if (in_string) {
            pretty.character(value);
            if (escaped) escaped = false;
            else if (value == '\\') escaped = true;
            else if (value == '"') in_string = false;
            continue;
        }
        switch (value) {
        case '"':
            in_string = true;
            pretty.character(value);
            break;
        case '{':
        case '[':
            pretty.character(value);
            ++depth;
            if (i + 1 < output_.size() && output_[i + 1] != (value == '{' ? '}' : ']'))
                new_line();
            break;
        case '}':
        case ']':
            if (depth == 0) throw RevisionFailure{RevisionError::invalid_argument};
            --depth;
            if (i > 0 && output_[i - 1] != (value == '}' ? '{' : '[')) new_line();
            pretty.character(value);
            break;
        case ',':
            pretty.character(value);
            new_line();
            break;
        case ':': pretty.raw(": "); break;
        default: pretty.character(value); break;
        }
    }
    auto result = pretty.take_output();
    clear_memory(output_.data(), output_.size());
    output_.clear();
    return result;
}

} // namespace scpefe::format
