#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(x) do { if (!(x)) { \
    fprintf(stderr, "activity ABI failed at %d: %s\n", __LINE__, #x); \
    return 1; \
} } while (0)

static scpefe_status read_clock(void *opaque, uint64_t *value)
{
    *value = *(uint64_t *)opaque;
    return SCPEFE_STATUS_OK;
}

static int copy_bytes(scpefe_container *container, uint8_t **bytes, size_t *size)
{
    CHECK(scpefe_container_copy_bytes(container, NULL, 0, size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    *bytes = (uint8_t *)malloc(*size);
    CHECK(*bytes != NULL);
    CHECK(scpefe_container_copy_bytes(container, *bytes, *size, size)
        == SCPEFE_STATUS_OK);
    return 0;
}

static int publish(scpefe_container *container, uint64_t operation_id,
    uint32_t required_effect)
{
    uint32_t effects = 0;
    CHECK(scpefe_container_acknowledge_save(container, operation_id,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_OK);
    CHECK((effects & SCPEFE_EFFECT_ADOPT_CANDIDATE) != 0);
    CHECK((effects & required_effect) == required_effect);
    return 0;
}

static void slot_request(scpefe_container_slot_change_v1 *request,
    uint64_t operation_id, scpefe_slot_change_kind kind,
    const uint8_t *password, size_t password_size)
{
    memset(request, 0, sizeof(*request));
    request->struct_size = sizeof(*request);
    request->abi_version = SCPEFE_ABI_VERSION;
    request->operation_id = operation_id;
    request->kind = kind;
    request->actor_password = password;
    request->actor_password_size = password_size;
    request->client_name = "Ada";
    request->client_name_size = 3;
    request->client_email = "ada@example.org";
    request->client_email_size = 15;
    request->device = "Desk";
    request->device_size = 4;
    request->timestamp_ms = operation_id + 100;
}

static void activity_request(scpefe_container_activity_v1 *request,
    uint64_t operation_id, scpefe_activity_kind kind,
    const uint8_t *password, size_t password_size,
    const uint8_t *target, size_t target_size)
{
    memset(request, 0, sizeof(*request));
    request->struct_size = sizeof(*request);
    request->abi_version = SCPEFE_ABI_VERSION;
    request->operation_id = operation_id;
    request->kind = kind;
    request->clean_state_confirmed = 1;
    request->observed_target = target;
    request->observed_target_size = target_size;
    request->password = password;
    request->password_size = password_size;
    request->client_name = "Guest";
    request->client_name_size = 5;
    request->client_email = "guest@example.org";
    request->client_email_size = 17;
    request->device_name = "Desk";
    request->device_name_size = 4;
    request->timestamp_ms = operation_id + 100;
}

static int expect_head_event(scpefe_container *container,
    const char *type, const uint8_t *content_head)
{
    scpefe_revision_graph *graph = NULL;
    scpefe_revision_page *page = NULL;
    scpefe_revision_metadata_v1 metadata = {0};
    uint8_t head[32], current_content_head[32];
    size_t count = 0;
    metadata.struct_size = sizeof(metadata);
    CHECK(scpefe_container_revision_graph(container, &graph) == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_graph_heads(graph, head, current_content_head)
        == SCPEFE_STATUS_OK);
    CHECK(memcmp(current_content_head, content_head, 32) == 0);
    CHECK(scpefe_revision_graph_list(graph, 0, 1, &page) == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_page_count(page, &count) == SCPEFE_STATUS_OK
        && count == 1);
    CHECK(scpefe_revision_page_metadata(page, 0, &metadata) == SCPEFE_STATUS_OK);
    CHECK(metadata.original_kind == 2 && metadata.event_type_size == strlen(type)
        && memcmp(metadata.event_type, type, metadata.event_type_size) == 0);
    scpefe_revision_page_destroy(page);
    scpefe_revision_graph_destroy(graph);
    return 0;
}

int main(void)
{
    const uint8_t owner[] = "0b4e79c5-7cfe-4b7c-b4f3-d89129cb7b5e";
    const uint8_t temporary[] = "7f12c2e1-f92d-49c7-9e89-e9076b8d5be8";
    const uint8_t guest[] = "288850e7-186a-4a80-8c9c-629318577055";
    uint64_t clock = 42;
    scpefe_host_services_v1 host = {sizeof(host), SCPEFE_ABI_VERSION,
        &clock, read_clock};
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    scpefe_container_create_v1 create = {0};
    scpefe_container_slot_change_v1 slot;
    scpefe_container_activity_v1 activity;
    scpefe_activity_recovery_v1 recovery = {0};
    scpefe_activity_status_v1 status = {sizeof(status), SCPEFE_ABI_VERSION};
    scpefe_candidate_info_v1 info = {sizeof(info), SCPEFE_ABI_VERSION};
    scpefe_container_status_v1 access = {sizeof(access), SCPEFE_ABI_VERSION};
    scpefe_revision_graph *graph = NULL;
    uint8_t content_head[32], head[32];
    uint8_t *target = NULL, *backup = NULL, *older_target = NULL;
    size_t target_size = 0, backup_size = 0, older_size = 0;
    uint32_t effects = 0;

    create.struct_size = sizeof(create);
    create.abi_version = SCPEFE_ABI_VERSION;
    create.document.struct_size = sizeof(create.document);
    create.document.profile_name = "Ada";
    create.document.profile_name_size = 3;
    create.document.profile_email = "ada@example.org";
    create.document.profile_email_size = 15;
    create.document.device_name = "Desk";
    create.document.device_name_size = 4;
    create.document.content = "baseline\n";
    create.document.content_size = 9;
    create.document.timestamp_ms = 1;
    create.document.owner_password = owner;
    create.document.owner_password_size = sizeof(owner) - 1;
    CHECK(scpefe_context_create(&host, &context) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_create(context, &create, &container) == SCPEFE_STATUS_OK);
    slot_request(&slot, 1, SCPEFE_SLOT_ADD_INVITATION,
        owner, sizeof(owner) - 1);
    slot.new_password = temporary;
    slot.new_password_size = sizeof(temporary) - 1;
    slot.name = "Guest";
    slot.name_size = 5;
    CHECK(scpefe_container_prepare_slot_change(container, &slot, &info)
        == SCPEFE_STATUS_OK);
    CHECK(publish(container, 1, 0) == 0);
    CHECK(copy_bytes(container, &older_target, &older_size) == 0);
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    scpefe_password_input_v1 auth = {sizeof(auth), SCPEFE_ABI_VERSION,
        temporary, sizeof(temporary) - 1};
    CHECK(scpefe_container_unlock(container, &auth) == SCPEFE_STATUS_OK);
    CHECK(copy_bytes(container, &target, &target_size) == 0);
    activity_request(&activity, 2, SCPEFE_ACTIVITY_BACKUP,
        temporary, sizeof(temporary) - 1, target, target_size);
    CHECK(scpefe_container_prepare_activity_attempt(container, &activity, &info)
        == SCPEFE_STATUS_INVALID_STATE);
    free(target);
    target = NULL;
    slot_request(&slot, 2, SCPEFE_SLOT_CLAIM_INVITATION,
        temporary, sizeof(temporary) - 1);
    slot.new_password = guest;
    slot.new_password_size = sizeof(guest) - 1;
    slot.name = "Guest";
    slot.name_size = 5;
    slot.email = "guest@example.org";
    slot.email_size = 17;
    CHECK(scpefe_container_prepare_slot_change(container, &slot, &info)
        == SCPEFE_STATUS_OK);
    CHECK(publish(container, 2, 0) == 0);
    CHECK(scpefe_container_status(container, &access) == SCPEFE_STATUS_OK);
    CHECK(!access.can_edit && !access.can_add_passwords
        && !access.can_remove_passwords);
    CHECK(scpefe_container_confirm_edit_lease(container)
        == SCPEFE_STATUS_INVALID_STATE);
    CHECK(scpefe_container_submit_content(container, "edited", 6)
        == SCPEFE_STATUS_INVALID_STATE);
    slot_request(&slot, 3, SCPEFE_SLOT_ADD_INVITATION,
        guest, sizeof(guest) - 1);
    slot.new_password = temporary;
    slot.new_password_size = sizeof(temporary) - 1;
    slot.name = "Other";
    slot.name_size = 5;
    CHECK(scpefe_container_prepare_slot_change(container, &slot, &info)
        == SCPEFE_STATUS_INVALID_ARGUMENT);

    CHECK(scpefe_container_revision_graph(container, &graph) == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_graph_heads(graph, head, content_head) == SCPEFE_STATUS_OK);
    scpefe_revision_graph_destroy(graph);
    graph = NULL;
    CHECK(copy_bytes(container, &target, &target_size) == 0);
    activity_request(&activity, 3, SCPEFE_ACTIVITY_BACKUP,
        guest, sizeof(guest) - 1, target, target_size);
    activity.clean_state_confirmed = 0;
    CHECK(scpefe_container_prepare_activity_attempt(container, &activity, &info)
        == SCPEFE_STATUS_INVALID_STATE);
    activity.clean_state_confirmed = 1;
    activity.observed_target = older_target;
    activity.observed_target_size = older_size;
    CHECK(scpefe_container_prepare_activity_attempt(container, &activity, &info)
        == SCPEFE_STATUS_INVALID_STATE);
    activity.observed_target = target;
    activity.observed_target_size = target_size;
    CHECK(scpefe_container_prepare_activity_attempt(container, &activity, &info)
        == SCPEFE_STATUS_OK);
    CHECK(info.effect_mask == (SCPEFE_EFFECT_REREAD_TARGET
        | SCPEFE_EFFECT_JOURNAL_CANDIDATE | SCPEFE_EFFECT_PUBLISH_CANDIDATE));
    CHECK(scpefe_container_activity_status(container, &status) == SCPEFE_STATUS_OK
        && !status.has_pending);
    CHECK(scpefe_container_acknowledge_save(container, 3,
        SCPEFE_PUBLICATION_DEFINITE_FAILURE, &effects) == SCPEFE_STATUS_OK);
    CHECK((effects & SCPEFE_EFFECT_PERFORM_BACKUP) == 0);
    activity.operation_id = 4;
    CHECK(scpefe_container_prepare_activity_attempt(container, &activity, &info)
        == SCPEFE_STATUS_OK);
    CHECK(publish(container, 4, SCPEFE_EFFECT_PERFORM_BACKUP) == 0);
    CHECK(scpefe_container_activity_status(container, &status) == SCPEFE_STATUS_OK);
    CHECK(status.has_pending && status.kind == SCPEFE_ACTIVITY_BACKUP
        && status.attempt_operation_id == 4 && !status.host_action_complete);
    CHECK(expect_head_event(container, "backup-attempted", content_head) == 0);
    CHECK(copy_bytes(container, &backup, &backup_size) == 0);
    CHECK(scpefe_container_complete_activity(container, 3, 1, &effects)
        == SCPEFE_STATUS_STALE_OPERATION);
    CHECK(scpefe_container_complete_activity(container, 4, 1, &effects)
        == SCPEFE_STATUS_OK);
    CHECK((effects & SCPEFE_EFFECT_RECORD_SUCCESS_OUTCOME) != 0
        && (effects & SCPEFE_EFFECT_JOURNAL_ACTIVITY_OUTCOME) != 0);
    CHECK(scpefe_container_activity_status(container, &status) == SCPEFE_STATUS_OK
        && status.host_action_complete && status.succeeded && status.outcome_pending);
    activity_request(&activity, 5, SCPEFE_ACTIVITY_BACKUP,
        guest, sizeof(guest) - 1, target, target_size);
    CHECK(scpefe_container_prepare_activity_outcome(container, &activity, &info)
        == SCPEFE_STATUS_INVALID_STATE);
    free(target);
    target = NULL;
    CHECK(copy_bytes(container, &target, &target_size) == 0);
    activity.observed_target = target;
    activity.observed_target_size = target_size;
    CHECK(scpefe_container_prepare_activity_outcome(container, &activity, &info)
        == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_acknowledge_save(container, 5,
        SCPEFE_PUBLICATION_DEFINITE_FAILURE, &effects) == SCPEFE_STATUS_OK);
    CHECK((effects & SCPEFE_EFFECT_JOURNAL_ACTIVITY_OUTCOME) != 0);
    CHECK(scpefe_container_activity_status(container, &status) == SCPEFE_STATUS_OK
        && status.outcome_pending);
    activity.operation_id = 6;
    CHECK(scpefe_container_prepare_activity_outcome(container, &activity, &info)
        == SCPEFE_STATUS_OK);
    CHECK(publish(container, 6, 0) == 0);
    CHECK(scpefe_container_activity_status(container, &status) == SCPEFE_STATUS_OK
        && !status.has_pending);
    CHECK(expect_head_event(container, "backup-succeeded", content_head) == 0);
    free(target);
    target = NULL;
    CHECK(copy_bytes(container, &target, &target_size) == 0);
    CHECK(backup_size != target_size || memcmp(backup, target, target_size) != 0);

    activity_request(&activity, 7, SCPEFE_ACTIVITY_EXPORT,
        guest, sizeof(guest) - 1, target, target_size);
    CHECK(scpefe_container_prepare_activity_attempt(container, &activity, &info)
        == SCPEFE_STATUS_OK);
    CHECK(publish(container, 7, SCPEFE_EFFECT_PERFORM_EXPORT) == 0);
    CHECK(expect_head_event(container, "export-attempted", content_head) == 0);
    CHECK(scpefe_container_complete_activity(container, 7, 0, &effects)
        == SCPEFE_STATUS_OK);
    CHECK((effects & SCPEFE_EFFECT_RECORD_FAILURE_OUTCOME) != 0);
    CHECK((effects & SCPEFE_EFFECT_JOURNAL_ACTIVITY_OUTCOME) != 0);
    CHECK(scpefe_container_activity_status(container, &status) == SCPEFE_STATUS_OK
        && status.has_pending && status.attempt_operation_id == 7
        && status.host_action_complete && !status.succeeded
        && status.outcome_pending);
    free(target);
    target = NULL;
    CHECK(copy_bytes(container, &target, &target_size) == 0);
    recovery.struct_size = sizeof(recovery);
    recovery.abi_version = SCPEFE_ABI_VERSION;
    recovery.kind = SCPEFE_ACTIVITY_EXPORT;
    recovery.attempt_operation_id = status.attempt_operation_id;
    memcpy(recovery.attempt_head, status.attempt_head, sizeof(recovery.attempt_head));
    recovery.succeeded = status.succeeded;
    recovery.observed_target = target;
    recovery.observed_target_size = target_size;
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_container_open_v1 open = {sizeof(open), SCPEFE_ABI_VERSION,
        target, target_size};
    CHECK(scpefe_container_open(context, &open, &container) == SCPEFE_STATUS_OK);
    auth.bytes = guest;
    auth.bytes_size = sizeof(guest) - 1;
    CHECK(scpefe_container_unlock(container, &auth) == SCPEFE_STATUS_OK);
    recovery.attempt_head[0] ^= 1;
    CHECK(scpefe_container_restore_activity_outcome(container, &recovery)
        == SCPEFE_STATUS_INVALID_STATE);
    recovery.attempt_head[0] ^= 1;
    CHECK(scpefe_container_restore_activity_outcome(container, &recovery)
        == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_activity_status(container, &status) == SCPEFE_STATUS_OK
        && status.has_pending && status.outcome_pending && !status.succeeded);
    activity_request(&activity, 8, SCPEFE_ACTIVITY_EXPORT,
        guest, sizeof(guest) - 1, target, target_size);
    CHECK(scpefe_container_prepare_activity_outcome(container, &activity, &info)
        == SCPEFE_STATUS_OK);
    CHECK(publish(container, 8, 0) == 0);
    CHECK(expect_head_event(container, "export-failed", content_head) == 0);
    CHECK(scpefe_container_activity_status(container, &status) == SCPEFE_STATUS_OK
        && !status.has_pending);
    free(target);
    free(backup);
    free(older_target);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    return 0;
}
