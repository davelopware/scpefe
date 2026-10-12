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

#define SCPEFE_ABI_VERSION 2u

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
    SCPEFE_STATUS_PASSWORD_ALREADY_IN_USE = 13,
    SCPEFE_STATUS_INVALID_STATE = 14,
    SCPEFE_STATUS_LOCKED = 15,
    SCPEFE_STATUS_BODY_UNAVAILABLE = 16,
    SCPEFE_STATUS_REVISION_NOT_FOUND = 17,
    SCPEFE_STATUS_STALE_OPERATION = 18,
    SCPEFE_STATUS_PASSWORD_CHANGE_REQUIRED = 19,
    SCPEFE_STATUS_UNRELATED_TARGET = 20,
    SCPEFE_STATUS_TARGET_ROLLBACK = 21,
    SCPEFE_STATUS_MERGE_BASE_UNAVAILABLE = 22,
    SCPEFE_STATUS_TARGET_ACCESS_REVOKED = 23,
    SCPEFE_STATUS_TARGET_PERMISSION_DENIED = 24
} scpefe_status;

/* Stable reasons returned when assessing a newly proposed password. */
typedef enum scpefe_password_policy_assessment {
    SCPEFE_PASSWORD_POLICY_INVALID = 0,
    SCPEFE_PASSWORD_POLICY_ACCEPTED = 1,
    SCPEFE_PASSWORD_POLICY_MINIMUM_LENGTH = 2,
    SCPEFE_PASSWORD_POLICY_PREDICTABLE = 3
} scpefe_password_policy_assessment;

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
/* Context-owned active container token, valid until its context is destroyed. */
typedef struct scpefe_container scpefe_container;
/* Independent copy of authenticated values, valid across Lock and Close. */
typedef struct scpefe_owned_snapshot scpefe_owned_snapshot;
/* Independent copy of authenticated slot metadata. */
typedef struct scpefe_owned_slots scpefe_owned_slots;
/* Opaque owner of one decoded snapshot revision. */
typedef struct scpefe_decoded_snapshot_revision scpefe_decoded_snapshot_revision;
/* Opaque owner of one validated decrypted v3 revision graph. */
typedef struct scpefe_revision_graph scpefe_revision_graph;
/* Opaque owner of a page of immutable revision metadata. */
typedef struct scpefe_revision_page scpefe_revision_page;
/* Opaque owner of a copied revision body or reconstructed text. */
typedef struct scpefe_revision_result scpefe_revision_result;
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

/* Versioned request to create an active container from a new document. */
typedef struct scpefe_container_create_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    scpefe_new_document_v1 document;
} scpefe_container_create_v1;

/* Versioned request to open validated encrypted bytes in locked state. */
typedef struct scpefe_container_open_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    const uint8_t *bytes;
    size_t bytes_size;
} scpefe_container_open_v1;

/* Versioned transient password input for authentication or reauthentication. */
typedef struct scpefe_password_input_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    const uint8_t *bytes;
    size_t bytes_size;
} scpefe_password_input_v1;

/* Copied access and permission state of one active container. */
typedef struct scpefe_container_status_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    int is_locked;
    int can_edit;
    int can_add_passwords;
    int can_remove_passwords;
    int must_change_password;
} scpefe_container_status_v1;

/* View of submitted clear text; encoded_revision is empty for revised-v3
 * history and content may be newer than the confirmed encrypted image. */
typedef struct scpefe_owned_snapshot_view_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    uint8_t document_id[SCPEFE_DOCUMENT_ID_SIZE];
    uint8_t slot_id[SCPEFE_SLOT_ID_SIZE];
    const uint8_t *encoded_revision;
    size_t encoded_revision_size;
    const char *content;
    size_t content_size;
} scpefe_owned_snapshot_view_v1;

/* Save intent for a submitted clear text snapshot or sealed-base discard. */
typedef enum scpefe_save_kind {
    SCPEFE_SAVE_MANUAL = 1,
    SCPEFE_SAVE_REGULAR = 2,
    SCPEFE_SAVE_DISCARD = 3
} scpefe_save_kind;

/* Host actions required by the returned publication transition. */
typedef enum scpefe_publication_effect {
    SCPEFE_EFFECT_REREAD_TARGET = 1u << 0,
    SCPEFE_EFFECT_JOURNAL_CANDIDATE = 1u << 1,
    SCPEFE_EFFECT_PUBLISH_CANDIDATE = 1u << 2,
    SCPEFE_EFFECT_ADOPT_CANDIDATE = 1u << 3,
    SCPEFE_EFFECT_CLEAR_JOURNAL = 1u << 4,
    SCPEFE_EFFECT_RECOVER_CANDIDATE = 1u << 5,
    SCPEFE_EFFECT_PRESERVE_UNSAVED_WORK = 1u << 6,
    SCPEFE_EFFECT_CLEAR_DISPLAY = 1u << 7,
    SCPEFE_EFFECT_STOP_HEARTBEAT = 1u << 8,
    SCPEFE_EFFECT_REAUTHENTICATE_TARGET = 1u << 9,
    SCPEFE_EFFECT_PERFORM_BACKUP = 1u << 10,
    SCPEFE_EFFECT_PERFORM_EXPORT = 1u << 11,
    SCPEFE_EFFECT_RECORD_SUCCESS_OUTCOME = 1u << 12,
    SCPEFE_EFFECT_RECORD_FAILURE_OUTCOME = 1u << 13,
    SCPEFE_EFFECT_JOURNAL_ACTIVITY_OUTCOME = 1u << 14
} scpefe_publication_effect;

/* Authenticated target image observed before any merge or publication. */
typedef struct scpefe_container_target_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    const uint8_t *bytes;
    size_t bytes_size;
    const uint8_t *password;
    size_t password_size;
} scpefe_container_target_v1;

/* One versioned save request; the password is used only while preparing. */
typedef struct scpefe_container_save_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    uint64_t operation_id;
    scpefe_save_kind kind;
    const uint8_t *password;
    size_t password_size;
    const char *profile_name;
    size_t profile_name_size;
    const char *profile_email;
    size_t profile_email_size;
    const char *device_name;
    size_t device_name_size;
    uint64_t timestamp_ms;
} scpefe_container_save_v1;

/* One authenticated divergent-replica merge retained until host publication. */
typedef struct scpefe_container_merge_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    uint64_t operation_id;
    const uint8_t *local_container;
    size_t local_container_size;
    const uint8_t *target_password;
    size_t target_password_size;
    const uint8_t *local_password;
    size_t local_password_size;
    const char *profile_name;
    size_t profile_name_size;
    const char *profile_email;
    size_t profile_email_size;
    const char *device_name;
    size_t device_name_size;
    const char *content;
    size_t content_size;
    uint64_t timestamp_ms;
} scpefe_container_merge_v1;

/* Compaction intent. The host sets backup_verified only after a durable backup
 * read-back and passes its exact bytes; the library accepts the committed source
 * or its authenticated backup-attempt parent after a succeeded outcome.
 * clean_state_confirmed includes the host's work journal. */
typedef struct scpefe_container_compaction_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    uint64_t operation_id;
    const uint8_t *password;
    size_t password_size;
    const uint8_t *lease_session_id;
    size_t lease_session_id_size;
    uint64_t lease_heartbeat_counter;
    int explicit_decision;
    int clean_state_confirmed;
    int backup_verified;
    const uint8_t *verified_backup_bytes;
    size_t verified_backup_size;
    /* Zero retains ten deltas by default; one uses retain_deltas, including N=0. */
    int retention_is_explicit;
    size_t retain_deltas;
    const char *client_name;
    size_t client_name_size;
    const char *client_email;
    size_t client_email_size;
    const char *device_name;
    size_t device_name_size;
    uint64_t timestamp_ms;
} scpefe_container_compaction_v1;

/* Selects which external action follows a published activity attempt. */
typedef enum scpefe_activity_kind {
    SCPEFE_ACTIVITY_BACKUP = 1,
    SCPEFE_ACTIVITY_EXPORT = 2
} scpefe_activity_kind;

/* One activity event intent against an exact source image observed by the host.
 * The host must reread and compare the target again before publishing the
 * candidate, and must journal an outcome that cannot be published. */
typedef struct scpefe_container_activity_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    uint64_t operation_id;
    scpefe_activity_kind kind;
    int clean_state_confirmed;
    const uint8_t *observed_target;
    size_t observed_target_size;
    const uint8_t *password;
    size_t password_size;
    const char *client_name;
    size_t client_name_size;
    const char *client_email;
    size_t client_email_size;
    const char *device_name;
    size_t device_name_size;
    uint64_t timestamp_ms;
} scpefe_container_activity_v1;

/* A published attempt awaiting a host action or an outcome publication. */
typedef struct scpefe_activity_status_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    int has_pending;
    scpefe_activity_kind kind;
    uint64_t attempt_operation_id;
    uint8_t attempt_head[SCPEFE_REVISION_ID_SIZE];
    int host_action_complete;
    int succeeded;
    int outcome_pending;
} scpefe_activity_status_v1;

/* Host-journaled outcome used to resume after reopening the attempt image. */
typedef struct scpefe_activity_recovery_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    scpefe_activity_kind kind;
    uint64_t attempt_operation_id;
    uint8_t attempt_head[SCPEFE_REVISION_ID_SIZE];
    int succeeded;
    const uint8_t *observed_target;
    size_t observed_target_size;
} scpefe_activity_recovery_v1;

/* Copied publication metadata and required host actions. */
typedef struct scpefe_candidate_info_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    uint64_t operation_id;
    uint8_t source_head[SCPEFE_REVISION_ID_SIZE];
    size_t byte_size;
    uint32_t effect_mask;
} scpefe_candidate_info_v1;

/* Lease-only publication intent; expected fields must match the authenticated image. */
typedef enum scpefe_lease_action {
    SCPEFE_LEASE_ACQUIRE = 1,
    SCPEFE_LEASE_REFRESH = 2,
    SCPEFE_LEASE_RELEASE = 3,
    SCPEFE_LEASE_RESUME = 4,
    SCPEFE_LEASE_TAKEOVER = 5
} scpefe_lease_action;

/* Host-observed stale evidence is elapsed monotonic time without an advancing heartbeat. */
typedef struct scpefe_container_lease_change_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    uint64_t operation_id;
    scpefe_lease_action action;
    const uint8_t *password;
    size_t password_size;
    const uint8_t *session_id;
    size_t session_id_size;
    int expected_active;
    const uint8_t *expected_session_id;
    size_t expected_session_id_size;
    uint64_t expected_heartbeat_counter;
    uint64_t expected_holder_utc_ms;
    uint64_t expected_duration_ms;
    uint64_t now_utc_ms;
    uint64_t unchanged_monotonic_ms;
    uint64_t duration_ms;
    const char *holder_name;
    size_t holder_name_size;
    const char *holder_email;
    size_t holder_email_size;
    const char *device_name;
    size_t device_name_size;
    int explicit_takeover;
} scpefe_container_lease_change_v1;

/* Authenticated lease relation to this local container session. */
typedef enum scpefe_lease_status {
    SCPEFE_LEASE_NONE = 0,
    SCPEFE_LEASE_HELD = 1,
    SCPEFE_LEASE_OTHER_HOLDER = 2,
    SCPEFE_LEASE_UNCERTAIN = 3
} scpefe_lease_status;

/* Copied current mode; lease metadata is available in authenticated-state snapshots. */
typedef struct scpefe_container_lease_mode_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    int is_editing;
    scpefe_lease_status lease_status;
} scpefe_container_lease_mode_v1;

/* Authenticated core decision for entering Edit mode with host clock evidence. */
typedef enum scpefe_lease_entry {
    SCPEFE_LEASE_ENTRY_ACQUIRE = 1,
    SCPEFE_LEASE_ENTRY_RESUME = 2,
    SCPEFE_LEASE_ENTRY_TAKEOVER = 3,
    SCPEFE_LEASE_ENTRY_CONFIRM_TAKEOVER = 4,
    SCPEFE_LEASE_ENTRY_BLOCKED = 5,
    SCPEFE_LEASE_ENTRY_CHANGED = 6
} scpefe_lease_entry;

/* Input and result for a lease decision; zero session means no suspended lease. */
typedef struct scpefe_container_lease_advice_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    uint8_t suspended_session_id[SCPEFE_LEASE_SESSION_ID_SIZE];
    uint64_t suspended_heartbeat_counter;
    uint64_t now_utc_ms;
    uint64_t unchanged_monotonic_ms;
    scpefe_lease_entry entry;
} scpefe_container_lease_advice_v1;

/* Credential or authenticated slot metadata operation for one candidate. */
typedef enum scpefe_slot_change_kind {
    SCPEFE_SLOT_CHANGE_PASSWORD = 1,
    SCPEFE_SLOT_ADD_INVITATION = 2,
    SCPEFE_SLOT_CLAIM_INVITATION = 3,
    SCPEFE_SLOT_RECONCILE_IDENTITY = 4,
    SCPEFE_SLOT_UPDATE_PERMISSIONS = 5,
    SCPEFE_SLOT_REMOVE = 6
} scpefe_slot_change_kind;

/* Versioned transient input; name is the temporary label for invitations. */
typedef struct scpefe_container_slot_change_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    uint64_t operation_id;
    scpefe_slot_change_kind kind;
    const uint8_t *actor_password;
    size_t actor_password_size;
    const uint8_t *new_password;
    size_t new_password_size;
    const uint8_t *target_slot_id;
    size_t target_slot_id_size;
    int can_edit, can_add_passwords, can_remove_passwords;
    const char *name;
    size_t name_size;
    const char *email;
    size_t email_size;
    const char *client_name;
    size_t client_name_size;
    const char *client_email;
    size_t client_email_size;
    const char *device;
    size_t device_size;
    uint64_t timestamp_ms;
} scpefe_container_slot_change_v1;

/* Borrowed fields from one independent owned slot collection. */
typedef struct scpefe_owned_slot_view_v1 {
    uint32_t struct_size;
    uint8_t slot_id[SCPEFE_SLOT_ID_SIZE];
    uint8_t management_id[SCPEFE_SLOT_ID_SIZE];
    int can_edit, can_add_passwords, can_remove_passwords;
    int must_change_password;
    int role;
    const char *name;
    size_t name_size;
    const char *email;
    size_t email_size;
} scpefe_owned_slot_view_v1;

/* Owned copy of authenticated host state, including the work-journal key. */
typedef struct scpefe_owned_authenticated_state scpefe_owned_authenticated_state;

/* Borrowed view valid only while its authenticated-state owner remains alive. */
typedef struct scpefe_owned_authenticated_state_view_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    uint8_t document_id[SCPEFE_DOCUMENT_ID_SIZE];
    uint8_t slot_id[SCPEFE_SLOT_ID_SIZE];
    uint8_t work_journal_key[SCPEFE_WORK_JOURNAL_KEY_SIZE];
    uint8_t revision_head[SCPEFE_REVISION_ID_SIZE];
    uint64_t revision_timestamp_ms;
    int manually_sealed;
    int owner_slot, recovery_slot, must_change_password;
    const char *client_name;
    size_t client_name_size;
    const char *client_email;
    size_t client_email_size;
    const char *device_name;
    size_t device_name_size;
    const char *event_type;
    size_t event_type_size;
    const char *event_detail;
    size_t event_detail_size;
    const char *identity_name;
    size_t identity_name_size;
    const char *identity_email;
    size_t identity_email_size;
    int lease_active;
    uint8_t lease_session_id[SCPEFE_SLOT_ID_SIZE];
    uint64_t lease_heartbeat_counter, lease_holder_utc_ms, lease_duration_ms;
    const char *lease_holder_name;
    size_t lease_holder_name_size;
    const char *lease_holder_email;
    size_t lease_holder_email_size;
    const char *lease_device_name;
    size_t lease_device_name_size;
} scpefe_owned_authenticated_state_view_v1;

/* Reports a verified, definite-failure, or ambiguous host result. */
typedef enum scpefe_publication_outcome {
    SCPEFE_PUBLICATION_VERIFIED = 1,
    SCPEFE_PUBLICATION_DEFINITE_FAILURE = 2,
    SCPEFE_PUBLICATION_AMBIGUOUS = 3
} scpefe_publication_outcome;

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

/* Borrowed metadata spans remain valid until their owning page is destroyed. */
typedef struct scpefe_revision_metadata_v1 {
    uint32_t struct_size;
    uint8_t id[SCPEFE_REVISION_ID_SIZE];
    uint8_t previous_head[SCPEFE_REVISION_ID_SIZE];
    uint8_t content_parent[SCPEFE_REVISION_ID_SIZE];
    uint8_t resolved_by[SCPEFE_REVISION_ID_SIZE];
    const uint8_t *merge_source_ids;
    size_t merge_source_count;
    uint64_t timestamp_ms;
    uint8_t actor_slot_id[SCPEFE_SLOT_ID_SIZE];
    const char *actor_name;
    size_t actor_name_size;
    const char *actor_email;
    size_t actor_email_size;
    const char *client_name;
    size_t client_name_size;
    const char *client_email;
    size_t client_email_size;
    const char *device;
    size_t device_size;
    const char *event_type;
    size_t event_type_size;
    const uint8_t *immutable_cbor;
    size_t immutable_cbor_size;
    const uint8_t *event_details_cbor;
    size_t event_details_cbor_size;
    uint8_t content_hash[SCPEFE_CONTENT_HASH_SIZE];
    uint8_t original_body_digest[SCPEFE_CONTENT_HASH_SIZE];
    uint8_t original_kind;
    uint8_t storage_kind;
    int has_previous_head;
    int has_content_parent;
    int has_original_body_digest;
    int has_resolved_by;
    int foreign;
    int provisional;
    int body_available;
    int text_available;
} scpefe_revision_metadata_v1;

/* Borrowed bytes remain valid until their owning result is destroyed. */
typedef struct scpefe_revision_result_view_v1 {
    uint32_t struct_size;
    const uint8_t *body_cbor;
    size_t body_cbor_size;
    const char *text;
    size_t text_size;
} scpefe_revision_result_view_v1;

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
    const char *event_type;
    size_t event_type_size;
    const char *event_detail;
    size_t event_detail_size;
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
/* Assesses a proposed password through this context's injected policy service. */
SCPEFE_API scpefe_status scpefe_context_assess_password(
    scpefe_context *context, const uint8_t *password, size_t password_size,
    scpefe_password_policy_assessment *assessment);

/* Creates the sole active context-owned container and returns it unlocked. */
SCPEFE_API scpefe_status scpefe_container_create(
    scpefe_context *context, const scpefe_container_create_v1 *request,
    scpefe_container **container);
/* Opens the sole active container in screen-locked state. */
SCPEFE_API scpefe_status scpefe_container_open(
    scpefe_context *context, const scpefe_container_open_v1 *request,
    scpefe_container **container);
/* Authenticates a password before restoring clear access. */
SCPEFE_API scpefe_status scpefe_container_unlock(
    scpefe_container *container, const scpefe_password_input_v1 *password);
/* Hides future clear reads while retaining the same container handle. */
SCPEFE_API scpefe_status scpefe_container_lock(scpefe_container *container);
/* Closes and invalidates the handle; another container may then be opened. */
SCPEFE_API scpefe_status scpefe_container_close(scpefe_container *container);
/* Copies current lock and authenticated permission state. */
SCPEFE_API scpefe_status scpefe_container_status(
    const scpefe_container *container, scpefe_container_status_v1 *status);
/* Copies submitted clear content into an owner independent of future state. */
SCPEFE_API scpefe_status scpefe_container_read(
    const scpefe_container *container, scpefe_owned_snapshot **snapshot);
/* Copies authenticated revised-v3 history into an independent owned graph. */
SCPEFE_API scpefe_status scpefe_container_revision_graph(
    const scpefe_container *container, scpefe_revision_graph **graph);
/* Borrows immutable spans from the owned snapshot until its destruction. */
SCPEFE_API scpefe_status scpefe_owned_snapshot_view(
    const scpefe_owned_snapshot *snapshot, scpefe_owned_snapshot_view_v1 *view);
/* Releases one independently owned snapshot. */
SCPEFE_API void scpefe_owned_snapshot_destroy(scpefe_owned_snapshot *snapshot);
/* Copies the current encrypted image into caller storage. */
SCPEFE_API scpefe_status scpefe_container_copy_bytes(
    const scpefe_container *container, uint8_t *output,
    size_t output_capacity, size_t *output_size);
/* Applies authenticated target rights immediately and reports host journal work. */
SCPEFE_API scpefe_status scpefe_container_apply_target(
    scpefe_container *container, const scpefe_container_target_v1 *target,
    uint32_t *effect_mask);
/* Confirms that the host has established this handle's editing lease. */
SCPEFE_API scpefe_status scpefe_container_confirm_edit_lease(scpefe_container *container);
/* Reads edit mode while unlocked; authenticated-state snapshots provide lease details. */
SCPEFE_API scpefe_status scpefe_container_lease_mode(
    const scpefe_container *container, scpefe_container_lease_mode_v1 *mode);
/* Classifies lease entry using authenticated state and observed elapsed time. */
SCPEFE_API scpefe_status scpefe_container_lease_advice(
    const scpefe_container *container, scpefe_container_lease_advice_v1 *advice);
/* Prepares authenticated lease bytes without appending a content revision.
 * The host must reread and compare exact source bytes from copy_bytes before
 * publishing: source_head alone cannot detect another lease heartbeat. */
SCPEFE_API scpefe_status scpefe_container_prepare_lease_change(
    scpefe_container *container, const scpefe_container_lease_change_v1 *change,
    scpefe_candidate_info_v1 *candidate);
/* Replaces submitted clear content without changing confirmed encrypted bytes. */
SCPEFE_API scpefe_status scpefe_container_submit_content(scpefe_container *container,
    const char *content, size_t content_size);
/* Prepares and retains one exact candidate for host publication. */
SCPEFE_API scpefe_status scpefe_container_prepare_save(scpefe_container *container,
    const scpefe_container_save_v1 *save, scpefe_candidate_info_v1 *candidate);
/* Prepares a resolved merge against this handle's confirmed target image. */
SCPEFE_API scpefe_status scpefe_container_prepare_merge(scpefe_container *container,
    const scpefe_container_merge_v1 *merge, scpefe_candidate_info_v1 *candidate);
/* Classifies a merge against the authenticated target without retaining bytes. */
SCPEFE_API scpefe_status scpefe_container_assess_merge(scpefe_container *container,
    const scpefe_container_merge_v1 *merge);
/* Prepares attributed compaction after the host verifies an exact source or
 * authenticated backup-attempt replica preceding a succeeded outcome. */
SCPEFE_API scpefe_status scpefe_container_prepare_compaction(
    scpefe_container *container,
    const scpefe_container_compaction_v1 *compaction,
    scpefe_candidate_info_v1 *candidate);
/* Prepares an event-only attempt; external work starts only after verified acknowledgement. */
SCPEFE_API scpefe_status scpefe_container_prepare_activity_attempt(
    scpefe_container *container, const scpefe_container_activity_v1 *activity,
    scpefe_candidate_info_v1 *candidate);
/* Records the host action and requests an app-private pending-outcome journal. */
SCPEFE_API scpefe_status scpefe_container_complete_activity(
    scpefe_container *container, uint64_t attempt_operation_id,
    int succeeded, uint32_t *effect_mask);
/* Restores a journaled result only if the current source head is its attempt. */
SCPEFE_API scpefe_status scpefe_container_restore_activity_outcome(
    scpefe_container *container, const scpefe_activity_recovery_v1 *recovery);
/* Prepares the success or failure event for the published attempt. */
SCPEFE_API scpefe_status scpefe_container_prepare_activity_outcome(
    scpefe_container *container, const scpefe_container_activity_v1 *activity,
    scpefe_candidate_info_v1 *candidate);
/* Copies the pending action or outcome so the host can journal or display it. */
SCPEFE_API scpefe_status scpefe_container_activity_status(
    const scpefe_container *container, scpefe_activity_status_v1 *status);
/* Prepares one authenticated slot operation as an event-only candidate. */
SCPEFE_API scpefe_status scpefe_container_prepare_slot_change(
    scpefe_container *container, const scpefe_container_slot_change_v1 *change,
    scpefe_candidate_info_v1 *candidate);
/* Copies permitted slot metadata into an independent owned collection. */
SCPEFE_API scpefe_status scpefe_container_slots(
    const scpefe_container *container, scpefe_owned_slots **slots);
/* Reports the count of slots in one owned collection. */
SCPEFE_API scpefe_status scpefe_owned_slots_count(
    const scpefe_owned_slots *slots, size_t *count);
/* Borrows one slot's fields until the collection is destroyed. */
SCPEFE_API scpefe_status scpefe_owned_slots_view(
    const scpefe_owned_slots *slots, size_t index, scpefe_owned_slot_view_v1 *view);
/* Releases independently copied slot metadata. */
SCPEFE_API void scpefe_owned_slots_destroy(scpefe_owned_slots *slots);
/* Copies authenticated slot, lease, and journal-key state into an owned result. */
SCPEFE_API scpefe_status scpefe_container_authenticated_state(
    const scpefe_container *container, scpefe_owned_authenticated_state **state);
/* Borrows one authenticated-state snapshot until its owner is destroyed. */
SCPEFE_API scpefe_status scpefe_owned_authenticated_state_view(
    const scpefe_owned_authenticated_state *state,
    scpefe_owned_authenticated_state_view_v1 *view);
/* Clears the journal key and releases one authenticated-state snapshot. */
SCPEFE_API void scpefe_owned_authenticated_state_destroy(
    scpefe_owned_authenticated_state *state);
/* Copies the retained candidate bytes without preparing or encrypting again. */
SCPEFE_API scpefe_status scpefe_container_copy_candidate(const scpefe_container *container,
    uint64_t operation_id, uint8_t *output, size_t capacity, size_t *output_size);
/* Applies one host result for a save, slot, or lease candidate. */
SCPEFE_API scpefe_status scpefe_container_acknowledge_save(scpefe_container *container,
    uint64_t operation_id, scpefe_publication_outcome outcome, uint32_t *effect_mask);
/* Resolves an ambiguous candidate after the host has checked the exact bytes. */
SCPEFE_API scpefe_status scpefe_container_resolve_save(scpefe_container *container,
    uint64_t operation_id, int published, uint32_t *effect_mask);

/* Populates caller storage with the default revision allocation limits. */
SCPEFE_API scpefe_status scpefe_revision_limits_default(
    scpefe_revision_limits_v1 *limits
);

/* Validates a decrypted and already authenticated v3 payload into an owned graph. */
SCPEFE_API scpefe_status scpefe_revision_graph_decode(
    const uint8_t *payload, size_t payload_size,
    const scpefe_revision_limits_v1 *limits, scpefe_revision_graph **graph);
/* Copies deterministic payload bytes from a validated graph. */
SCPEFE_API scpefe_status scpefe_revision_graph_encode(
    const scpefe_revision_graph *graph, uint8_t *output,
    size_t output_capacity, size_t *output_size);
/* Releases an owned revision graph. */
SCPEFE_API void scpefe_revision_graph_destroy(scpefe_revision_graph *graph);
/* Copies the canonical head IDs, each into a 32-byte caller buffer. */
SCPEFE_API scpefe_status scpefe_revision_graph_heads(
    const scpefe_revision_graph *graph, uint8_t *head, uint8_t *content_head);
/* Creates an independent newest-first page; offset and count are record counts. */
SCPEFE_API scpefe_status scpefe_revision_graph_list(
    const scpefe_revision_graph *graph, size_t offset, size_t count,
    scpefe_revision_page **page);
/* Reports the number of records in an owned page. */
SCPEFE_API scpefe_status scpefe_revision_page_count(
    const scpefe_revision_page *page, size_t *count);
/* Borrows copied metadata from one owned page entry. */
SCPEFE_API scpefe_status scpefe_revision_page_metadata(
    const scpefe_revision_page *page, size_t index,
    scpefe_revision_metadata_v1 *metadata);
/* Releases an owned metadata page. */
SCPEFE_API void scpefe_revision_page_destroy(scpefe_revision_page *page);
/* Copies an available original body; pruned, foreign, and event bodies are unavailable. */
SCPEFE_API scpefe_status scpefe_revision_graph_body(
    const scpefe_revision_graph *graph, const uint8_t *revision_id,
    scpefe_revision_result **result);
/* Reconstructs available canonical text, including text at an event head. */
SCPEFE_API scpefe_status scpefe_revision_graph_reconstruct(
    const scpefe_revision_graph *graph, const uint8_t *revision_id,
    scpefe_revision_result **result);
/* Computes a bounded readable comparison of two available canonical texts. */
SCPEFE_API scpefe_status scpefe_revision_graph_compare(
    const scpefe_revision_graph *graph, const uint8_t *before_id,
    const uint8_t *after_id, scpefe_revision_result **result);
/* Borrows bytes from an independently owned result. */
SCPEFE_API scpefe_status scpefe_revision_result_view(
    const scpefe_revision_result *result, scpefe_revision_result_view_v1 *view);
/* Releases a copied body, reconstructed text, or comparison. */
SCPEFE_API void scpefe_revision_result_destroy(scpefe_revision_result *result);
/* Writes redacted JSON by default; content requires a nonzero flag. JSON is
 * limited to 32 MiB (excluding NUL); oversized output, including size probes,
 * returns LIMIT_EXCEEDED with output_size set to zero. */
SCPEFE_API scpefe_status scpefe_revision_graph_diagnostic_json(
    const scpefe_revision_graph *graph, int include_content,
    char *output, size_t output_capacity, size_t *output_size);

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

/* Reports whether candidate bytes satisfy the policy for newly chosen passwords. */
SCPEFE_API int scpefe_password_meets_policy(
    const uint8_t *password,
    size_t password_size
);

/* Classifies candidate bytes under the policy for newly chosen passwords. */
SCPEFE_API scpefe_password_policy_assessment scpefe_assess_password_policy(
    const uint8_t *password,
    size_t password_size
);


#ifdef __cplusplus
}
#endif

#endif
