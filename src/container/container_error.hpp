#pragma once

namespace scpefe::container {

/* Failure categories produced while creating or unlocking a container. */
enum class ContainerError {
    invalid_argument,
    malformed_container,
    unsupported_format,
    limit_exceeded,
    authentication_failed,
    weak_password,
    password_already_in_use,
    out_of_memory,
    crypto_error,
};

/* Carries a container failure category across the internal API boundary. */
struct ContainerFailure {
    ContainerError error;
};

} // namespace scpefe::container
