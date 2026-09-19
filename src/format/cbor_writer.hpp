#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace scpefe::format {

class CborWriter {
public:
    void unsigned_integer(std::uint64_t value);
    void array(std::size_t size);
    void map(std::size_t size);
    void bytes(const std::uint8_t *data, std::size_t size);
    void text(const char *data, std::size_t size);
    std::vector<std::uint8_t> take_output();

private:
    void head(std::uint8_t major, std::uint64_t value);
    std::vector<std::uint8_t> output_;
};

} // namespace scpefe::format
