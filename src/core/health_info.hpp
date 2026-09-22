#pragma once

#include <cstdint>

namespace scpefe::core {

/* Internal health values before conversion to the public C representation. */
struct HealthInfo {
    std::uint64_t host_monotonic_time_ms;
};

} // namespace scpefe::core
