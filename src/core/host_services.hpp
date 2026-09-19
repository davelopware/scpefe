#pragma once

#include "scpefe/scpefe.h"

#include <cstdint>

namespace scpefe::core {

class HostServices {
public:
    HostServices(
        void *instance_data,
        scpefe_monotonic_time_ms_fn monotonic_time_ms
    );

    bool read_monotonic_time_ms(std::uint64_t &time_ms) const;

private:
    void *instance_data_;
    scpefe_monotonic_time_ms_fn monotonic_time_ms_;
};

} // namespace scpefe::core
