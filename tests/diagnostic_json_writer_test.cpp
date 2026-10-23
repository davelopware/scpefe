#include "format/diagnostic_json_writer.hpp"
#include "format/revision_error.hpp"

#include <cstddef>
#include <cstdio>
#include <limits>
#include <string>

using scpefe::format::DiagnosticJsonWriter;
using scpefe::format::RevisionError;
using scpefe::format::RevisionFailure;

#define CHECK(condition) do { \
    if (!(condition)) { \
        std::fprintf(stderr, "diagnostic writer check failed at line %d\n", __LINE__); \
        return 1; \
    } \
} while (false)

int main()
{
    const char one = 'x';
    const std::string escaped(6u * 1024u * 1024u, '\x01');
    DiagnosticJsonWriter writer;
    try {
        writer.string(&one, std::numeric_limits<std::size_t>::max());
        CHECK(false);
    } catch (const RevisionFailure &failure) {
        CHECK(failure.error == RevisionError::limit_exceeded);
    }
    try {
        writer.string(escaped.data(), escaped.size());
        CHECK(false);
    } catch (const RevisionFailure &failure) {
        CHECK(failure.error == RevisionError::limit_exceeded);
    }
    const std::uint8_t byte = 0;
    try {
        writer.hex(&byte, std::numeric_limits<std::size_t>::max());
        CHECK(false);
    } catch (const RevisionFailure &failure) {
        CHECK(failure.error == RevisionError::limit_exceeded);
    }
    writer.string("a\n", 2);
    CHECK(writer.take_output() == "\"a\\n\"");

    DiagnosticJsonWriter pretty;
    pretty.raw(R"({"empty":[],"records":[{"value":)");
    const std::string punctuation = "a\"\\\n{},:[]";
    pretty.string(punctuation.data(), punctuation.size());
    pretty.raw(R"(,"ok":true,"missing":null,"number":-12.5}]})");
    CHECK(pretty.take_pretty_output() == R"({
  "empty": [],
  "records": [
    {
      "value": "a\"\\\n{},:[]",
      "ok": true,
      "missing": null,
      "number": -12.5
    }
  ]
})");
    CHECK(pretty.take_output().empty());

    DiagnosticJsonWriter limited;
    const std::string prefix = "{\"value\":\"", suffix = "\"}";
    limited.raw(prefix);
    limited.raw(std::string(DiagnosticJsonWriter::max_output_bytes
        - prefix.size() - suffix.size(), 'x'));
    limited.raw(suffix);
    try {
        (void)limited.take_pretty_output();
        CHECK(false);
    } catch (const RevisionFailure &failure) {
        CHECK(failure.error == RevisionError::limit_exceeded);
    }
    return 0;
}
