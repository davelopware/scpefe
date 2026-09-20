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
    SCPEFE_STATUS_CRYPTO_ERROR = 11,
    SCPEFE_STATUS_WEAK_PASSWORD = 12,
    SCPEFE_STATUS_PASSWORD_ALREADY_IN_USE = 13
} scpefe_status;

#define SCPEFE_REVISION_FORMAT_VERSION 1u
#define SCPEFE_REVISION_ID_SIZE 32u
#define SCPEFE_SLOT_ID_SIZE 16u
#define SCPEFE_CONTENT_HASH_SIZE 32u
#define SCPEFE_DOCUMENT_ID_SIZE 16u
#define SCPEFE_WORK_JOURNAL_KEY_SIZE 32u
#define SCPEFE_LEASE_SESSION_ID_SIZE 16u
#define SCPEFE_DEFAULT_LEASE_DURATION_MS 600000u

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

/* Borrowed policy and identity of the password slot used for this unlock. */
typedef struct scpefe_unlocked_slot_access_v1 {
    uint32_t struct_size;
    const uint8_t *slot_id;
    size_t slot_id_size;
    int can_edit;
    int recovery_slot;
    int can_add_passwords;
    int can_remove_passwords;
    int must_be_changed;
    const char *identity_name;
    size_t identity_name_size;
    const char *identity_email;
    size_t identity_email_size;
} scpefe_unlocked_slot_access_v1;

/* Inputs for adding one constrained temporary-password invitation slot. */
typedef struct scpefe_invitation_create_v1 {
    uint32_t struct_size;
    const uint8_t *container;
    size_t container_size;
    const uint8_t *creator_password;
    size_t creator_password_size;
    const uint8_t *temporary_password;
    size_t temporary_password_size;
    int can_edit;
    int can_add_passwords;
    int can_remove_passwords;
    const char *temporary_label;
    size_t temporary_label_size;
} scpefe_invitation_create_v1;

/* Inputs for replacing and binding an invitation credential on first use. */
typedef struct scpefe_invitation_claim_v1 {
    uint32_t struct_size;
    const uint8_t *container;
    size_t container_size;
    const uint8_t *temporary_password;
    size_t temporary_password_size;
    const uint8_t *new_password;
    size_t new_password_size;
    const char *profile_name;
    size_t profile_name_size;
    const char *profile_email;
    size_t profile_email_size;
} scpefe_invitation_claim_v1;

/* Borrowed authenticated details of the encrypted advisory editing lease. */
typedef struct scpefe_editing_lease_v1 {
    uint32_t struct_size;
    int active;
    const uint8_t *session_id;
    size_t session_id_size;
    uint64_t heartbeat_counter;
    uint64_t holder_utc_ms;
    uint64_t duration_ms;
    const char *holder_name;
    size_t holder_name_size;
    const char *holder_email;
    size_t holder_email_size;
    const char *device_name;
    size_t device_name_size;
} scpefe_editing_lease_v1;

/* Inputs for replacing encrypted lease state without changing document history. */
typedef struct scpefe_editing_lease_update_v1 {
    uint32_t struct_size;
    const uint8_t *container;
    size_t container_size;
    const uint8_t *password;
    size_t password_size;
    scpefe_editing_lease_v1 lease;
} scpefe_editing_lease_update_v1;

/* Validated inputs used to seal and publish a child snapshot revision. */
typedef struct scpefe_manual_save_v1 {
    uint32_t struct_size;
    const uint8_t *container;
    size_t container_size;
    const uint8_t *password;
    size_t password_size;
    const char *profile_name;
    size_t profile_name_size;
    const char *profile_email;
    size_t profile_email_size;
    const char *device_name;
    size_t device_name_size;
    const char *content;
    size_t content_size;
    uint64_t timestamp_ms;
} scpefe_manual_save_v1;

/* Validated inputs used to create or amend one provisional snapshot revision. */
typedef scpefe_manual_save_v1 scpefe_regular_save_v1;

/* Validated inputs used to seal a user-resolved two-parent merge revision. */
typedef struct scpefe_merge_save_v1 {
    uint32_t struct_size;
    const uint8_t *current_container;
    size_t current_container_size;
    const uint8_t *local_container;
    size_t local_container_size;
    const uint8_t *password;
    size_t password_size;
    const char *profile_name;
    size_t profile_name_size;
    const char *profile_email;
    size_t profile_email_size;
    const char *device_name;
    size_t device_name_size;
    const char *content;
    size_t content_size;
    uint64_t timestamp_ms;
} scpefe_merge_save_v1;

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

/* Borrowed view of one authenticated ancestor and its direct parent IDs. */
typedef struct scpefe_revision_graph_node_v1 {
    const uint8_t *revision_id;
    const uint8_t *parent_revision_ids;
    size_t parent_count;
} scpefe_revision_graph_node_v1;

/*
 * parent_revision_ids points to parent_count consecutive 32-byte revision IDs.
 * ancestor_graph points to ancestor_count authenticated historical nodes.
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
    const scpefe_revision_graph_node_v1 *ancestor_graph;
    size_t ancestor_count;
    int manually_sealed;
    const uint8_t *provisional_base_revision;
    size_t provisional_base_revision_size;
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

/* Seals a child revision and returns a replacement self-contained container. */
SCPEFE_API scpefe_status scpefe_manual_save(
    const scpefe_manual_save_v1 *save,
    uint8_t *output,
    size_t output_capacity,
    size_t *output_size
);

/* Creates or amends one provisional revision without asserting a manual save. */
SCPEFE_API scpefe_status scpefe_regular_save(
    const scpefe_regular_save_v1 *save,
    uint8_t *output,
    size_t output_capacity,
    size_t *output_size
);

/* Restores the sealed base retained by a provisional revision. */
SCPEFE_API scpefe_status scpefe_provisional_save_discard(
    const uint8_t *container,
    size_t container_size,
    const uint8_t *password,
    size_t password_size,
    uint8_t *output,
    size_t output_capacity,
    size_t *output_size
);

/* Seals a resolved merge after authenticating related current and local heads. */
SCPEFE_API scpefe_status scpefe_merge_save(
    const scpefe_merge_save_v1 *save,
    uint8_t *output,
    size_t output_capacity,
    size_t *output_size
);

/* Re-wraps the authenticated slot without replacing encrypted document content. */
SCPEFE_API scpefe_status scpefe_password_container_change_password(
    const uint8_t *container,
    size_t container_size,
    const uint8_t *current_password,
    size_t current_password_size,
    const uint8_t *new_password,
    size_t new_password_size,
    uint8_t *output,
    size_t output_capacity,
    size_t *output_size
);

/* Adds an invitation slot while enforcing creator permissions and slot limits. */
SCPEFE_API scpefe_status scpefe_password_container_add_invitation(
    const scpefe_invitation_create_v1 *invitation,
    uint8_t *output, size_t output_capacity, size_t *output_size
);

/* Claims an invitation by replacing its password and encrypted display identity. */
SCPEFE_API scpefe_status scpefe_password_container_claim_invitation(
    const scpefe_invitation_claim_v1 *claim,
    uint8_t *output, size_t output_capacity, size_t *output_size
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

/* Borrows the authenticated slot access until the unlocked owner is destroyed. */
SCPEFE_API scpefe_status scpefe_unlocked_container_slot_access(
    const scpefe_unlocked_container *unlocked,
    scpefe_unlocked_slot_access_v1 *access
);

/* Borrows authenticated lease state until the unlocked owner is destroyed. */
SCPEFE_API scpefe_status scpefe_unlocked_container_editing_lease(
    const scpefe_unlocked_container *unlocked,
    scpefe_editing_lease_v1 *lease
);

/* Replaces encrypted lease state while preserving the current revision. */
SCPEFE_API scpefe_status scpefe_editing_lease_update(
    const scpefe_editing_lease_update_v1 *update,
    uint8_t *output,
    size_t output_capacity,
    size_t *output_size
);

/* Copies the purpose-separated key for this document's app-private work journal. */
SCPEFE_API scpefe_status scpefe_unlocked_container_work_journal_key(
    const scpefe_unlocked_container *unlocked,
    uint8_t *key,
    size_t key_capacity,
    size_t *key_size
);

/* Releases unlocked container values and clears their storage. */
SCPEFE_API void scpefe_unlocked_container_destroy(
    scpefe_unlocked_container *unlocked
);

#ifdef __cplusplus
}
#endif

#endif
