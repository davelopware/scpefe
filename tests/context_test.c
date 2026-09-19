#include "scpefe/scpefe.h"

#include <stdint.h>

#define CHECK(condition) \
    do { \
        if (!(condition)) { \
            return __LINE__; \
        } \
    } while (0)

typedef struct deterministic_host {
    uint64_t monotonic_time_ms;
    unsigned int call_count;
} deterministic_host;

static scpefe_status read_monotonic_time(void *instance_data, uint64_t *time_ms)
{
    deterministic_host *host = (deterministic_host *)instance_data;
    if (host == NULL || time_ms == NULL) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }

    host->call_count += 1;
    *time_ms = host->monotonic_time_ms;
    return SCPEFE_STATUS_OK;
}

static scpefe_host_services_v1 services_for(deterministic_host *host)
{
    scpefe_host_services_v1 services = {
        sizeof(scpefe_host_services_v1),
        SCPEFE_ABI_VERSION,
        host,
        read_monotonic_time,
    };
    return services;
}

static scpefe_status read_health(
    scpefe_context *context,
    scpefe_health_info_v1 *health
)
{
    health->struct_size = sizeof(scpefe_health_info_v1);
    return scpefe_context_health(context, health);
}

int main(void)
{
    deterministic_host first_host = {101, 0};
    deterministic_host second_host = {202, 0};
    const scpefe_host_services_v1 first_services = services_for(&first_host);
    const scpefe_host_services_v1 second_services = services_for(&second_host);
    scpefe_context *first_context = NULL;
    scpefe_context *second_context = NULL;
    scpefe_health_info_v1 first_health = {0};
    scpefe_health_info_v1 second_health = {0};

    CHECK(scpefe_context_create(&first_services, &first_context) == SCPEFE_STATUS_OK);
    CHECK(scpefe_context_create(&second_services, &second_context) == SCPEFE_STATUS_OK);

    CHECK(read_health(second_context, &second_health) == SCPEFE_STATUS_OK);
    CHECK(read_health(first_context, &first_health) == SCPEFE_STATUS_OK);

    CHECK(first_health.abi_version == SCPEFE_ABI_VERSION);
    CHECK(first_health.host_monotonic_time_ms == 101);
    CHECK(second_health.host_monotonic_time_ms == 202);
    CHECK(first_host.call_count == 1);
    CHECK(second_host.call_count == 1);

    scpefe_context_destroy(first_context);
    scpefe_context_destroy(second_context);
    return 0;
}
