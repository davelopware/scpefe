#include "scpefe/scpefe.h"

#include <cstdint>
#include <iostream>
#include <string_view>

namespace {

struct deterministic_host {
    std::uint64_t monotonic_time_ms;
};

scpefe_status read_monotonic_time(void *instance_data, std::uint64_t *time_ms)
{
    if (instance_data == nullptr || time_ms == nullptr) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }

    const auto *host = static_cast<const deterministic_host *>(instance_data);
    *time_ms = host->monotonic_time_ms;
    return SCPEFE_STATUS_OK;
}
int report_health()
{
    deterministic_host host{424242};
    const scpefe_host_services_v1 host_services{
        sizeof(scpefe_host_services_v1),
        SCPEFE_ABI_VERSION,
        &host,
        read_monotonic_time,
    };

    scpefe_context *context = nullptr;
    const scpefe_status create_status = scpefe_context_create(
        &host_services,
        &context
    );
    if (create_status != SCPEFE_STATUS_OK) {
        std::cerr << "{\"status\":\"error\",\"code\":" << create_status << "}\n";
        return 1;
    }

    scpefe_health_info_v1 health{};
    health.struct_size = sizeof(scpefe_health_info_v1);
    const scpefe_status health_status = scpefe_context_health(context, &health);
    scpefe_context_destroy(context);

    if (health_status != SCPEFE_STATUS_OK) {
        std::cerr << "{\"status\":\"error\",\"code\":" << health_status << "}\n";
        return 1;
    }

    std::cout
        << "{\"status\":\"ok\""
        << ",\"abi_version\":" << health.abi_version
        << ",\"library_version\":\"" << health.library_version_major << '.'
        << health.library_version_minor << '.' << health.library_version_patch << '"'
        << ",\"host_monotonic_time_ms\":" << health.host_monotonic_time_ms
        << "}\n";
    return 0;
}

void print_usage(const char *program)
{
    std::cerr << "Usage: " << program << " <health|version>\n";
}

} // namespace

int main(int argc, char **argv)
{
    if (argc != 2) {
        print_usage(argv[0]);
        return 2;
    }

    const std::string_view operation{argv[1]};
    if (operation == "health") {
        return report_health();
    }
    if (operation == "version") {
        std::cout << "{\"abi_version\":" << scpefe_abi_version()
                  << ",\"library_version\":\"" << scpefe_library_version()
                  << "\"}\n";
        return 0;
    }

    print_usage(argv[0]);
    return 2;
}
