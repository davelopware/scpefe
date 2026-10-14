#include "scpefe/scpefe.h"

#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "revised v3 history failed at line %d\n", __LINE__); return 1; } } while (0)

static scpefe_status read_clock(void *instance, uint64_t *value)
{
    *value = *(uint64_t *)instance;
    return SCPEFE_STATUS_OK;
}

static int digit(int c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int load(const char *root, const char *relative, uint8_t **data, size_t *size)
{
    char path[1024];
    FILE *input;
    int c, high = -1;
    size_t capacity = 0;
    int n = snprintf(path, sizeof(path),
        "%s/tests/vectors/draft-v3/%s", root, relative);
    CHECK(n > 0 && (size_t)n < sizeof(path));
    input = fopen(path, "rb");
    CHECK(input != NULL);
    while ((c = fgetc(input)) != EOF) {
        int low;
        if (c == '#') { while ((c = fgetc(input)) != EOF && c != '\n') {} continue; }
        if (isspace((unsigned char)c)) continue;
        low = digit(c);
        CHECK(low >= 0);
        if (high < 0) { high = low; continue; }
        if (*size == capacity) {
            uint8_t *grown;
            capacity = capacity ? capacity * 2 : 512;
            grown = (uint8_t *)realloc(*data, capacity);
            CHECK(grown != NULL);
            *data = grown;
        }
        (*data)[(*size)++] = (uint8_t)((high << 4) | low);
        high = -1;
    }
    CHECK(fclose(input) == 0 && high < 0 && *size > 0);
    return 0;
}

int main(int argc, char **argv)
{
    uint64_t now = 123;
    scpefe_host_services_v1 host = {sizeof(host), SCPEFE_ABI_VERSION, &now, read_clock};
    const uint8_t password[] = "correct horse battery staple";
    const uint8_t wrong[] = "incorrect password";
    scpefe_password_input_v1 auth = {sizeof(auth), SCPEFE_ABI_VERSION,
        wrong, sizeof(wrong) - 1};
    scpefe_container_open_v1 open = {0};
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    scpefe_revision_graph *graph = NULL, *locked_graph = NULL;
    scpefe_revision_page *page = NULL;
    scpefe_revision_metadata_v1 baseline = {0}, checkpoint = {0};
    scpefe_revision_result *result = NULL;
    scpefe_revision_result_view_v1 result_view = {0};
    scpefe_owned_snapshot *snapshot = NULL, *retained_snapshot = NULL;
    scpefe_owned_snapshot_view_v1 snapshot_view = {0};
    uint8_t *encrypted = NULL;
    size_t encrypted_size = 0, count = 0;
    uint8_t head[32], content_head[32];
    CHECK(argc == 2);
    CHECK(load(argv[1], "valid/pruned-checkpoint-container.hex",
        &encrypted, &encrypted_size) == 0);
    CHECK(scpefe_context_create(&host, &context) == SCPEFE_STATUS_OK);
    open.struct_size = sizeof(open);
    open.abi_version = SCPEFE_ABI_VERSION;
    open.bytes = encrypted;
    open.bytes_size = encrypted_size;
    CHECK(scpefe_container_open(context, &open, &container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_revision_graph(container, &graph) == SCPEFE_STATUS_LOCKED);
    CHECK(graph == NULL);
    CHECK(scpefe_container_unlock(container, &auth) == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    CHECK(scpefe_container_revision_graph(container, &graph) == SCPEFE_STATUS_LOCKED);
    auth.bytes = password;
    auth.bytes_size = sizeof(password) - 1;
    CHECK(scpefe_container_unlock(container, &auth) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_revision_graph(container, &graph) == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_graph_heads(graph, head, content_head) == SCPEFE_STATUS_OK);
    CHECK(memcmp(head, content_head, 32) != 0);
    CHECK(scpefe_revision_graph_list(graph, 0, 4, &page) == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_page_count(page, &count) == SCPEFE_STATUS_OK && count == 4);
    baseline.struct_size = checkpoint.struct_size = sizeof(baseline);
    CHECK(scpefe_revision_page_metadata(page, 3, &baseline) == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_page_metadata(page, 2, &checkpoint) == SCPEFE_STATUS_OK);
    CHECK(baseline.storage_kind == 4 && !baseline.body_available
        && !baseline.text_available);
    CHECK(checkpoint.storage_kind == 3 && checkpoint.text_available);
    CHECK(scpefe_revision_graph_body(graph, baseline.id, &result)
        == SCPEFE_STATUS_BODY_UNAVAILABLE && result == NULL);
    CHECK(scpefe_revision_graph_reconstruct(graph, baseline.id, &result)
        == SCPEFE_STATUS_BODY_UNAVAILABLE && result == NULL);
    CHECK(scpefe_revision_graph_reconstruct(graph, checkpoint.id, &result)
        == SCPEFE_STATUS_OK);
    result_view.struct_size = sizeof(result_view);
    CHECK(scpefe_revision_result_view(result, &result_view) == SCPEFE_STATUS_OK);
    CHECK(result_view.text_size == 11
        && memcmp(result_view.text, "alpha\nbeta\n", 11) == 0);
    scpefe_revision_result_destroy(result);
    result = NULL;
    CHECK(scpefe_container_read(container, &snapshot) == SCPEFE_STATUS_OK);
    snapshot_view.struct_size = sizeof(snapshot_view);
    snapshot_view.abi_version = SCPEFE_ABI_VERSION;
    CHECK(scpefe_owned_snapshot_view(snapshot, &snapshot_view) == SCPEFE_STATUS_OK);
    CHECK(snapshot_view.content_size == 11
        && memcmp(snapshot_view.content, "alpha\nbeta\n", 11) == 0);
    retained_snapshot = snapshot;
    snapshot = NULL;
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_revision_graph(container, &locked_graph) == SCPEFE_STATUS_LOCKED);
    CHECK(locked_graph == NULL);
    CHECK(scpefe_container_read(container, &snapshot) == SCPEFE_STATUS_LOCKED);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_graph_reconstruct(graph, checkpoint.id, &result)
        == SCPEFE_STATUS_OK);
    scpefe_revision_result_destroy(result);
    result = NULL;
    scpefe_revision_page_destroy(page);
    scpefe_revision_graph_destroy(graph);
    scpefe_owned_snapshot_destroy(retained_snapshot);
    encrypted[encrypted_size - 1] ^= 1;
    CHECK(scpefe_container_open(context, &open, &container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_unlock(container, &auth) == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    CHECK(scpefe_container_revision_graph(container, &graph) == SCPEFE_STATUS_LOCKED);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    free(encrypted);
    {
        const char *invalid[] = {"invalid/envelope-slot-count-zero.hex",
            "invalid/envelope-payload-length-overflow.hex",
            "invalid/envelope-wrapper-length.hex"};
        const scpefe_status expected[] = {SCPEFE_STATUS_MALFORMED_CONTAINER,
            SCPEFE_STATUS_MALFORMED_CONTAINER, SCPEFE_STATUS_UNSUPPORTED_FORMAT};
        size_t i;
        for (i = 0; i < sizeof(invalid) / sizeof(invalid[0]); ++i) {
            uint8_t *bad = NULL;
            size_t bad_size = 0;
            CHECK(load(argv[1], invalid[i], &bad, &bad_size) == 0);
            open.bytes = bad;
            open.bytes_size = bad_size;
            container = NULL;
            CHECK(scpefe_container_open(context, &open, &container) == expected[i]);
            CHECK(container == NULL);
            free(bad);
        }
    }
    scpefe_context_destroy(context);
    return 0;
}
