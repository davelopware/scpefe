#include "scpefe/scpefe.h"
#include "password_input.hpp"

#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <string_view>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

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

int report_revision(const char *path, bool include_content)
{
    std::ifstream input(path, std::ios::binary);
    if (!input) {
        std::cerr << "{\"status\":\"error\",\"message\":\"cannot open input\"}\n";
        return 1;
    }
    scpefe_revision_limits_v1 limits{};
    limits.struct_size = sizeof(limits);
    scpefe_status status = scpefe_revision_limits_default(&limits);
    if (status != SCPEFE_STATUS_OK) {
        std::cerr << "{\"status\":\"error\",\"code\":" << status << "}\n";
        return 1;
    }
    input.seekg(0, std::ios::end);
    const std::streamoff input_size = input.tellg();
    if (input_size < 0
        || static_cast<std::uintmax_t>(input_size) > limits.max_input_bytes) {
        std::cerr << "{\"status\":\"error\",\"code\":"
                  << SCPEFE_STATUS_LIMIT_EXCEEDED << "}\n";
        return 1;
    }
    input.seekg(0, std::ios::beg);
    const std::vector<char> input_chars{
        std::istreambuf_iterator<char>{input},
        std::istreambuf_iterator<char>{},
    };
    const auto *encoded = reinterpret_cast<const std::uint8_t *>(
        input_chars.data()
    );

    std::size_t json_size = 0;
    status = scpefe_snapshot_revision_diagnostic_json(
        encoded,
        input_chars.size(),
        &limits,
        include_content ? 1 : 0,
        nullptr,
        0,
        &json_size
    );
    if (status != SCPEFE_STATUS_BUFFER_TOO_SMALL) {
        std::cerr << "{\"status\":\"error\",\"code\":" << status << "}\n";
        return 1;
    }
    std::vector<char> json(json_size + 1);
    status = scpefe_snapshot_revision_diagnostic_json(
        encoded,
        input_chars.size(),
        &limits,
        include_content ? 1 : 0,
        json.data(),
        json.size(),
        &json_size
    );
    if (status != SCPEFE_STATUS_OK) {
        std::cerr << "{\"status\":\"error\",\"code\":" << status << "}\n";
        return 1;
    }
    std::cout << json.data() << '\n';
    return 0;
}

int report_error(scpefe_status status)
{
    std::cerr << "{\"status\":\"error\",\"code\":" << status << "}\n";
    return 1;
}

int report_container(const char *path, bool include_content, bool password_stdin)
{
    std::ifstream input(path, std::ios::binary | std::ios::ate);
    if (!input) return report_error(SCPEFE_STATUS_HOST_ERROR);
    const auto size = input.tellg();
    if (size < 0) return report_error(SCPEFE_STATUS_HOST_ERROR);
    if (static_cast<std::uintmax_t>(size) > SCPEFE_DIAGNOSTIC_MAX_CONTAINER_BYTES)
        return report_error(SCPEFE_STATUS_LIMIT_EXCEEDED);
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size));
    input.seekg(0);
    if (!input.read(reinterpret_cast<char *>(bytes.data()), size))
        return report_error(SCPEFE_STATUS_HOST_ERROR);
    if (input.peek() != std::char_traits<char>::eof())
        return report_error(SCPEFE_STATUS_LIMIT_EXCEEDED);
    PasswordInput password;
    auto status = password.read(password_stdin);
    if (status != SCPEFE_STATUS_OK) return report_error(status);
    scpefe_revision_limits_v1 limits{};
    limits.struct_size = sizeof(limits);
    status = scpefe_revision_limits_default(&limits);
    if (status != SCPEFE_STATUS_OK) return report_error(status);
    const scpefe_container_diagnostic_v1 request{sizeof(request), SCPEFE_ABI_VERSION,
        bytes.data(), bytes.size(), password.data(), password.size(), &limits,
        include_content ? 1 : 0};
    std::size_t json_size = 0;
    status = scpefe_container_diagnostic_json(&request, nullptr, 0, &json_size);
    if (status != SCPEFE_STATUS_BUFFER_TOO_SMALL) return report_error(status);
    std::vector<char> json(json_size + 1);
    status = scpefe_container_diagnostic_json(&request, json.data(), json.size(), &json_size);
    password.clear();
    if (status == SCPEFE_STATUS_OK) std::cout.write(json.data(), json_size) << '\n';
    volatile char *clear = json.data();
    for (std::size_t i = 0; i < json.size(); ++i) clear[i] = 0;
    return status != SCPEFE_STATUS_OK ? report_error(status)
        : std::cout ? 0 : report_error(SCPEFE_STATUS_HOST_ERROR);
}

void print_usage(const char *program)
{
    std::cerr << "Usage: " << program << " <health|version>\n"
              << "       " << program
              << " revision <cbor-path> [--include-content]\n";
    std::cerr << "       " << program
              << " inspect <scpefe-path> [--password-stdin] [--include-content]\n";
}

} // namespace

int main(int argc, char **argv)
{
#ifdef _WIN32
    // Preserve the core's JSON bytes and LF terminator when stdout is redirected.
    if (_setmode(_fileno(stdout), _O_BINARY) == -1)
        return report_error(SCPEFE_STATUS_HOST_ERROR);
#endif
    if (argc < 2) {
        print_usage(argv[0]);
        return 2;
    }

    const std::string_view operation{argv[1]};
    if (operation == "inspect") {
        if (argc < 3) return report_error(SCPEFE_STATUS_INVALID_ARGUMENT);
        bool include_content = false, password_stdin = false;
        for (int i = 3; i < argc; ++i) {
            const std::string_view flag{argv[i]};
            if (flag == "--include-content" && !include_content) include_content = true;
            else if (flag == "--password-stdin" && !password_stdin) password_stdin = true;
            else return report_error(SCPEFE_STATUS_INVALID_ARGUMENT);
        }
        try { return report_container(argv[2], include_content, password_stdin); }
        catch (const std::bad_alloc &) { return report_error(SCPEFE_STATUS_OUT_OF_MEMORY); }
        catch (...) { return report_error(SCPEFE_STATUS_HOST_ERROR); }
    }
    if (operation == "health") {
        if (argc != 2) {
            print_usage(argv[0]);
            return 2;
        }
        return report_health();
    }
    if (operation == "version") {
        if (argc != 2) {
            print_usage(argv[0]);
            return 2;
        }
        std::cout << "{\"abi_version\":" << scpefe_abi_version()
                  << ",\"library_version\":\"" << scpefe_library_version()
                  << "\"}\n";
        return 0;
    }
    if (operation == "revision" && (argc == 3 || argc == 4)) {
        const bool include_content = argc == 4
            && std::string_view{argv[3]} == "--include-content";
        if (argc == 4 && !include_content) {
            print_usage(argv[0]);
            return 2;
        }
        return report_revision(argv[2], include_content);
    }

    print_usage(argv[0]);
    return 2;
}
