#pragma once

#include <cstdint>

namespace scpefe::core {

struct HealthInfo {
    std::uint64_t host_monotonic_time_ms;
};

} // namespace scpefe::core
