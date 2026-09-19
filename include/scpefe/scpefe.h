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

/* Stable result codes returned by the versioned C ABI. */
typedef enum scpefe_status {
    SCPEFE_STATUS_OK = 0,
    SCPEFE_STATUS_INVALID_ARGUMENT = 1,
    SCPEFE_STATUS_UNSUPPORTED_ABI = 2,
    SCPEFE_STATUS_HOST_ERROR = 3,
    SCPEFE_STATUS_OUT_OF_MEMORY = 4,
    SCPEFE_STATUS_BUFFER_TOO_SMALL = 5,
    SCPEFE_STATUS_MALFORMED_CBOR = 6,
    SCPEFE_STATUS_LIMIT_EXCEEDED = 7,
    SCPEFE_STATUS_UNSUPPORTED_FORMAT = 8,
    SCPEFE_STATUS_MALFORMED_CONTAINER = 9,
    SCPEFE_STATUS_AUTHENTICATION_FAILED = 10,
    SCPEFE_STATUS_CRYPTO_ERROR = 11
} scpefe_status;

#define SCPEFE_REVISION_FORMAT_VERSION 1u
#define SCPEFE_REVISION_ID_SIZE 32u
#define SCPEFE_SLOT_ID_SIZE 16u
#define SCPEFE_CONTENT_HASH_SIZE 32u
#define SCPEFE_DOCUMENT_ID_SIZE 16u

/* Reads the host's monotonic clock in milliseconds. */
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

/* Version and host-clock information returned by a context health check. */
typedef struct scpefe_health_info_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t library_version_major;
    uint32_t library_version_minor;
    uint32_t library_version_patch;
    uint64_t host_monotonic_time_ms;
} scpefe_health_info_v1;

/* Opaque handle for one isolated common-core context. */
typedef struct scpefe_context scpefe_context;
/* Opaque owner of one decoded snapshot revision. */
typedef struct scpefe_decoded_snapshot_revision scpefe_decoded_snapshot_revision;
/* Opaque owner of one authenticated, unlocked container. */
typedef struct scpefe_unlocked_container scpefe_unlocked_container;

/* Borrowed view of the semantic values authenticated during container unlock. */
typedef struct scpefe_unlocked_container_v1 {
    uint32_t struct_size;
    const uint8_t *document_id;
    size_t document_id_size;
    const uint8_t *encoded_snapshot_revision;
    size_t encoded_snapshot_revision_size;
} scpefe_unlocked_container_v1;

/* Validated inputs used to publish a new owner-protected document. */
typedef struct scpefe_new_document_v1 {
    uint32_t struct_size;
    const char *profile_name;
    size_t profile_name_size;
    const char *profile_email;
    size_t profile_email_size;
    const char *device_name;
    size_t device_name_size;
    const char *content;
    size_t content_size;
    uint64_t timestamp_ms;
    const uint8_t *owner_password;
    size_t owner_password_size;
    const uint8_t *recovery_password;
    size_t recovery_password_size;
} scpefe_new_document_v1;

/* All byte counts are limits applied before allocating or copying data. */
typedef struct scpefe_revision_limits_v1 {
    uint32_t struct_size;
    size_t max_input_bytes;
    size_t max_nesting_depth;
    size_t max_collection_entries;
    size_t max_text_bytes;
    size_t max_byte_string_bytes;
    size_t max_parent_count;
} scpefe_revision_limits_v1;

/*
 * parent_revision_ids points to parent_count consecutive 32-byte revision IDs.
 * String fields are UTF-8 byte spans and need not be NUL terminated.
 */
typedef struct scpefe_snapshot_revision_v1 {
    uint32_t struct_size;
    uint32_t format_version;
    const uint8_t *parent_revision_ids;
    size_t parent_count;
    uint64_t timestamp_ms;
    const uint8_t *slot_id;
    size_t slot_id_size;
    const char *slot_identity_name;
    size_t slot_identity_name_size;
    const char *slot_identity_email;
    size_t slot_identity_email_size;
    const char *client_profile_name;
    size_t client_profile_name_size;
    const char *client_profile_email;
    size_t client_profile_email_size;
    const char *device_name;
    size_t device_name_size;
    const uint8_t *content_hash;
    size_t content_hash_size;
    const char *content;
    size_t content_size;
} scpefe_snapshot_revision_v1;

/* Returns the supported C ABI version. */
SCPEFE_API uint32_t scpefe_abi_version(void);
/* Returns the library's semantic version string. */
SCPEFE_API const char *scpefe_library_version(void);

/* Creates an isolated context backed by the supplied host services. */
SCPEFE_API scpefe_status scpefe_context_create(
    const scpefe_host_services_v1 *host_services,
    scpefe_context **context
);

/* Releases a context; accepting NULL follows C free-style semantics. */
SCPEFE_API void scpefe_context_destroy(scpefe_context *context);

/* Reads version and deterministic host-clock health information. */
SCPEFE_API scpefe_status scpefe_context_health(
    scpefe_context *context,
    scpefe_health_info_v1 *health_info
);

/* Populates caller storage with the default revision allocation limits. */
SCPEFE_API scpefe_status scpefe_revision_limits_default(
    scpefe_revision_limits_v1 *limits
);

/* Encodes one snapshot revision using deterministic CBOR. */
SCPEFE_API scpefe_status scpefe_snapshot_revision_encode(
    const scpefe_snapshot_revision_v1 *revision,
    const scpefe_revision_limits_v1 *limits,
    uint8_t *output,
    size_t output_capacity,
    size_t *output_size
);

/* Decodes and validates one deterministic-CBOR snapshot revision. */
SCPEFE_API scpefe_status scpefe_snapshot_revision_decode(
    const uint8_t *encoded,
    size_t encoded_size,
    const scpefe_revision_limits_v1 *limits,
    scpefe_decoded_snapshot_revision **revision
);

/* Borrows a C view whose spans remain valid until the decoded owner is destroyed. */
SCPEFE_API scpefe_status scpefe_decoded_snapshot_revision_view(
    const scpefe_decoded_snapshot_revision *revision,
    scpefe_snapshot_revision_v1 *view
);

/* Releases an owned decoded snapshot revision. */
SCPEFE_API void scpefe_decoded_snapshot_revision_destroy(
    scpefe_decoded_snapshot_revision *revision
);

/* Decodes with the same common-core parser and writes UTF-8 JSON plus NUL. */
SCPEFE_API scpefe_status scpefe_snapshot_revision_diagnostic_json(
    const uint8_t *encoded,
    size_t encoded_size,
    const scpefe_revision_limits_v1 *limits,
    int include_content,
    char *output,
    size_t output_capacity,
    size_t *output_size
);

/* Creates a self-contained container with one owner password slot and snapshot. */
SCPEFE_API scpefe_status scpefe_password_container_create(
    const uint8_t *password,
    size_t password_size,
    const uint8_t *encoded_snapshot_revision,
    size_t encoded_snapshot_revision_size,
    uint8_t *output,
    size_t output_capacity,
    size_t *output_size
);

/* Creates a complete initial document; NULL recovery_password omits recovery. */
SCPEFE_API scpefe_status scpefe_new_document_create(
    const scpefe_new_document_v1 *document,
    uint8_t *output,
    size_t output_capacity,
    size_t *output_size
);

/* Authenticates an owner password and unlocks the encrypted snapshot. */
SCPEFE_API scpefe_status scpefe_password_container_unlock(
    const uint8_t *container,
    size_t container_size,
    const uint8_t *password,
    size_t password_size,
    scpefe_unlocked_container **unlocked
);

/* Authenticates and unlocks while enforcing caller-selected allocation limits. */
SCPEFE_API scpefe_status scpefe_password_container_unlock_with_limits(
    const uint8_t *container,
    size_t container_size,
    const uint8_t *password,
    size_t password_size,
    const scpefe_revision_limits_v1 *limits,
    scpefe_unlocked_container **unlocked
);

/* Borrows authenticated container values until the unlocked owner is destroyed. */
SCPEFE_API scpefe_status scpefe_unlocked_container_view(
    const scpefe_unlocked_container *unlocked,
    scpefe_unlocked_container_v1 *view
);

/* Releases unlocked container values and clears their storage. */
SCPEFE_API void scpefe_unlocked_container_destroy(
    scpefe_unlocked_container *unlocked
);

#ifdef __cplusplus
}
#endif

#endif
