#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace scpefe::format {

/* Produces canonical deterministic-CBOR values for revision records. */
class CborWriter {
public:
    /* Appends an unsigned integer. */
    void unsigned_integer(std::uint64_t value);
    /* Appends a definite array header. */
    void array(std::size_t size);
    /* Appends a definite map header. */
    void map(std::size_t size);
    /* Appends a definite byte string. */
    void bytes(const std::uint8_t *data, std::size_t size);
    /* Appends a definite UTF-8 text string. */
    void text(const char *data, std::size_t size);
    /* Transfers ownership of the completed encoding. */
    std::vector<std::uint8_t> take_output();

private:
    /* Appends the shortest valid header for a major type and value. */
    void head(std::uint8_t major, std::uint64_t value);
    std::vector<std::uint8_t> output_;
};

} // namespace scpefe::format
