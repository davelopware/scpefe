#include "scpefe/scpefe.h"

#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)

typedef struct byte_buffer { uint8_t *data; size_t size; } byte_buffer;

static int hex_digit(int c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int load_hex(const char *path, byte_buffer *result)
{
    FILE *input = fopen(path, "rb");
    int high = -1;
    int c = 0;
    size_t capacity = 0;
    CHECK(input != NULL);
    result->data = NULL;
    result->size = 0;
    while ((c = fgetc(input)) != EOF) {
        int digit = 0;
        if (c == '#') {
            while ((c = fgetc(input)) != EOF && c != '\n') {}
            continue;
        }
        if (isspace((unsigned char)c)) continue;
        digit = hex_digit(c);
        CHECK(digit >= 0);
        if (high < 0) high = digit;
        else {
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

static int file_contains(const char *path, const char *marker)
{
    FILE *input = fopen(path, "rb");
    char buffer[4096] = {0};
    size_t used = 0;
    CHECK(input != NULL);
    used = fread(buffer, 1, sizeof(buffer) - 1, input);
    CHECK(!ferror(input) && fclose(input) == 0);
    buffer[used] = '\0';
    CHECK(strstr(buffer, marker) != NULL);
    return 0;
}

static int checks_snapshot_vectors(const char *root)
{
    static const struct { const char *name; scpefe_status expected; } invalid[] = {
        {"invalid/snapshot-unsupported-version.hex", SCPEFE_STATUS_UNSUPPORTED_FORMAT},
        {"invalid/snapshot-duplicate-key.hex", SCPEFE_STATUS_MALFORMED_CBOR},
        {"invalid/snapshot-invalid-utf8.hex", SCPEFE_STATUS_MALFORMED_CBOR},
        {"invalid/snapshot-trailing-data.hex", SCPEFE_STATUS_MALFORMED_CBOR},
    };
    char path[1024] = {0};
    byte_buffer valid = {0};
    scpefe_revision_limits_v1 limits = {0};
    scpefe_decoded_snapshot_revision *decoded = NULL;
    scpefe_snapshot_revision_v1 view = {0};
    uint8_t *reencoded = NULL;
    size_t reencoded_size = 0;
    char *diagnostic = NULL;
    size_t diagnostic_size = 0;
    size_t index = 0;

    limits.struct_size = sizeof(limits);
    CHECK(scpefe_revision_limits_default(&limits) == SCPEFE_STATUS_OK);
    CHECK(vector_path(path, sizeof(path), root, "valid/snapshot-revision.hex") == 0);
    CHECK(load_hex(path, &valid) == 0);
    CHECK(scpefe_snapshot_revision_decode(valid.data, valid.size, &limits, &decoded)
        == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    CHECK(scpefe_decoded_snapshot_revision_view(decoded, &view) == SCPEFE_STATUS_OK);
    CHECK(scpefe_snapshot_revision_encode(&view, &limits, NULL, 0, &reencoded_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    reencoded = (uint8_t *)malloc(reencoded_size);
    CHECK(reencoded != NULL);
    CHECK(scpefe_snapshot_revision_encode(
        &view, &limits, reencoded, reencoded_size, &reencoded_size
    ) == SCPEFE_STATUS_OK);
    CHECK(reencoded_size == valid.size && memcmp(reencoded, valid.data, valid.size) == 0);

    CHECK(scpefe_snapshot_revision_diagnostic_json(
        valid.data, valid.size, &limits, 0, NULL, 0, &diagnostic_size
    ) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    ++diagnostic_size; /* The query reports JSON octets, excluding the NUL. */
    diagnostic = (char *)malloc(diagnostic_size);
    CHECK(diagnostic != NULL);
    CHECK(scpefe_snapshot_revision_diagnostic_json(
        valid.data, valid.size, &limits, 0, diagnostic, diagnostic_size,
        &diagnostic_size
    ) == SCPEFE_STATUS_OK);
    CHECK(strstr(diagnostic, "\"content\":") == NULL);
    CHECK(strstr(diagnostic, "first line") == NULL);
    CHECK(strstr(diagnostic, "password") == NULL);
    CHECK(strstr(diagnostic, "document_key") == NULL);
    CHECK(strstr(diagnostic, "wrapping_key") == NULL);
    CHECK(strstr(diagnostic, "correct horse battery staple") == NULL);
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
    CHECK(strstr(diagnostic, "password") == NULL);
    CHECK(strstr(diagnostic, "document_key") == NULL);
    CHECK(strstr(diagnostic, "wrapping_key") == NULL);
    scpefe_decoded_snapshot_revision_destroy(decoded);
    free(diagnostic);
    free(reencoded);
    free(valid.data);

    for (index = 0; index < sizeof(invalid) / sizeof(invalid[0]); ++index) {
        byte_buffer bytes = {0};
        decoded = (scpefe_decoded_snapshot_revision *)(uintptr_t)1;
        CHECK(vector_path(path, sizeof(path), root, invalid[index].name) == 0);
        CHECK(load_hex(path, &bytes) == 0);
        CHECK(scpefe_snapshot_revision_decode(bytes.data, bytes.size, &limits, &decoded)
            == invalid[index].expected);
        CHECK(decoded == NULL);
        free(bytes.data);
    }
    return 0;
}

static int checks_container_vectors(const char *root)
{
    static const uint8_t password[] = "correct horse battery staple";
    static const struct { const char *name; scpefe_status expected; } invalid[] = {
        {"invalid/container-bad-magic.hex", SCPEFE_STATUS_MALFORMED_CONTAINER},
        {"invalid/container-corrupt-tag.hex", SCPEFE_STATUS_AUTHENTICATION_FAILED},
    };
    char path[1024] = {0};
    byte_buffer container = {0};
    byte_buffer snapshot = {0};
    scpefe_unlocked_container *unlocked = NULL;
    scpefe_unlocked_container_v1 view = {0};
    size_t index = 0;

    CHECK(vector_path(path, sizeof(path), root, "valid/password-container.hex") == 0);
    CHECK(load_hex(path, &container) == 0);
    CHECK(vector_path(path, sizeof(path), root, "valid/snapshot-revision.hex") == 0);
    CHECK(load_hex(path, &snapshot) == 0);
    CHECK(scpefe_password_container_unlock(
        container.data, container.size, password, sizeof(password) - 1, &unlocked
    ) == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    CHECK(scpefe_unlocked_container_view(unlocked, &view) == SCPEFE_STATUS_OK);
    CHECK(view.document_id_size == SCPEFE_DOCUMENT_ID_SIZE);
    CHECK(view.encoded_snapshot_revision_size == snapshot.size);
    CHECK(memcmp(view.encoded_snapshot_revision, snapshot.data, snapshot.size) == 0);
    scpefe_unlocked_container_destroy(unlocked);
    free(snapshot.data);
    free(container.data);

    for (index = 0; index < sizeof(invalid) / sizeof(invalid[0]); ++index) {
        byte_buffer bytes = {0};
        unlocked = (scpefe_unlocked_container *)(uintptr_t)1;
        CHECK(vector_path(path, sizeof(path), root, invalid[index].name) == 0);
        CHECK(load_hex(path, &bytes) == 0);
        CHECK(scpefe_password_container_unlock(
            bytes.data, bytes.size, password, sizeof(password) - 1, &unlocked
        ) == invalid[index].expected);
        CHECK(unlocked == NULL);
        free(bytes.data);
    }
    return 0;
}

static int checks_licensing_markers(const char *root)
{
    char path[1024] = {0};
    const char *cc0_files[] = {
        "docs/format/snapshot-revision-v1.cddl",
        "tests/vectors/draft-v1/README.md",
        "tests/vectors/draft-v1/valid/snapshot-revision.hex",
        "tests/vectors/draft-v1/valid/password-container.hex",
        "tests/vectors/draft-v1/invalid/snapshot-unsupported-version.hex",
        "tests/vectors/draft-v1/invalid/snapshot-duplicate-key.hex",
        "tests/vectors/draft-v1/invalid/snapshot-invalid-utf8.hex",
        "tests/vectors/draft-v1/invalid/snapshot-trailing-data.hex",
        "tests/vectors/draft-v1/invalid/container-bad-magic.hex",
        "tests/vectors/draft-v1/invalid/container-corrupt-tag.hex",
    };
    size_t index = 0;
    CHECK(snprintf(path, sizeof(path), "%s/docs/format/password-container-v1.md", root) > 0);
    CHECK(file_contains(path, "SPDX-License-Identifier: CC-BY-4.0") == 0);
    CHECK(snprintf(path, sizeof(path), "%s/docs/format/password-container-v2.md", root) > 0);
    CHECK(file_contains(path, "SPDX-License-Identifier: CC-BY-4.0") == 0);
    for (index = 0; index < sizeof(cc0_files) / sizeof(cc0_files[0]); ++index) {
        CHECK(snprintf(path, sizeof(path), "%s/%s", root, cc0_files[index]) > 0);
        CHECK(file_contains(path, "SPDX-License-Identifier: CC0-1.0") == 0);
    }
    return 0;
}

int main(int argc, char **argv)
{
    int result = 0;
    if (argc != 2) {
        fprintf(stderr, "usage: format_contract_test SOURCE_DIR\n");
        return 2;
    }
    result = checks_snapshot_vectors(argv[1]);
    if (result == 0) result = checks_container_vectors(argv[1]);
    if (result == 0) result = checks_licensing_markers(argv[1]);
    if (result != 0) fprintf(stderr, "format contract test failed at line %d\n", result);
    return result;
}
