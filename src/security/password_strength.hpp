#pragma once

#include <cstddef>
#include <cstdint>

namespace scpefe::security {

/* Applies the complete policy for newly proposed password bytes. */
bool password_meets_policy(const std::uint8_t *password, std::size_t password_size);

} // namespace scpefe::security
