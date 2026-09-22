#pragma once

namespace scpefe::format {

/* Internal failure categories translated to stable C ABI result codes. */
enum class RevisionError {
    invalid_argument,
    malformed_cbor,
    limit_exceeded,
    unsupported_format,
};

/* Exception payload used to stop revision parsing or validation. */
struct RevisionFailure {
    RevisionError error;
};

} // namespace scpefe::format
