#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace scpefe::format {

/* Builds compact diagnostic JSON with consistent escaping and hex encoding. */
class DiagnosticJsonWriter {
public:
    /* Maximum diagnostic JSON bytes, excluding the caller's terminating NUL. */
    static constexpr std::size_t max_output_bytes = 32u * 1024u * 1024u;
    /* Wipes any retained output, including incomplete content on failure. */
    ~DiagnosticJsonWriter();
    /* Appends trusted JSON syntax or already-encoded content. */
    void raw(const std::string &value);
    /* Appends one JSON syntax character. */
    void character(char value);
    /* Appends a correctly escaped JSON string. */
    void string(const char *data, std::size_t size);
    /* Appends bytes as a quoted lowercase hexadecimal string. */
    void hex(const std::uint8_t *data, std::size_t size);
    /* Transfers ownership of the completed JSON document. */
    std::string take_output();

private:
    /* Rejects any append that would exceed the diagnostic output contract. */
    void ensure_room(std::size_t additional);
    std::string output_;
};

} // namespace scpefe::format
