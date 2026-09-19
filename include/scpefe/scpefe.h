#ifndef SCPEFE_SCPEFE_H
#define SCPEFE_SCPEFE_H

#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32)
#    if defined(SCPEFE_BUILDING_LIBRARY)
#        define SCPEFE_API __declspec(dllexport)
#    else
#        define SCPEFE_API __declspec(dllimport)
#    endif
#else
#    define SCPEFE_API __attribute__((visibility("default")))
#endif
#ifdef __cplusplus
extern "C" {
#endif

#define SCPEFE_ABI_VERSION 1u

typedef enum scpefe_status {
    SCPEFE_STATUS_OK = 0,
    SCPEFE_STATUS_INVALID_ARGUMENT = 1,
    SCPEFE_STATUS_UNSUPPORTED_ABI = 2,
    SCPEFE_STATUS_HOST_ERROR = 3,
    SCPEFE_STATUS_OUT_OF_MEMORY = 4
} scpefe_status;

typedef scpefe_status (*scpefe_monotonic_time_ms_fn)(
    void *instance_data,
    uint64_t *time_ms
);

/*
 * Version 1 of the per-context services supplied by an embedding host.
 * The host owns instance_data and must keep it alive until the context is
 * destroyed. libscpefe copies this table when the context is created.
 */
typedef struct scpefe_host_services_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    void *instance_data;
    scpefe_monotonic_time_ms_fn monotonic_time_ms;
} scpefe_host_services_v1;

typedef struct scpefe_health_info_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t library_version_major;
    uint32_t library_version_minor;
    uint32_t library_version_patch;
    uint64_t host_monotonic_time_ms;
} scpefe_health_info_v1;

typedef struct scpefe_context scpefe_context;

SCPEFE_API uint32_t scpefe_abi_version(void);
SCPEFE_API const char *scpefe_library_version(void);

SCPEFE_API scpefe_status scpefe_context_create(
    const scpefe_host_services_v1 *host_services,
    scpefe_context **context
);

SCPEFE_API void scpefe_context_destroy(scpefe_context *context);

SCPEFE_API scpefe_status scpefe_context_health(
    scpefe_context *context,
    scpefe_health_info_v1 *health_info
);

#ifdef __cplusplus
}
#endif

#endif
