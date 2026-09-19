#pragma once

#include <cstddef>
#include <cstdint>

namespace scpefe::security {

/* Estimates whether password bytes provide adequate resistance to offline guessing. */
bool password_is_strong(const std::uint8_t *password, std::size_t password_size);

} // namespace scpefe::security
