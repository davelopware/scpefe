#pragma once

#include <cstddef>
#include <cstdint>

namespace scpefe::security {

/* Classifies a candidate against the complete newly proposed password policy. */
enum class PasswordPolicyAssessment {
    invalid,
    accepted,
    minimum_length,
    predictable,
};

/* Applies and explains the complete policy for newly proposed password bytes. */
PasswordPolicyAssessment assess_password_policy(
    const std::uint8_t *password,
    std::size_t password_size
);

} // namespace scpefe::security
