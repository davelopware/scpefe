#pragma once

#include "scpefe/scpefe.h"

#include <cstdint>

namespace scpefe::core {

/* Adapts registered host callbacks to an object-oriented core interface. */
class HostServices {
public:
    /* Captures one host instance and its monotonic-clock callback. */
    HostServices(
        void *instance_data,
        scpefe_monotonic_time_ms_fn monotonic_time_ms
    );

    /* Reads the host monotonic clock, returning false on host failure. */
    bool read_monotonic_time_ms(std::uint64_t &time_ms) const;

private:
    void *instance_data_;
    scpefe_monotonic_time_ms_fn monotonic_time_ms_;
};

} // namespace scpefe::core
