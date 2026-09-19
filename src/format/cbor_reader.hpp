#pragma once

#include "format/revision_error.hpp"
#include "format/revision_limits.hpp"

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace scpefe::format {

/* Reads the strict deterministic-CBOR subset used by revision records. */
class CborReader {
public:
    /* Creates a bounded reader over caller-owned encoded bytes. */
    CborReader(const std::uint8_t *data, std::size_t size, const RevisionLimits &limits);
    /* Reads one unsigned integer. */
    std::uint64_t unsigned_integer();
    /* Reads and verifies an expected unsigned integer. */
    void expect_unsigned(std::uint64_t expected);
    /* Reads a definite array header at the supplied nesting depth. */
    std::size_t array(std::size_t depth);
    /* Reads a definite map header at the supplied nesting depth. */
    std::size_t map(std::size_t depth);
    /* Reads a bounded byte string, optionally enforcing its exact size. */
    std::vector<std::uint8_t> bytes(std::size_t required_size = 0);
    /* Reads a bounded, strictly valid UTF-8 text string. */
    std::string text();
    /* Reports whether every encoded byte has been consumed. */
    bool finished() const;

private:
    /* Stops parsing with the supplied structured revision error. */
    [[noreturn]] static void fail(RevisionError error);
    /* Verifies that the requested bytes remain available. */
    void require_available(std::uint64_t count);
    /* Reads a bounded array or map header. */
    std::size_t collection(std::uint8_t major, std::size_t depth);
    /* Reads and canonicality-checks one CBOR item header. */
    std::uint64_t head(std::uint8_t expected_major);

    const std::uint8_t *data_;
    std::size_t size_;
    std::size_t position_{};
    const RevisionLimits &limits_;
};

} // namespace scpefe::format
