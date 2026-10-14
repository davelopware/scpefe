#include "format/diagnostic_json_writer.hpp"
#include "format/revision_error.hpp"

#include <utility>

namespace scpefe::format {

void DiagnosticJsonWriter::ensure_room(std::size_t additional) const
{
    if (additional > max_output_bytes - output_.size())
        throw RevisionFailure{RevisionError::limit_exceeded};
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
    output_.reserve(output_.size() + encoded_size);
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
    output_.reserve(output_.size() + 2 + size * 2);
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

} // namespace scpefe::format
