#pragma once

namespace scpefe::format {

enum class RevisionError {
    invalid_argument,
    malformed_cbor,
    limit_exceeded,
    unsupported_format,
};

struct RevisionFailure {
    RevisionError error;
};

} // namespace scpefe::format
