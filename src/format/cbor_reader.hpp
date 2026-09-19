#pragma once

#include "format/revision_error.hpp"
#include "format/revision_limits.hpp"

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace scpefe::format {

class CborReader {
public:
    CborReader(const std::uint8_t *data, std::size_t size, const RevisionLimits &limits);
    std::uint64_t unsigned_integer();
    void expect_unsigned(std::uint64_t expected);
    std::size_t array(std::size_t depth);
    std::size_t map(std::size_t depth);
    std::vector<std::uint8_t> bytes(std::size_t required_size = 0);
    std::string text();
    bool finished() const;

private:
    [[noreturn]] static void fail(RevisionError error);
    void require_available(std::uint64_t count);
    std::size_t collection(std::uint8_t major, std::size_t depth);
    std::uint64_t head(std::uint8_t expected_major);

    const std::uint8_t *data_;
    std::size_t size_;
    std::size_t position_{};
    const RevisionLimits &limits_;
};

} // namespace scpefe::format
