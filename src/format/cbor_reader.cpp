#include "format/cbor_reader.hpp"

#include "format/text_validation.hpp"

#include <limits>

namespace scpefe::format {

CborReader::CborReader(
    const std::uint8_t *data,
    std::size_t size,
    const RevisionLimits &limits
) : data_(data), size_(size), limits_(limits)
{
}

std::uint64_t CborReader::unsigned_integer() { return head(0); }
void CborReader::expect_unsigned(std::uint64_t expected)
{
    if (unsigned_integer() != expected) fail(RevisionError::malformed_cbor);
}
bool CborReader::boolean()
{
    require_available(1);
    const std::uint8_t value = data_[position_++];
    if (value == 0xf4u) return false;
    if (value == 0xf5u) return true;
    fail(RevisionError::malformed_cbor);
}
std::size_t CborReader::array(std::size_t depth) { return collection(4, depth); }
std::size_t CborReader::map(std::size_t depth) { return collection(5, depth); }

std::vector<std::uint8_t> CborReader::bytes(
    std::size_t required_size,
    std::size_t maximum_size)
{
    const std::uint64_t length = head(2);
    const std::size_t limit = maximum_size == 0
        ? limits_.max_byte_string_bytes() : maximum_size;
    if (length > limit) fail(RevisionError::limit_exceeded);
    if (required_size != 0 && length != required_size) fail(RevisionError::malformed_cbor);
    require_available(length);
    std::vector<std::uint8_t> value(data_ + position_, data_ + position_ + length);
    position_ += static_cast<std::size_t>(length);
    return value;
}

std::string CborReader::text()
{
    const std::uint64_t length = head(3);
    if (length > limits_.max_text_bytes()) fail(RevisionError::limit_exceeded);
    require_available(length);
    const char *value = reinterpret_cast<const char *>(data_ + position_);
    if (!valid_utf8(value, static_cast<std::size_t>(length))) {
        fail(RevisionError::malformed_cbor);
    }
    position_ += static_cast<std::size_t>(length);
    return std::string(value, static_cast<std::size_t>(length));
}

bool CborReader::finished() const { return position_ == size_; }

[[noreturn]] void CborReader::fail(RevisionError error)
{
    throw RevisionFailure{error};
}

void CborReader::require_available(std::uint64_t count)
{
    if (count > size_ - position_) fail(RevisionError::malformed_cbor);
}

std::size_t CborReader::collection(std::uint8_t major, std::size_t depth)
{
    if (depth > limits_.max_nesting_depth()) fail(RevisionError::limit_exceeded);
    const std::uint64_t count = head(major);
    if (count > limits_.max_collection_entries()
        || count > std::numeric_limits<std::size_t>::max()) {
        fail(RevisionError::limit_exceeded);
    }
    return static_cast<std::size_t>(count);
}

std::uint64_t CborReader::head(std::uint8_t expected_major)
{
    require_available(1);
    const std::uint8_t initial = data_[position_++];
    const std::uint8_t major = initial >> 5u;
    const std::uint8_t info = initial & 0x1fu;
    if (major != expected_major || info >= 28) fail(RevisionError::malformed_cbor);
    if (info < 24) return info;
    const std::size_t count = info == 24 ? 1 : info == 25 ? 2
        : info == 26 ? 4 : 8;
    require_available(count);
    std::uint64_t value = 0;
    for (std::size_t offset = 0; offset < count; ++offset) {
        value = (value << 8u) | data_[position_++];
    }
    const std::uint64_t minimum = count == 1 ? 24u : count == 2 ? 0x100u
        : count == 4 ? 0x10000u : 0x100000000ull;
    if (value < minimum) fail(RevisionError::malformed_cbor);
    return value;
}

} // namespace scpefe::format
