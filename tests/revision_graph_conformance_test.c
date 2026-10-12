#include "scpefe/scpefe.h"

#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "revision graph check failed at line %d\n", __LINE__); return 1; } } while (0)

typedef struct bytes { uint8_t *data; size_t size; } bytes;

static int digit(int c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int load(const char *root, const char *name, bytes *result)
{
    char path[1024];
    FILE *file = NULL;
    int value, high = -1;
    size_t capacity = 0;
    int written = snprintf(path, sizeof(path), "%s/tests/vectors/draft-v3/%s.hex", root, name);
    CHECK(written > 0 && (size_t)written < sizeof(path));
    file = fopen(path, "rb");
    CHECK(file != NULL);
    while ((value = fgetc(file)) != EOF) {
        int low;
        if (value == '#') { while ((value = fgetc(file)) != EOF && value != '\n') {} continue; }
        if (isspace((unsigned char)value)) continue;
        low = digit(value);
        CHECK(low >= 0);
        if (high < 0) { high = low; continue; }
        if (result->size == capacity) {
            uint8_t *grown;
            capacity = capacity ? capacity * 2 : 256;
            grown = (uint8_t *)realloc(result->data, capacity);
            CHECK(grown != NULL);
            result->data = grown;
        }
        result->data[result->size++] = (uint8_t)((high << 4) | low);
        high = -1;
    }
    CHECK(fclose(file) == 0);
    CHECK(high < 0 && result->size > 0);
    return 0;
}

static int decode(const char *root, const char *name,
    const scpefe_revision_limits_v1 *limits, scpefe_revision_graph **graph,
    bytes *input)
{
    CHECK(load(root, name, input) == 0);
    CHECK(scpefe_revision_graph_decode(input->data, input->size, limits, graph)
        == SCPEFE_STATUS_OK);
    return 0;
}

static int check_roundtrip(const scpefe_revision_graph *graph, const bytes *input)
{
    uint8_t *encoded = NULL;
    size_t size = 0;
    CHECK(scpefe_revision_graph_encode(graph, NULL, 0, &size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    CHECK(size == input->size);
    encoded = (uint8_t *)malloc(size);
    CHECK(encoded != NULL);
    CHECK(scpefe_revision_graph_encode(graph, encoded, size, &size) == SCPEFE_STATUS_OK);
    CHECK(memcmp(encoded, input->data, size) == 0);
    free(encoded);
    return 0;
}

static int check_diagnostic(const scpefe_revision_graph *graph)
{
    char *redacted = NULL, *clear = NULL;
    size_t size = 0;
    CHECK(scpefe_revision_graph_diagnostic_json(graph, 0, NULL, 0, &size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    redacted = (char *)malloc(size + 1);
    CHECK(redacted != NULL);
    CHECK(scpefe_revision_graph_diagnostic_json(graph, 0, redacted, size + 1, &size)
        == SCPEFE_STATUS_OK);
    CHECK(strstr(redacted, "\"content\":") == NULL);
    CHECK(scpefe_revision_graph_diagnostic_json(graph, 1, NULL, 0, &size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    clear = (char *)malloc(size + 1);
    CHECK(clear != NULL);
    CHECK(scpefe_revision_graph_diagnostic_json(graph, 1, clear, size + 1, &size)
        == SCPEFE_STATUS_OK);
    CHECK(strstr(clear, "\"content\":") != NULL);
    free(clear);
    free(redacted);
    return 0;
}

static int check_text(const scpefe_revision_graph *graph, const uint8_t *id,
    const char *expected)
{
    scpefe_revision_result *result = NULL;
    scpefe_revision_result_view_v1 view = {0};
    CHECK(scpefe_revision_graph_reconstruct(graph, id, &result) == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    CHECK(scpefe_revision_result_view(result, &view) == SCPEFE_STATUS_OK);
    CHECK(view.text_size == strlen(expected));
    CHECK(memcmp(view.text, expected, view.text_size) == 0);
    scpefe_revision_result_destroy(result);
    return 0;
}

int main(int argc, char **argv)
{
    static const char *valid[] = {
        "valid/baseline-payload", "valid/delta-event", "valid/pruned-checkpoint",
        "valid/foreign-merge", "valid/repeated-compaction"
    };
    static const struct { const char *name; scpefe_status status; } invalid[] = {
        {"invalid/nonminimal-key", SCPEFE_STATUS_MALFORMED_CBOR},
        {"invalid/duplicate-key", SCPEFE_STATUS_MALFORMED_CBOR},
        {"invalid/timestamp-bound", SCPEFE_STATUS_MALFORMED_CBOR},
        {"invalid/dangling-parent", SCPEFE_STATUS_MALFORMED_CBOR},
        {"invalid/delta-out-of-range", SCPEFE_STATUS_MALFORMED_CBOR},
        {"invalid/reconstruction-hash", SCPEFE_STATUS_MALFORMED_CBOR},
        {"invalid/unsupported-codec", SCPEFE_STATUS_UNSUPPORTED_FORMAT},
        {"invalid/text-invalid-utf8", SCPEFE_STATUS_MALFORMED_CBOR},
        {"invalid/checkpoint-content-hash", SCPEFE_STATUS_MALFORMED_CBOR},
        {"invalid/incorrect-revision-id", SCPEFE_STATUS_MALFORMED_CBOR},
        {"invalid/pruned-without-anchor", SCPEFE_STATUS_MALFORMED_CBOR},
        {"invalid/orphan-foreign", SCPEFE_STATUS_MALFORMED_CBOR},
        {"invalid/compaction-count", SCPEFE_STATUS_MALFORMED_CBOR},
        {"invalid/unknown-required-feature", SCPEFE_STATUS_UNSUPPORTED_FORMAT}
    };
    scpefe_revision_limits_v1 limits = {0};
    size_t i;
    CHECK(argc == 2);
    limits.struct_size = sizeof(limits);
    CHECK(scpefe_revision_limits_default(&limits) == SCPEFE_STATUS_OK);
    for (i = 0; i < sizeof(valid) / sizeof(valid[0]); ++i) {
        scpefe_revision_graph *graph = NULL;
        bytes input = {0};
        CHECK(decode(argv[1], valid[i], &limits, &graph, &input) == 0);
        CHECK(check_roundtrip(graph, &input) == 0);
        CHECK(check_diagnostic(graph) == 0);
        {
            scpefe_revision_limits_v1 small = limits;
            scpefe_revision_graph *limited = (scpefe_revision_graph *)(uintptr_t)1;
            small.max_input_bytes = input.size - 1;
            CHECK(scpefe_revision_graph_decode(input.data, input.size, &small, &limited)
                == SCPEFE_STATUS_LIMIT_EXCEEDED);
            CHECK(limited == NULL);
        }
        scpefe_revision_graph_destroy(graph);
        free(input.data);
    }
    for (i = 0; i < sizeof(invalid) / sizeof(invalid[0]); ++i) {
        scpefe_revision_graph *graph = (scpefe_revision_graph *)(uintptr_t)1;
        bytes input = {0};
        CHECK(load(argv[1], invalid[i].name, &input) == 0);
        CHECK(scpefe_revision_graph_decode(input.data, input.size, &limits, &graph)
            == invalid[i].status);
        CHECK(graph == NULL);
        free(input.data);
    }
    {
        scpefe_revision_graph *graph = NULL;
        scpefe_revision_page *page = NULL;
        scpefe_revision_metadata_v1 head = {0}, change = {0}, baseline = {0};
        scpefe_revision_result *body = NULL, *comparison = NULL;
        scpefe_revision_page *too_large = NULL;
        scpefe_revision_result_view_v1 view = {0};
        uint8_t head_id[32], content_id[32];
        size_t count = 0;
        bytes input = {0};
        CHECK(decode(argv[1], "valid/delta-event", &limits, &graph, &input) == 0);
        CHECK(scpefe_revision_graph_heads(graph, head_id, content_id) == SCPEFE_STATUS_OK);
        CHECK(memcmp(head_id, content_id, 32) != 0);
        CHECK(scpefe_revision_graph_list(graph, 0, 3, &page) == SCPEFE_STATUS_OK);
        CHECK(scpefe_revision_page_count(page, &count) == SCPEFE_STATUS_OK && count == 3);
        CHECK(scpefe_revision_graph_list(graph, 0, limits.max_collection_entries + 1,
            &too_large)
            == SCPEFE_STATUS_LIMIT_EXCEEDED);
        CHECK(too_large == NULL);
        head.struct_size = change.struct_size = baseline.struct_size = sizeof(head);
        CHECK(scpefe_revision_page_metadata(page, 0, &head) == SCPEFE_STATUS_OK);
        CHECK(scpefe_revision_page_metadata(page, 1, &change) == SCPEFE_STATUS_OK);
        CHECK(scpefe_revision_page_metadata(page, 2, &baseline) == SCPEFE_STATUS_OK);
        CHECK(head.original_kind == 2 && head.body_available == 0 && head.text_available);
        CHECK(change.original_kind == 1 && change.storage_kind == 2);
        CHECK(memcmp(head.id, head_id, 32) == 0);
        CHECK(memcmp(change.id, content_id, 32) == 0);
        CHECK(memcmp(change.content_parent, baseline.id, 32) == 0);
        CHECK(head.actor_name_size == 5 && memcmp(head.actor_name, "Alice", 5) == 0);
        CHECK(change.immutable_cbor_size > 0 && head.event_details_cbor_size > 0);
        CHECK(check_text(graph, head.id, "alpha\nbeta\n") == 0);
        CHECK(scpefe_revision_graph_body(graph, head.id, &body)
            == SCPEFE_STATUS_BODY_UNAVAILABLE && body == NULL);
        {
            uint8_t missing_id[32] = {0};
            CHECK(scpefe_revision_graph_body(graph, missing_id, &body)
                == SCPEFE_STATUS_REVISION_NOT_FOUND && body == NULL);
        }
        CHECK(scpefe_revision_graph_body(graph, change.id, &body) == SCPEFE_STATUS_OK);
        view.struct_size = sizeof(view);
        CHECK(scpefe_revision_result_view(body, &view) == SCPEFE_STATUS_OK);
        CHECK(view.body_cbor_size > 0);
        scpefe_revision_result_destroy(body);
        CHECK(scpefe_revision_graph_compare(graph, baseline.id, change.id, &comparison)
            == SCPEFE_STATUS_OK);
        view.struct_size = sizeof(view);
        CHECK(scpefe_revision_result_view(comparison, &view) == SCPEFE_STATUS_OK);
        CHECK(strstr(view.text, "+alpha\n") != NULL && strstr(view.text, "+beta\n") != NULL);
        scpefe_revision_result_destroy(comparison);
        scpefe_revision_graph_destroy(graph);
        CHECK(head.actor_name_size == 5 && memcmp(head.actor_name, "Alice", 5) == 0);
        scpefe_revision_page_destroy(page);
        free(input.data);
    }
    {
        scpefe_revision_graph *graph = NULL;
        scpefe_revision_graph *unpruned = NULL;
        scpefe_revision_page *page = NULL;
        scpefe_revision_page *unpruned_page = NULL;
        scpefe_revision_metadata_v1 baseline = {0}, checkpoint = {0};
        scpefe_revision_metadata_v1 old_baseline = {0}, old_change = {0};
        scpefe_revision_result *missing = NULL;
        bytes input = {0}, old_input = {0};
        CHECK(decode(argv[1], "valid/pruned-checkpoint", &limits, &graph, &input) == 0);
        CHECK(decode(argv[1], "valid/delta-event", &limits, &unpruned, &old_input) == 0);
        CHECK(scpefe_revision_graph_list(graph, 0, 4, &page) == SCPEFE_STATUS_OK);
        CHECK(scpefe_revision_graph_list(unpruned, 0, 3, &unpruned_page) == SCPEFE_STATUS_OK);
        baseline.struct_size = checkpoint.struct_size = sizeof(baseline);
        old_baseline.struct_size = old_change.struct_size = sizeof(old_baseline);
        CHECK(scpefe_revision_page_metadata(page, 3, &baseline) == SCPEFE_STATUS_OK);
        CHECK(scpefe_revision_page_metadata(page, 2, &checkpoint) == SCPEFE_STATUS_OK);
        CHECK(scpefe_revision_page_metadata(unpruned_page, 2, &old_baseline) == SCPEFE_STATUS_OK);
        CHECK(scpefe_revision_page_metadata(unpruned_page, 1, &old_change) == SCPEFE_STATUS_OK);
        CHECK(memcmp(baseline.id, old_baseline.id, 32) == 0);
        CHECK(memcmp(checkpoint.id, old_change.id, 32) == 0);
        CHECK(!baseline.body_available && !baseline.text_available);
        CHECK(checkpoint.storage_kind == 3 && checkpoint.body_available);
        CHECK(scpefe_revision_graph_reconstruct(graph, baseline.id, &missing)
            == SCPEFE_STATUS_BODY_UNAVAILABLE);
        CHECK(missing == NULL);
        CHECK(check_text(graph, checkpoint.id, "alpha\nbeta\n") == 0);
        scpefe_revision_page_destroy(page);
        scpefe_revision_page_destroy(unpruned_page);
        scpefe_revision_graph_destroy(graph);
        scpefe_revision_graph_destroy(unpruned);
        free(input.data);
        free(old_input.data);
    }
    {
        scpefe_revision_graph *graph = NULL;
        scpefe_revision_page *page = NULL;
        scpefe_revision_metadata_v1 foreign = {0}, merge = {0};
        scpefe_revision_result *result = NULL;
        bytes input = {0};
        CHECK(decode(argv[1], "valid/foreign-merge", &limits, &graph, &input) == 0);
        CHECK(scpefe_revision_graph_list(graph, 0, 2, &page) == SCPEFE_STATUS_OK);
        foreign.struct_size = merge.struct_size = sizeof(foreign);
        CHECK(scpefe_revision_page_metadata(page, 0, &merge) == SCPEFE_STATUS_OK);
        CHECK(scpefe_revision_page_metadata(page, 1, &foreign) == SCPEFE_STATUS_OK);
        CHECK(foreign.foreign && !foreign.body_available && !foreign.text_available);
        CHECK(merge.merge_source_count == 1 && memcmp(merge.merge_source_ids, foreign.id, 32) == 0);
        CHECK(memcmp(foreign.resolved_by, merge.id, 32) == 0);
        CHECK(scpefe_revision_graph_body(graph, foreign.id, &result)
            == SCPEFE_STATUS_BODY_UNAVAILABLE && result == NULL);
        CHECK(check_text(graph, merge.id, "alpha\nbeta\nremote\n") == 0);
        scpefe_revision_page_destroy(page);
        scpefe_revision_graph_destroy(graph);
        free(input.data);
    }
    printf("revision graph conformance: %zu valid, %zu invalid\n",
        sizeof(valid) / sizeof(valid[0]), sizeof(invalid) / sizeof(invalid[0]));
    return 0;
}
