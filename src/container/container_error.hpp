#pragma once

namespace scpefe::container {

/* Failure categories produced while creating or unlocking a container. */
enum class ContainerError {
    invalid_argument,
    malformed_container,
    unsupported_format,
    authentication_failed,
    out_of_memory,
    crypto_error,
};

/* Carries a container failure category across the internal API boundary. */
struct ContainerFailure {
    ContainerError error;
};

} // namespace scpefe::container
