#include "scpefe/scpefe.h"

#include "format/text_validation.hpp"
#include "security/password_strength.hpp"

int scpefe_password_meets_policy(const std::uint8_t *password,
    std::size_t password_size)
{
    return scpefe_assess_password_policy(password, password_size)
        == SCPEFE_PASSWORD_POLICY_ACCEPTED;
}

scpefe_password_policy_assessment scpefe_assess_password_policy(
    const std::uint8_t *password, std::size_t password_size)
{
    if (!scpefe::format::span_is_valid(password, password_size))
        return SCPEFE_PASSWORD_POLICY_INVALID;
    using scpefe::security::PasswordPolicyAssessment;
    switch (scpefe::security::assess_password_policy(password, password_size)) {
    case PasswordPolicyAssessment::accepted:
        return SCPEFE_PASSWORD_POLICY_ACCEPTED;
    case PasswordPolicyAssessment::minimum_length:
        return SCPEFE_PASSWORD_POLICY_MINIMUM_LENGTH;
    case PasswordPolicyAssessment::predictable:
        return SCPEFE_PASSWORD_POLICY_PREDICTABLE;
    case PasswordPolicyAssessment::invalid:
        return SCPEFE_PASSWORD_POLICY_INVALID;
    }
    return SCPEFE_PASSWORD_POLICY_INVALID;
}
