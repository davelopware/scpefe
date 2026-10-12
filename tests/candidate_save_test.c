#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)

static scpefe_status clock_read(void *instance, uint64_t *value)
{
    *value = *(uint64_t *)instance;
    return SCPEFE_STATUS_OK;
}

static int copy_bytes(scpefe_container *container, uint8_t **bytes, size_t *size)
{
    CHECK(scpefe_container_copy_bytes(container, NULL, 0, size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    *bytes = malloc(*size);
    CHECK(*bytes != NULL);
    CHECK(scpefe_container_copy_bytes(container, *bytes, *size, size) == SCPEFE_STATUS_OK);
    return 0;
}

static int read_text(scpefe_container *container, const char *expected)
{
    scpefe_owned_snapshot *snapshot = NULL;
    scpefe_owned_snapshot_view_v1 view = {0};
    view.struct_size = sizeof(view);
    view.abi_version = SCPEFE_ABI_VERSION;
    CHECK(scpefe_container_read(container, &snapshot) == SCPEFE_STATUS_OK);
    CHECK(scpefe_owned_snapshot_view(snapshot, &view) == SCPEFE_STATUS_OK);
    CHECK(view.content_size == strlen(expected));
    CHECK(memcmp(view.content, expected, view.content_size) == 0);
    scpefe_owned_snapshot_destroy(snapshot);
    return 0;
}

static int digit(int c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

static int read_hex(const char *path, uint8_t **bytes, size_t *size)
{
    FILE *input = fopen(path, "r");
    CHECK(input != NULL);
    size_t capacity = 4096;
    *bytes = malloc(capacity);
    CHECK(*bytes != NULL);
    *size = 0;
    int high = -1, c;
    while ((c = fgetc(input)) != EOF) {
        if (c == '#') { while ((c = fgetc(input)) != EOF && c != '\n') {} continue; }
        const int value = digit(c);
        if (value < 0) continue;
        if (high < 0) { high = value; continue; }
        if (*size == capacity) {
            capacity *= 2;
            uint8_t *grown = realloc(*bytes, capacity);
            CHECK(grown != NULL);
            *bytes = grown;
        }
        (*bytes)[(*size)++] = (uint8_t)((high << 4) | value);
        high = -1;
    }
    fclose(input);
    CHECK(high < 0);
    return 0;
}

static int revised_save_cycle(const char *root)
{
    char path[1024];
    CHECK(snprintf(path, sizeof(path), "%s/tests/vectors/draft-v3/valid/baseline-container.hex",
        root) < (int)sizeof(path));
    uint8_t *base = NULL;
    size_t base_size = 0;
    CHECK(read_hex(path, &base, &base_size) == 0);
    uint64_t time = 42;
    const uint8_t password[] = "correct horse battery staple";
    scpefe_host_services_v1 host = {sizeof(host), SCPEFE_ABI_VERSION, &time, clock_read};
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    scpefe_container_open_v1 open = {sizeof(open), SCPEFE_ABI_VERSION, base, base_size};
    scpefe_password_input_v1 unlock = {sizeof(unlock), SCPEFE_ABI_VERSION,
        password, sizeof(password) - 1};
    CHECK(scpefe_context_create(&host, &context) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_open(context, &open, &container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_unlock(container, &unlock) == SCPEFE_STATUS_OK);
    CHECK(read_text(container, "alpha\n") == 0);
    CHECK(scpefe_container_confirm_edit_lease(container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_submit_content(container, "alpha\nbeta\n", 11) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_unlock(container, &unlock) == SCPEFE_STATUS_OK);
    CHECK(read_text(container, "alpha\nbeta\n") == 0);
    CHECK(scpefe_container_confirm_edit_lease(container) == SCPEFE_STATUS_OK);
    scpefe_revision_graph *graph = NULL;
    uint8_t initial_head[SCPEFE_REVISION_ID_SIZE];
    uint8_t content_head[SCPEFE_REVISION_ID_SIZE];
    CHECK(scpefe_container_revision_graph(container, &graph) == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_graph_heads(graph, initial_head, content_head) == SCPEFE_STATUS_OK);
    scpefe_revision_graph_destroy(graph);
    scpefe_container_save_v1 save = {0};
    save.struct_size = sizeof(save);
    save.abi_version = SCPEFE_ABI_VERSION;
    save.operation_id = 1;
    save.kind = SCPEFE_SAVE_REGULAR;
    save.password = password;
    save.password_size = sizeof(password) - 1;
    save.profile_name = "Ada";
    save.profile_name_size = 3;
    save.profile_email = "ada@example.org";
    save.profile_email_size = 15;
    save.device_name = "test";
    save.device_name_size = 4;
    save.timestamp_ms = 2000;
    scpefe_candidate_info_v1 info = {sizeof(info), SCPEFE_ABI_VERSION};
    CHECK(scpefe_container_prepare_save(container, &save, &info) == SCPEFE_STATUS_OK);
    CHECK(memcmp(info.source_head, initial_head, sizeof(initial_head)) == 0);
    size_t candidate_size = 0;
    CHECK(scpefe_container_copy_candidate(container, 1, NULL, 0, &candidate_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *candidate = malloc(candidate_size);
    CHECK(candidate != NULL);
    CHECK(scpefe_container_copy_candidate(container, 1, candidate, candidate_size,
        &candidate_size) == SCPEFE_STATUS_OK);
    uint8_t *confirmed = NULL;
    size_t confirmed_size = 0;
    CHECK(copy_bytes(container, &confirmed, &confirmed_size) == 0);
    CHECK(confirmed_size == base_size && memcmp(confirmed, base, base_size) == 0);
    free(confirmed);
    uint32_t effects = 0;
    CHECK(scpefe_container_acknowledge_save(container, 1,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_OK);
    CHECK(read_text(container, "alpha\nbeta\n") == 0);
    CHECK(copy_bytes(container, &confirmed, &confirmed_size) == 0);
    CHECK(confirmed_size == candidate_size
        && memcmp(confirmed, candidate, candidate_size) == 0);
    free(confirmed);
    uint8_t provisional_head[SCPEFE_REVISION_ID_SIZE];
    CHECK(scpefe_container_revision_graph(container, &graph) == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_graph_heads(graph, provisional_head, content_head) == SCPEFE_STATUS_OK);
    scpefe_revision_graph_destroy(graph);
    save.operation_id = 2;
    save.kind = SCPEFE_SAVE_MANUAL;
    CHECK(scpefe_container_prepare_save(container, &save, &info) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_acknowledge_save(container, 2,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_revision_graph(container, &graph) == SCPEFE_STATUS_OK);
    uint8_t sealed_head[SCPEFE_REVISION_ID_SIZE];
    CHECK(scpefe_revision_graph_heads(graph, sealed_head, content_head) == SCPEFE_STATUS_OK);
    CHECK(memcmp(sealed_head, provisional_head, sizeof(sealed_head)) == 0);
    scpefe_revision_graph_destroy(graph);
    CHECK(scpefe_container_submit_content(container, "gamma\n", 6) == SCPEFE_STATUS_OK);
    save.operation_id = 3;
    save.kind = SCPEFE_SAVE_REGULAR;
    save.timestamp_ms = 3000;
    CHECK(scpefe_container_prepare_save(container, &save, &info) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_acknowledge_save(container, 3,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_OK);
    save.operation_id = 4;
    save.kind = SCPEFE_SAVE_DISCARD;
    CHECK(scpefe_container_prepare_save(container, &save, &info) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_acknowledge_save(container, 4,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_OK);
    CHECK(read_text(container, "alpha\nbeta\n") == 0);
    CHECK(scpefe_container_revision_graph(container, &graph) == SCPEFE_STATUS_OK);
    uint8_t discarded_head[SCPEFE_REVISION_ID_SIZE];
    CHECK(scpefe_revision_graph_heads(graph, discarded_head, content_head) == SCPEFE_STATUS_OK);
    CHECK(memcmp(discarded_head, sealed_head, sizeof(sealed_head)) == 0);
    scpefe_revision_graph_destroy(graph);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    free(candidate);
    free(base);
    return 0;
}

static int revised_checkpoint_save(const char *root)
{
    char path[1024];
    CHECK(snprintf(path, sizeof(path),
        "%s/tests/vectors/draft-v3/valid/pruned-checkpoint-container.hex",
        root) < (int)sizeof(path));
    uint8_t *base = NULL;
    size_t base_size = 0;
    CHECK(read_hex(path, &base, &base_size) == 0);
    uint64_t time = 42;
    const uint8_t password[] = "correct horse battery staple";
    scpefe_host_services_v1 host = {sizeof(host), SCPEFE_ABI_VERSION, &time, clock_read};
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    scpefe_container_open_v1 open = {sizeof(open), SCPEFE_ABI_VERSION, base, base_size};
    scpefe_password_input_v1 unlock = {sizeof(unlock), SCPEFE_ABI_VERSION,
        password, sizeof(password) - 1};
    CHECK(scpefe_context_create(&host, &context) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_open(context, &open, &container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_unlock(container, &unlock) == SCPEFE_STATUS_OK);
    CHECK(read_text(container, "alpha\nbeta\n") == 0);
    CHECK(scpefe_container_confirm_edit_lease(container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_submit_content(container, "alpha\nbeta\ngamma\n", 17)
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
    save.profile_email_size = 15;
    save.device_name = "test";
    save.device_name_size = 4;
    save.timestamp_ms = 4000;
    scpefe_candidate_info_v1 info = {sizeof(info), SCPEFE_ABI_VERSION};
    CHECK(scpefe_container_prepare_save(container, &save, &info) == SCPEFE_STATUS_OK);
    uint32_t effects = 0;
    CHECK(scpefe_container_acknowledge_save(container, 1,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_OK);
    CHECK(read_text(container, "alpha\nbeta\ngamma\n") == 0);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    free(base);
    return 0;
}

int main(int argc, char **argv)
{
    CHECK(argc == 2);
    uint64_t time = 42;
    const uint8_t password[] = "0b4e79c5-7cfe-4b7c-b4f3-d89129cb7b5e";
    const uint8_t recovery[] = "f5ee6791-97ad-44bc-8a72-b79b7b26316a";
    scpefe_host_services_v1 host = {sizeof(host), SCPEFE_ABI_VERSION, &time, clock_read};
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    scpefe_container_create_v1 create = {0};
    create.struct_size = sizeof(create);
    create.abi_version = SCPEFE_ABI_VERSION;
    create.document.struct_size = sizeof(create.document);
    create.document.profile_name = "Ada";
    create.document.profile_name_size = 3;
    create.document.profile_email = "ada@example.org";
    create.document.profile_email_size = 15;
    create.document.device_name = "test";
    create.document.device_name_size = 4;
    create.document.content = "base";
    create.document.content_size = 4;
    create.document.timestamp_ms = 1;
    create.document.owner_password = password;
    create.document.owner_password_size = sizeof(password) - 1;
    create.document.recovery_password = recovery;
    create.document.recovery_password_size = sizeof(recovery) - 1;
    CHECK(scpefe_context_create(&host, &context) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_create(context, &create, &container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_submit_content(container, "first", 5) == SCPEFE_STATUS_INVALID_STATE);
    CHECK(scpefe_container_confirm_edit_lease(container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_submit_content(container, "first", 5) == SCPEFE_STATUS_OK);
    CHECK(read_text(container, "first") == 0);
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    scpefe_password_input_v1 reauth = {sizeof(reauth), SCPEFE_ABI_VERSION,
        password, sizeof(password) - 1};
    CHECK(scpefe_container_unlock(container, &reauth) == SCPEFE_STATUS_OK);
    CHECK(read_text(container, "first") == 0);
    CHECK(scpefe_container_confirm_edit_lease(container) == SCPEFE_STATUS_OK);

    uint8_t *base = NULL;
    size_t base_size = 0;
    CHECK(copy_bytes(container, &base, &base_size) == 0);
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
    save.profile_email_size = 15;
    save.device_name = "test";
    save.device_name_size = 4;
    save.timestamp_ms = 2;
    scpefe_candidate_info_v1 info = {0};
    info.struct_size = sizeof(info);
    info.abi_version = SCPEFE_ABI_VERSION;
    CHECK(scpefe_container_prepare_save(container, &save, &info) == SCPEFE_STATUS_OK);
    CHECK(info.operation_id == 1 && info.byte_size > 0);
    CHECK(info.effect_mask == (SCPEFE_EFFECT_REREAD_TARGET
        | SCPEFE_EFFECT_JOURNAL_CANDIDATE | SCPEFE_EFFECT_PUBLISH_CANDIDATE));
    uint8_t first_source_head[SCPEFE_REVISION_ID_SIZE];
    memcpy(first_source_head, info.source_head, sizeof(first_source_head));
    uint8_t *unchanged = NULL;
    size_t unchanged_size = 0;
    CHECK(copy_bytes(container, &unchanged, &unchanged_size) == 0);
    CHECK(unchanged_size == base_size && memcmp(unchanged, base, base_size) == 0);
    free(unchanged);
    size_t candidate_size = 0;
    CHECK(scpefe_container_copy_candidate(container, 1, NULL, 0, &candidate_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    CHECK(candidate_size == info.byte_size);
    uint8_t *candidate = malloc(candidate_size);
    uint8_t *again = malloc(candidate_size);
    CHECK(candidate && again);
    CHECK(scpefe_container_copy_candidate(container, 1, candidate, candidate_size,
        &candidate_size) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_copy_candidate(container, 1, again, candidate_size,
        &candidate_size) == SCPEFE_STATUS_OK);
    CHECK(memcmp(candidate, again, candidate_size) == 0);
    CHECK(scpefe_container_copy_candidate(container, 0, again, candidate_size,
        &candidate_size) == SCPEFE_STATUS_STALE_OPERATION);
    CHECK(scpefe_container_submit_content(container, "newer", 5) == SCPEFE_STATUS_OK);
    CHECK(read_text(container, "newer") == 0);
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_INVALID_STATE);
    uint32_t effects = 0;
    CHECK(scpefe_container_acknowledge_save(container, 0,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_STALE_OPERATION);
    CHECK(scpefe_container_acknowledge_save(container, 1,
        SCPEFE_PUBLICATION_AMBIGUOUS, &effects) == SCPEFE_STATUS_OK);
    CHECK(effects == SCPEFE_EFFECT_RECOVER_CANDIDATE);
    save.operation_id = 2;
    CHECK(scpefe_container_prepare_save(container, &save, &info)
        == SCPEFE_STATUS_INVALID_STATE);
    CHECK(scpefe_container_resolve_save(container, 0, 1, &effects)
        == SCPEFE_STATUS_STALE_OPERATION);
    CHECK(scpefe_container_resolve_save(container, 1, 1, &effects) == SCPEFE_STATUS_OK);
    CHECK(effects == (SCPEFE_EFFECT_ADOPT_CANDIDATE | SCPEFE_EFFECT_CLEAR_JOURNAL));
    CHECK(read_text(container, "newer") == 0);
    uint8_t *confirmed = NULL;
    size_t confirmed_size = 0;
    CHECK(copy_bytes(container, &confirmed, &confirmed_size) == 0);
    CHECK(confirmed_size == candidate_size
        && memcmp(confirmed, candidate, candidate_size) == 0);
    free(confirmed);
    CHECK(scpefe_container_copy_candidate(container, 1, again, candidate_size,
        &candidate_size) == SCPEFE_STATUS_STALE_OPERATION);

    save.kind = SCPEFE_SAVE_REGULAR;
    save.timestamp_ms = 3;
    CHECK(scpefe_container_prepare_save(container, &save, &info) == SCPEFE_STATUS_OK);
    CHECK(memcmp(first_source_head, info.source_head, sizeof(first_source_head)) != 0);
    CHECK(scpefe_container_acknowledge_save(container, 2,
        SCPEFE_PUBLICATION_DEFINITE_FAILURE, &effects) == SCPEFE_STATUS_OK);
    CHECK(effects == SCPEFE_EFFECT_CLEAR_JOURNAL);
    CHECK(read_text(container, "newer") == 0);
    save.operation_id = 3;
    CHECK(scpefe_container_prepare_save(container, &save, &info) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_acknowledge_save(container, 3,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_OK);
    CHECK(effects == (SCPEFE_EFFECT_ADOPT_CANDIDATE | SCPEFE_EFFECT_CLEAR_JOURNAL));
    save.operation_id = 4;
    save.kind = SCPEFE_SAVE_DISCARD;
    scpefe_container_save_v1 invalid_discard = save;
    invalid_discard.profile_name = NULL;
    CHECK(scpefe_container_prepare_save(container, &invalid_discard, &info)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    invalid_discard = save;
    invalid_discard.profile_email = NULL;
    CHECK(scpefe_container_prepare_save(container, &invalid_discard, &info)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    invalid_discard = save;
    invalid_discard.device_name = NULL;
    CHECK(scpefe_container_prepare_save(container, &invalid_discard, &info)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    CHECK(scpefe_container_prepare_save(container, &save, &info) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_acknowledge_save(container, 4,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_OK);
    CHECK(read_text(container, "first") == 0);
    CHECK(scpefe_container_prepare_save(container, &save, &info)
        == SCPEFE_STATUS_STALE_OPERATION);
    uint8_t *final_bytes = NULL;
    size_t final_size = 0;
    CHECK(copy_bytes(container, &final_bytes, &final_size) == 0);
    free(candidate);
    free(again);
    free(base);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_container_open_v1 open = {sizeof(open), SCPEFE_ABI_VERSION,
        final_bytes, final_size};
    CHECK(scpefe_container_open(context, &open, &container) == SCPEFE_STATUS_OK);
    scpefe_password_input_v1 recovery_auth = {sizeof(recovery_auth),
        SCPEFE_ABI_VERSION, recovery, sizeof(recovery) - 1};
    CHECK(scpefe_container_unlock(container, &recovery_auth) == SCPEFE_STATUS_OK);
    CHECK(read_text(container, "first") == 0);
    scpefe_revision_graph *recovered_graph = NULL;
    CHECK(scpefe_container_revision_graph(container, &recovered_graph) == SCPEFE_STATUS_OK);
    scpefe_revision_page *recovered_page = NULL;
    size_t recovered_count = 0;
    CHECK(scpefe_revision_graph_list(recovered_graph, 0, 10, &recovered_page)
        == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_page_count(recovered_page, &recovered_count) == SCPEFE_STATUS_OK);
    CHECK(recovered_count == 2);
    scpefe_revision_page_destroy(recovered_page);
    scpefe_revision_graph_destroy(recovered_graph);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    free(final_bytes);
    CHECK(revised_save_cycle(argv[1]) == 0);
    return revised_checkpoint_save(argv[1]);
}
