#include "format/cbor_writer.hpp"

#include <utility>

namespace scpefe::format {

void CborWriter::unsigned_integer(std::uint64_t value) { head(0, value); }
void CborWriter::array(std::size_t size) { head(4, size); }
void CborWriter::map(std::size_t size) { head(5, size); }

void CborWriter::bytes(const std::uint8_t *data, std::size_t size)
{
    head(2, size);
    if (size != 0) output_.insert(output_.end(), data, data + size);
}

void CborWriter::text(const char *data, std::size_t size)
{
    head(3, size);
    if (size != 0) {
        const auto *first = reinterpret_cast<const std::uint8_t *>(data);
        output_.insert(output_.end(), first, first + size);
    }
}

std::vector<std::uint8_t> CborWriter::take_output()
{
    return std::move(output_);
}

void CborWriter::head(std::uint8_t major, std::uint64_t value)
{
    if (value < 24) {
        output_.push_back(static_cast<std::uint8_t>((major << 5u) | value));
        return;
    }
    const std::size_t bytes = value <= 0xffu ? 1 : value <= 0xffffu ? 2
        : value <= 0xffffffffu ? 4 : 8;
    const std::uint8_t info = bytes == 1 ? 24 : bytes == 2 ? 25
        : bytes == 4 ? 26 : 27;
    output_.push_back(static_cast<std::uint8_t>((major << 5u) | info));
    for (std::size_t shift = bytes; shift > 0; --shift) {
        output_.push_back(static_cast<std::uint8_t>(value >> ((shift - 1) * 8u)));
    }
}

} // namespace scpefe::format
