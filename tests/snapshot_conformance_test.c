#include "scpefe/scpefe.h"

#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)

typedef struct byte_buffer { uint8_t *data; size_t size; } byte_buffer;

static int hex_digit(int value)
{
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
}

static int load_hex(const char *path, byte_buffer *result)
{
    FILE *input = fopen(path, "rb");
    int high = -1;
    int value = 0;
    size_t capacity = 0;
    CHECK(input != NULL);
    result->data = NULL;
    result->size = 0;
    while ((value = fgetc(input)) != EOF) {
        int digit = 0;
        if (value == '#') {
            while ((value = fgetc(input)) != EOF && value != '\n') {}
            continue;
        }
        if (isspace((unsigned char)value)) continue;
        digit = hex_digit(value);
        CHECK(digit >= 0);
        if (high < 0) {
            high = digit;
        } else {
            if (result->size == capacity) {
                uint8_t *grown = NULL;
                capacity = capacity == 0 ? 256 : capacity * 2;
                grown = (uint8_t *)realloc(result->data, capacity);
                CHECK(grown != NULL);
                result->data = grown;
            }
            result->data[result->size++] = (uint8_t)((high << 4) | digit);
            high = -1;
        }
    }
    CHECK(fclose(input) == 0);
    CHECK(high < 0 && result->size > 0);
    return 0;
}

static int vector_path(char *output, size_t size, const char *root, const char *name)
{
    const int written = snprintf(
        output, size, "%s/tests/vectors/draft-v1/%s", root, name
    );
    CHECK(written >= 0 && (size_t)written < size);
    return 0;
}

int main(int argc, char **argv)
{
    static const struct { const char *name; scpefe_status expected; } invalid[] = {
        {"snapshot-unsupported-version.hex", SCPEFE_STATUS_UNSUPPORTED_FORMAT},
        {"snapshot-duplicate-key.hex", SCPEFE_STATUS_MALFORMED_CBOR},
        {"snapshot-invalid-utf8.hex", SCPEFE_STATUS_MALFORMED_CBOR},
        {"snapshot-trailing-data.hex", SCPEFE_STATUS_MALFORMED_CBOR},
    };
    scpefe_status invalid_results[sizeof(invalid) / sizeof(invalid[0])] = {0};
    char path[1024] = {0};
    byte_buffer valid = {0};
    scpefe_revision_limits_v1 limits = {0};
    scpefe_decoded_snapshot_revision *decoded = NULL;
    scpefe_snapshot_revision_v1 view = {0};
    uint8_t *reencoded = NULL;
    size_t reencoded_size = 0;
    char *diagnostic = NULL;
    size_t diagnostic_size = 0;
    scpefe_status decode_status = SCPEFE_STATUS_INVALID_ARGUMENT;
    scpefe_status encode_status = SCPEFE_STATUS_INVALID_ARGUMENT;
    scpefe_status diagnostic_status = SCPEFE_STATUS_INVALID_ARGUMENT;
    size_t index = 0;

    if (argc != 2) {
        fprintf(stderr, "usage: snapshot_conformance_test SOURCE_DIR\n");
        return 2;
    }
    limits.struct_size = sizeof(limits);
    CHECK(scpefe_revision_limits_default(&limits) == SCPEFE_STATUS_OK);
    CHECK(vector_path(
        path, sizeof(path), argv[1], "valid/snapshot-revision.hex"
    ) == 0);
    CHECK(load_hex(path, &valid) == 0);
    decode_status = scpefe_snapshot_revision_decode(
        valid.data, valid.size, &limits, &decoded
    );
    CHECK(decode_status == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    CHECK(scpefe_decoded_snapshot_revision_view(decoded, &view) == SCPEFE_STATUS_OK);
    CHECK(scpefe_snapshot_revision_encode(
        &view, &limits, NULL, 0, &reencoded_size
    ) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    reencoded = (uint8_t *)malloc(reencoded_size);
    CHECK(reencoded != NULL);
    encode_status = scpefe_snapshot_revision_encode(
        &view, &limits, reencoded, reencoded_size, &reencoded_size
    );
    CHECK(encode_status == SCPEFE_STATUS_OK);
    CHECK(reencoded_size == valid.size);
    CHECK(memcmp(reencoded, valid.data, valid.size) == 0);
    CHECK(scpefe_snapshot_revision_diagnostic_json(
        valid.data, valid.size, &limits, 0, NULL, 0, &diagnostic_size
    ) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    ++diagnostic_size;
    diagnostic = (char *)malloc(diagnostic_size);
    CHECK(diagnostic != NULL);
    diagnostic_status = scpefe_snapshot_revision_diagnostic_json(
        valid.data, valid.size, &limits, 0, diagnostic, diagnostic_size,
        &diagnostic_size
    );
    CHECK(diagnostic_status == SCPEFE_STATUS_OK);
    CHECK(strstr(diagnostic, "\"content\":") == NULL);
    free(diagnostic);
    diagnostic = NULL;
    diagnostic_size = 0;
    CHECK(scpefe_snapshot_revision_diagnostic_json(
        valid.data, valid.size, &limits, 1, NULL, 0, &diagnostic_size
    ) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    ++diagnostic_size;
    diagnostic = (char *)malloc(diagnostic_size);
    CHECK(diagnostic != NULL);
    CHECK(scpefe_snapshot_revision_diagnostic_json(
        valid.data, valid.size, &limits, 1, diagnostic, diagnostic_size,
        &diagnostic_size
    ) == SCPEFE_STATUS_OK);
    CHECK(strstr(diagnostic, "\"content\":\"first line\\nsecond line\"") != NULL);
    scpefe_decoded_snapshot_revision_destroy(decoded);
    decoded = NULL;

    for (index = 0; index < sizeof(invalid) / sizeof(invalid[0]); ++index) {
        byte_buffer bytes = {0};
        decoded = (scpefe_decoded_snapshot_revision *)(uintptr_t)1;
        CHECK(vector_path(path, sizeof(path), argv[1], "invalid/") == 0);
        CHECK(strlen(path) + strlen(invalid[index].name) < sizeof(path));
        strcat(path, invalid[index].name);
        CHECK(load_hex(path, &bytes) == 0);
        invalid_results[index] = scpefe_snapshot_revision_decode(
            bytes.data, bytes.size, &limits, &decoded
        );
        CHECK(invalid_results[index] == invalid[index].expected);
        CHECK(decoded == NULL);
        free(bytes.data);
    }

    printf(
        "{\"schema\":\"scpefe-format-conformance-v1\","
        "\"valid\":[{\"vector\":\"snapshot-revision.hex\","
        "\"decode_status\":%d,\"encode_status\":%d,"
        "\"diagnostic_status\":%d,\"byte_identical\":true,"
        "\"content_redacted\":true,\"content_included\":true}],"
        "\"invalid\":[",
        (int)decode_status, (int)encode_status, (int)diagnostic_status
    );
    for (index = 0; index < sizeof(invalid) / sizeof(invalid[0]); ++index) {
        printf(
            "%s{\"vector\":\"%s\",\"decode_status\":%d}",
            index == 0 ? "" : ",", invalid[index].name,
            (int)invalid_results[index]
        );
    }
    printf("]}\n");

    free(diagnostic);
    free(reencoded);
    free(valid.data);
    return 0;
}
