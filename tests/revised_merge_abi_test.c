#include "scpefe/scpefe.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) { \
    fprintf(stderr, "revised merge failed at line %d\n", __LINE__); return 1; \
} } while (0)

static const uint8_t password[] = "correct horse battery staple";
static const uint8_t rotated_password[] =
    "new owner credential cedar meadow lantern";
static const uint8_t unrelated_password[] =
    "0b4e79c5-7cfe-4b7c-b4f3-d89129cb7b5e";

static scpefe_status clock_read(void *instance, uint64_t *value)
{
    *value = *(uint64_t *)instance;
    return SCPEFE_STATUS_OK;
}

static int digit(int c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

static int load_base(const char *root, uint8_t **bytes, size_t *size)
{
    char path[1024];
    CHECK(snprintf(path, sizeof(path),
        "%s/tests/vectors/draft-v3/valid/baseline-container.hex", root)
        < (int)sizeof(path));
    FILE *input = fopen(path, "rb");
    CHECK(input != NULL);
    size_t capacity = 0;
    int high = -1, c;
    while ((c = fgetc(input)) != EOF) {
        if (c == '#') { while ((c = fgetc(input)) != EOF && c != '\n') {} continue; }
        const int value = digit(c);
        if (value < 0) continue;
        if (high < 0) { high = value; continue; }
        if (*size == capacity) {
            capacity = capacity ? 2 * capacity : 1024;
            uint8_t *grown = realloc(*bytes, capacity);
            CHECK(grown != NULL);
            *bytes = grown;
        }
        (*bytes)[(*size)++] = (uint8_t)((high << 4) | value);
        high = -1;
    }
    CHECK(fclose(input) == 0 && high < 0 && *size > 0);
    return 0;
}

static int open_bytes(const uint8_t *bytes, size_t size,
    scpefe_context **context, scpefe_container **container)
{
    static uint64_t now = 42;
    scpefe_host_services_v1 host = {sizeof(host), SCPEFE_ABI_VERSION,
        &now, clock_read};
    scpefe_container_open_v1 open = {sizeof(open), SCPEFE_ABI_VERSION, bytes, size};
    scpefe_password_input_v1 unlock = {sizeof(unlock), SCPEFE_ABI_VERSION,
        password, sizeof(password) - 1};
    CHECK(scpefe_context_create(&host, context) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_open(*context, &open, container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_unlock(*container, &unlock) == SCPEFE_STATUS_OK);
    return 0;
}

static int save_branch(const uint8_t *base, size_t base_size,
    const char *text, uint64_t timestamp, uint8_t **bytes, size_t *size)
{
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    CHECK(open_bytes(base, base_size, &context, &container) == 0);
    CHECK(scpefe_container_confirm_edit_lease(container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_submit_content(container, text, strlen(text))
        == SCPEFE_STATUS_OK);
    scpefe_container_save_v1 save = {0};
    save.struct_size = sizeof(save);
    save.abi_version = SCPEFE_ABI_VERSION;
    save.operation_id = 1;
    save.kind = SCPEFE_SAVE_MANUAL;
    save.password = password;
    save.password_size = sizeof(password) - 1;
    save.profile_name = "Ada";
    save.profile_name_size = 3;
    save.profile_email = "ada@example.org";
    save.profile_email_size = strlen(save.profile_email);
    save.device_name = "merge test";
    save.device_name_size = strlen(save.device_name);
    save.timestamp_ms = timestamp;
    scpefe_candidate_info_v1 info = {sizeof(info), SCPEFE_ABI_VERSION};
    CHECK(scpefe_container_prepare_save(container, &save, &info) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_copy_candidate(container, 1, NULL, 0, size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    *bytes = malloc(*size);
    CHECK(*bytes != NULL);
    CHECK(scpefe_container_copy_candidate(container, 1, *bytes, *size, size)
        == SCPEFE_STATUS_OK);
    uint32_t effects = 0;
    CHECK(scpefe_container_acknowledge_save(container, 1,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    return 0;
}

static int head_of(const uint8_t *bytes, size_t size, uint8_t head[32])
{
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    scpefe_revision_graph *graph = NULL;
    uint8_t content[32];
    CHECK(open_bytes(bytes, size, &context, &container) == 0);
    CHECK(scpefe_container_revision_graph(container, &graph) == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_graph_heads(graph, head, content) == SCPEFE_STATUS_OK);
    scpefe_revision_graph_destroy(graph);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    return 0;
}

static int rotate_target(const uint8_t *source, size_t source_size,
    uint8_t **bytes, size_t *size)
{
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    CHECK(open_bytes(source, source_size, &context, &container) == 0);
    scpefe_container_slot_change_v1 change = {0};
    change.struct_size = sizeof(change);
    change.abi_version = SCPEFE_ABI_VERSION;
    change.operation_id = 1;
    change.kind = SCPEFE_SLOT_CHANGE_PASSWORD;
    change.actor_password = password;
    change.actor_password_size = sizeof(password) - 1;
    change.new_password = rotated_password;
    change.new_password_size = sizeof(rotated_password) - 1;
    change.client_name = "Ada";
    change.client_name_size = 3;
    change.client_email = "ada@example.org";
    change.client_email_size = strlen(change.client_email);
    change.device = "merge test";
    change.device_size = strlen(change.device);
    change.timestamp_ms = 3500;
    scpefe_candidate_info_v1 info = {sizeof(info), SCPEFE_ABI_VERSION};
    CHECK(scpefe_container_prepare_slot_change(container, &change, &info)
        == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_copy_candidate(container, 1, NULL, 0, size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    *bytes = malloc(*size);
    CHECK(*bytes != NULL);
    CHECK(scpefe_container_copy_candidate(container, 1, *bytes, *size, size)
        == SCPEFE_STATUS_OK);
    uint32_t effects = 0;
    CHECK(scpefe_container_acknowledge_save(container, 1,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    return 0;
}

static int create_unrelated(uint8_t **bytes, size_t *size)
{
    uint64_t now = 42;
    scpefe_host_services_v1 host = {sizeof(host), SCPEFE_ABI_VERSION,
        &now, clock_read};
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    scpefe_container_create_v1 create = {0};
    create.struct_size = sizeof(create);
    create.abi_version = SCPEFE_ABI_VERSION;
    create.document.struct_size = sizeof(create.document);
    create.document.profile_name = "Other";
    create.document.profile_name_size = 5;
    create.document.profile_email = "other@example.org";
    create.document.profile_email_size = strlen(create.document.profile_email);
    create.document.device_name = "merge test";
    create.document.device_name_size = 10;
    create.document.content = "unrelated\n";
    create.document.content_size = 10;
    create.document.timestamp_ms = 1;
    create.document.owner_password = unrelated_password;
    create.document.owner_password_size = sizeof(unrelated_password) - 1;
    CHECK(scpefe_context_create(&host, &context) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_create(context, &create, &container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_copy_bytes(container, NULL, 0, size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    *bytes = malloc(*size);
    CHECK(*bytes != NULL);
    CHECK(scpefe_container_copy_bytes(container, *bytes, *size, size)
        == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    return 0;
}

int main(int argc, char **argv)
{
    CHECK(argc == 2);
    uint8_t *base = NULL, *local = NULL, *target = NULL, *merged = NULL;
    size_t base_size = 0, local_size = 0, target_size = 0, merged_size = 0;
    CHECK(load_base(argv[1], &base, &base_size) == 0);
    CHECK(save_branch(base, base_size, "alpha\nlocal\n", 2000,
        &local, &local_size) == 0);
    CHECK(save_branch(base, base_size, "alpha\ntarget\n", 3000,
        &target, &target_size) == 0);
    uint8_t local_head[32], target_head[32];
    CHECK(head_of(local, local_size, local_head) == 0);
    CHECK(head_of(target, target_size, target_head) == 0);
    scpefe_revised_merge_save_v1 merge = {0};
    merge.struct_size = sizeof(merge);
    merge.abi_version = SCPEFE_ABI_VERSION;
    merge.target_container = target;
    merge.target_container_size = target_size;
    merge.local_container = local;
    merge.local_container_size = local_size;
    merge.target_password = merge.local_password = password;
    merge.target_password_size = merge.local_password_size = sizeof(password) - 1;
    merge.profile_name = "Ada";
    merge.profile_name_size = 3;
    merge.profile_email = "ada@example.org";
    merge.profile_email_size = strlen(merge.profile_email);
    merge.device_name = "merge test";
    merge.device_name_size = strlen(merge.device_name);
    merge.content = "alpha\nresolved\n";
    merge.content_size = strlen(merge.content);
    merge.timestamp_ms = 4000;
    merge.abi_version = SCPEFE_ABI_VERSION + 1;
    CHECK(scpefe_revised_merge_save(&merge, NULL, 0, &merged_size)
        == SCPEFE_STATUS_UNSUPPORTED_ABI);
    merge.abi_version = SCPEFE_ABI_VERSION;
    CHECK(scpefe_revised_merge_save(&merge, NULL, 0, &merged_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    merged = malloc(merged_size);
    CHECK(merged != NULL);
    CHECK(scpefe_revised_merge_save(&merge, merged, merged_size, &merged_size)
        == SCPEFE_STATUS_OK);
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    scpefe_revision_graph *graph = NULL;
    scpefe_revision_page *page = NULL;
    scpefe_owned_snapshot *snapshot = NULL;
    scpefe_owned_snapshot_view_v1 view = {sizeof(view), SCPEFE_ABI_VERSION};
    scpefe_revision_metadata_v1 metadata = {sizeof(metadata)};
    uint8_t merged_head[32], content_head[32];
    size_t count = 0;
    CHECK(open_bytes(merged, merged_size, &context, &container) == 0);
    CHECK(scpefe_container_read(container, &snapshot) == SCPEFE_STATUS_OK);
    CHECK(scpefe_owned_snapshot_view(snapshot, &view) == SCPEFE_STATUS_OK);
    CHECK(view.content_size == merge.content_size
        && memcmp(view.content, merge.content, view.content_size) == 0);
    scpefe_owned_snapshot_destroy(snapshot);
    CHECK(scpefe_container_revision_graph(container, &graph) == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_graph_heads(graph, merged_head, content_head)
        == SCPEFE_STATUS_OK);
    CHECK(memcmp(merged_head, content_head, 32) == 0);
    CHECK(scpefe_revision_graph_list(graph, 0, 4, &page) == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_page_count(page, &count) == SCPEFE_STATUS_OK && count == 4);
    CHECK(scpefe_revision_page_metadata(page, 0, &metadata) == SCPEFE_STATUS_OK);
    CHECK(metadata.has_content_parent && memcmp(metadata.content_parent, local_head, 32) == 0);
    CHECK(metadata.merge_source_count == 1
        && memcmp(metadata.merge_source_ids, target_head, 32) == 0);
    CHECK(scpefe_revision_page_metadata(page, 1, &metadata) == SCPEFE_STATUS_OK);
    CHECK(metadata.foreign && !metadata.text_available
        && metadata.has_resolved_by
        && memcmp(metadata.resolved_by, merged_head, 32) == 0);
    scpefe_revision_page_destroy(page);
    scpefe_revision_graph_destroy(graph);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);

    uint8_t *target_next = NULL, *merged_next = NULL;
    size_t target_next_size = 0, merged_next_size = 0;
    CHECK(save_branch(target, target_size, "alpha\ntarget next\n", 4500,
        &target_next, &target_next_size) == 0);
    merge.local_container = merged;
    merge.local_container_size = merged_size;
    merge.target_container = target_next;
    merge.target_container_size = target_next_size;
    merge.content = "alpha\nresolved again\n";
    merge.content_size = strlen(merge.content);
    merge.timestamp_ms = 5000;
    CHECK(scpefe_revised_merge_save(&merge, NULL, 0, &merged_next_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    merged_next = malloc(merged_next_size);
    CHECK(merged_next != NULL);
    CHECK(scpefe_revised_merge_save(&merge, merged_next, merged_next_size,
        &merged_next_size) == SCPEFE_STATUS_OK);
    CHECK(open_bytes(merged_next, merged_next_size, &context, &container) == 0);
    CHECK(scpefe_container_read(container, &snapshot) == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    view.abi_version = SCPEFE_ABI_VERSION;
    CHECK(scpefe_owned_snapshot_view(snapshot, &view) == SCPEFE_STATUS_OK);
    CHECK(view.content_size == merge.content_size
        && memcmp(view.content, merge.content, view.content_size) == 0);
    scpefe_owned_snapshot_destroy(snapshot);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    free(target_next); free(merged_next);
    merge.local_container = local;
    merge.local_container_size = local_size;
    merge.content = "alpha\nresolved\n";
    merge.content_size = strlen(merge.content);
    merge.timestamp_ms = 4000;

    merge.target_container = base;
    merge.target_container_size = base_size;
    CHECK(scpefe_revised_merge_save(&merge, NULL, 0, &merged_size)
        == SCPEFE_STATUS_TARGET_ROLLBACK);
    merge.target_container = target;
    merge.target_container_size = target_size;
    merge.target_password = (const uint8_t *)"wrong password";
    merge.target_password_size = 14;
    CHECK(scpefe_revised_merge_save(&merge, NULL, 0, &merged_size)
        == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    merge.target_password = password;
    merge.target_password_size = sizeof(password) - 1;

    uint8_t *unrelated = NULL;
    size_t unrelated_size = 0;
    CHECK(create_unrelated(&unrelated, &unrelated_size) == 0);
    merge.target_container = unrelated;
    merge.target_container_size = unrelated_size;
    merge.target_password = unrelated_password;
    merge.target_password_size = sizeof(unrelated_password) - 1;
    CHECK(scpefe_revised_merge_save(&merge, NULL, 0, &merged_size)
        == SCPEFE_STATUS_UNRELATED_TARGET);
    merge.target_container = target;
    merge.target_container_size = target_size;
    merge.target_password = password;
    merge.target_password_size = sizeof(password) - 1;

    CHECK(open_bytes(local, local_size, &context, &container) == 0);
    uint32_t effects = 0;
    scpefe_container_target_v1 observed = {sizeof(observed), SCPEFE_ABI_VERSION,
        base, base_size, password, sizeof(password) - 1};
    CHECK(scpefe_container_apply_target(container, &observed, &effects)
        == SCPEFE_STATUS_TARGET_ROLLBACK);
    observed.bytes = unrelated;
    observed.bytes_size = unrelated_size;
    observed.password = unrelated_password;
    observed.password_size = sizeof(unrelated_password) - 1;
    CHECK(scpefe_container_apply_target(container, &observed, &effects)
        == SCPEFE_STATUS_UNRELATED_TARGET);
    observed.bytes = target;
    observed.bytes_size = target_size;
    observed.password = password;
    observed.password_size = sizeof(password) - 1;
    CHECK(scpefe_container_apply_target(container, &observed, &effects)
        == SCPEFE_STATUS_OK);
    CHECK(effects == 0);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    uint8_t *rotated_target = NULL;
    size_t rotated_size = 0;
    CHECK(rotate_target(target, target_size, &rotated_target, &rotated_size) == 0);
    merge.target_container = rotated_target;
    merge.target_container_size = rotated_size;
    merge.target_password = rotated_password;
    merge.target_password_size = sizeof(rotated_password) - 1;
    size_t rotated_merge_size = 0;
    CHECK(scpefe_revised_merge_save(&merge, NULL, 0, &rotated_merge_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *rotated_merge = malloc(rotated_merge_size);
    CHECK(rotated_merge != NULL);
    CHECK(scpefe_revised_merge_save(&merge, rotated_merge, rotated_merge_size,
        &rotated_merge_size) == SCPEFE_STATUS_OK);
    scpefe_host_services_v1 host = {0};
    uint64_t now = 42;
    host.struct_size = sizeof(host);
    host.abi_version = SCPEFE_ABI_VERSION;
    host.instance_data = &now;
    host.monotonic_time_ms = clock_read;
    scpefe_container_open_v1 open = {sizeof(open), SCPEFE_ABI_VERSION,
        rotated_merge, rotated_merge_size};
    scpefe_password_input_v1 old_password = {sizeof(old_password),
        SCPEFE_ABI_VERSION, password, sizeof(password) - 1};
    CHECK(scpefe_context_create(&host, &context) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_open(context, &open, &container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_unlock(container, &old_password)
        == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    scpefe_password_input_v1 current_password = {sizeof(current_password),
        SCPEFE_ABI_VERSION, rotated_password, sizeof(rotated_password) - 1};
    CHECK(scpefe_container_unlock(container, &current_password) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    free(rotated_merge);
    CHECK(open_bytes(local, local_size, &context, &container) == 0);
    CHECK(scpefe_container_confirm_edit_lease(container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_submit_content(container, "alpha\nunsaved\n", 14)
        == SCPEFE_STATUS_OK);
    observed.bytes = rotated_target;
    observed.bytes_size = rotated_size;
    observed.password = rotated_password;
    observed.password_size = sizeof(rotated_password) - 1;
    CHECK(scpefe_container_apply_target(container, &observed, &effects)
        == SCPEFE_STATUS_OK);
    CHECK((effects & (SCPEFE_EFFECT_REAUTHENTICATE_TARGET
        | SCPEFE_EFFECT_PRESERVE_UNSAVED_WORK | SCPEFE_EFFECT_CLEAR_DISPLAY
        | SCPEFE_EFFECT_STOP_HEARTBEAT))
        == (SCPEFE_EFFECT_REAUTHENTICATE_TARGET
            | SCPEFE_EFFECT_PRESERVE_UNSAVED_WORK
            | SCPEFE_EFFECT_CLEAR_DISPLAY | SCPEFE_EFFECT_STOP_HEARTBEAT));
    scpefe_container_status_v1 status = {sizeof(status), SCPEFE_ABI_VERSION};
    CHECK(scpefe_container_status(container, &status) == SCPEFE_STATUS_OK);
    CHECK(status.is_locked && !status.can_edit);
    scpefe_password_input_v1 reauthenticate = {sizeof(reauthenticate),
        SCPEFE_ABI_VERSION, rotated_password, sizeof(rotated_password) - 1};
    CHECK(scpefe_container_unlock(container, &reauthenticate) == SCPEFE_STATUS_OK);
    snapshot = NULL;
    CHECK(scpefe_container_read(container, &snapshot) == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    view.abi_version = SCPEFE_ABI_VERSION;
    CHECK(scpefe_owned_snapshot_view(snapshot, &view) == SCPEFE_STATUS_OK);
    CHECK(view.content_size == 14
        && memcmp(view.content, "alpha\nunsaved\n", 14) == 0);
    scpefe_owned_snapshot_destroy(snapshot);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    free(base); free(local); free(target); free(merged); free(rotated_target);
    free(unrelated);
    return 0;
}
