#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) \
    do { \
        if (!(condition)) { \
            return __LINE__; \
        } \
    } while (0)

static const uint8_t slot_id[16] = {
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
    0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
};

static const uint8_t content_hash[32] = {
    0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27,
    0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f,
    0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
    0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f,
};

static scpefe_snapshot_revision_v1 example_revision(void)
{
    const scpefe_snapshot_revision_v1 revision = {
        sizeof(scpefe_snapshot_revision_v1),
        SCPEFE_REVISION_FORMAT_VERSION,
        NULL,
        0,
        1726747200123u,
        slot_id,
        sizeof(slot_id),
        "Ada Lovelace",
        strlen("Ada Lovelace"),
        "ada@example.test",
        strlen("ada@example.test"),
        "Augusta Ada King",
        strlen("Augusta Ada King"),
        "ada@client.test",
        strlen("ada@client.test"),
        "workstation",
        strlen("workstation"),
        content_hash,
        sizeof(content_hash),
        "first line\nsecond line",
        strlen("first line\nsecond line"),
    };
    return revision;
}

static int encode_example(
    scpefe_revision_limits_v1 *limits,
    uint8_t **encoded,
    size_t *encoded_size
)
{
    const scpefe_snapshot_revision_v1 source = example_revision();
    limits->struct_size = sizeof(*limits);
    CHECK(scpefe_revision_limits_default(limits) == SCPEFE_STATUS_OK);
    CHECK(scpefe_snapshot_revision_encode(
        &source, limits, NULL, 0, encoded_size
    ) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    *encoded = (uint8_t *)malloc(*encoded_size);
    CHECK(*encoded != NULL);
    CHECK(scpefe_snapshot_revision_encode(
        &source, limits, *encoded, *encoded_size, encoded_size
    ) == SCPEFE_STATUS_OK);
    return 0;
}

static int round_trips_snapshot_revision(void)
{
    const scpefe_snapshot_revision_v1 source = example_revision();
    scpefe_revision_limits_v1 limits = {0};
    size_t encoded_size = 0;
    uint8_t *encoded = NULL;
    scpefe_decoded_snapshot_revision *decoded = NULL;
    scpefe_snapshot_revision_v1 view = {0};
    size_t reencoded_size = 0;
    uint8_t *reencoded = NULL;

    limits.struct_size = sizeof(limits);
    CHECK(scpefe_revision_limits_default(&limits) == SCPEFE_STATUS_OK);
    CHECK(scpefe_snapshot_revision_encode(
        &source, &limits, NULL, 0, &encoded_size
    ) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    CHECK(encoded_size > 0);
    encoded = (uint8_t *)malloc(encoded_size);
    CHECK(encoded != NULL);
    CHECK(scpefe_snapshot_revision_encode(
        &source, &limits, encoded, encoded_size, &encoded_size
    ) == SCPEFE_STATUS_OK);

    CHECK(scpefe_snapshot_revision_decode(
        encoded, encoded_size, &limits, &decoded
    ) == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    CHECK(scpefe_decoded_snapshot_revision_view(decoded, &view)
        == SCPEFE_STATUS_OK);
    CHECK(view.format_version == SCPEFE_REVISION_FORMAT_VERSION);
    CHECK(view.parent_count == 0);
    CHECK(view.timestamp_ms == source.timestamp_ms);
    CHECK(view.slot_id_size == sizeof(slot_id));
    CHECK(memcmp(view.slot_id, slot_id, sizeof(slot_id)) == 0);
    CHECK(view.slot_identity_name_size == source.slot_identity_name_size);
    CHECK(memcmp(view.slot_identity_name, source.slot_identity_name,
        source.slot_identity_name_size) == 0);
    CHECK(view.slot_identity_email_size == source.slot_identity_email_size);
    CHECK(memcmp(view.slot_identity_email, source.slot_identity_email,
        source.slot_identity_email_size) == 0);
    CHECK(view.client_profile_name_size == source.client_profile_name_size);
    CHECK(memcmp(view.client_profile_name, source.client_profile_name,
        source.client_profile_name_size) == 0);
    CHECK(view.client_profile_email_size == source.client_profile_email_size);
    CHECK(memcmp(view.client_profile_email, source.client_profile_email,
        source.client_profile_email_size) == 0);
    CHECK(view.device_name_size == source.device_name_size);
    CHECK(memcmp(view.device_name, source.device_name, source.device_name_size) == 0);
    CHECK(view.content_hash_size == sizeof(content_hash));
    CHECK(memcmp(view.content_hash, content_hash, sizeof(content_hash)) == 0);
    CHECK(view.content_size == source.content_size);
    CHECK(memcmp(view.content, source.content, source.content_size) == 0);

    CHECK(scpefe_snapshot_revision_encode(
        &view, &limits, NULL, 0, &reencoded_size
    ) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    reencoded = (uint8_t *)malloc(reencoded_size);
    CHECK(reencoded != NULL);
    CHECK(scpefe_snapshot_revision_encode(
        &view, &limits, reencoded, reencoded_size, &reencoded_size
    ) == SCPEFE_STATUS_OK);
    CHECK(reencoded_size == encoded_size);
    CHECK(memcmp(reencoded, encoded, encoded_size) == 0);

    free(reencoded);
    scpefe_decoded_snapshot_revision_destroy(decoded);
    free(encoded);
    return 0;
}

static int rejects_malformed_records_and_limit_violations(void)
{
    scpefe_revision_limits_v1 limits = {0};
    uint8_t *valid = NULL;
    size_t valid_size = 0;
    scpefe_decoded_snapshot_revision *decoded = NULL;
    uint8_t *mutated = NULL;
    size_t index = 0;

    CHECK(encode_example(&limits, &valid, &valid_size) == 0);
    mutated = (uint8_t *)malloc(valid_size);
    CHECK(mutated != NULL);

    memcpy(mutated, valid, valid_size);
    mutated[0] = 0xbf; /* Indefinite-length map. */
    CHECK(scpefe_snapshot_revision_decode(
        mutated, valid_size, &limits, &decoded
    ) == SCPEFE_STATUS_MALFORMED_CBOR);

    memcpy(mutated, valid, valid_size);
    for (index = 0; index + strlen("first line") <= valid_size; ++index) {
        if (memcmp(mutated + index, "first line", strlen("first line")) == 0) {
            mutated[index] = '\r'; /* Canonical text uses LF, never CR. */
            break;
        }
    }
    CHECK(index + strlen("first line") <= valid_size);
    CHECK(scpefe_snapshot_revision_decode(
        mutated, valid_size, &limits, &decoded
    ) == SCPEFE_STATUS_MALFORMED_CBOR);

    memcpy(mutated, valid, valid_size);
    for (index = 0; index + strlen("first line") <= valid_size; ++index) {
        if (memcmp(mutated + index, "first line", strlen("first line")) == 0) {
            mutated[index] = 0xef;
            mutated[index + 1] = 0xbb;
            mutated[index + 2] = 0xbf; /* Canonical text has no UTF-8 BOM. */
            break;
        }
    }
    CHECK(index + strlen("first line") <= valid_size);
    CHECK(scpefe_snapshot_revision_decode(
        mutated, valid_size, &limits, &decoded
    ) == SCPEFE_STATUS_MALFORMED_CBOR);

    memcpy(mutated, valid, valid_size);
    mutated[3] = 1; /* Second map key duplicates the first key. */
    CHECK(scpefe_snapshot_revision_decode(
        mutated, valid_size, &limits, &decoded
    ) == SCPEFE_STATUS_MALFORMED_CBOR);

    memcpy(mutated, valid, valid_size);
    mutated[2] = 0xfa; /* Floating-point version value. */
    CHECK(scpefe_snapshot_revision_decode(
        mutated, valid_size, &limits, &decoded
    ) == SCPEFE_STATUS_MALFORMED_CBOR);

    memcpy(mutated, valid, valid_size);
    for (index = 0; index + strlen("Ada Lovelace") <= valid_size; ++index) {
        if (memcmp(mutated + index, "Ada Lovelace", strlen("Ada Lovelace")) == 0) {
            mutated[index] = 0xff; /* Invalid UTF-8 leading byte. */
            break;
        }
    }
    CHECK(index + strlen("Ada Lovelace") <= valid_size);
    CHECK(scpefe_snapshot_revision_decode(
        mutated, valid_size, &limits, &decoded
    ) == SCPEFE_STATUS_MALFORMED_CBOR);

    limits.max_input_bytes = valid_size - 1;
    CHECK(scpefe_snapshot_revision_decode(
        valid, valid_size, &limits, &decoded
    ) == SCPEFE_STATUS_LIMIT_EXCEEDED);

    limits.struct_size = sizeof(limits);
    CHECK(scpefe_revision_limits_default(&limits) == SCPEFE_STATUS_OK);
    limits.max_nesting_depth = 1;
    CHECK(scpefe_snapshot_revision_decode(
        valid, valid_size, &limits, &decoded
    ) == SCPEFE_STATUS_LIMIT_EXCEEDED);

    limits.struct_size = sizeof(limits);
    CHECK(scpefe_revision_limits_default(&limits) == SCPEFE_STATUS_OK);
    limits.max_collection_entries = 10;
    CHECK(scpefe_snapshot_revision_decode(
        valid, valid_size, &limits, &decoded
    ) == SCPEFE_STATUS_LIMIT_EXCEEDED);

    limits.struct_size = sizeof(limits);
    CHECK(scpefe_revision_limits_default(&limits) == SCPEFE_STATUS_OK);
    limits.max_text_bytes = 10;
    CHECK(scpefe_snapshot_revision_decode(
        valid, valid_size, &limits, &decoded
    ) == SCPEFE_STATUS_LIMIT_EXCEEDED);

    limits.struct_size = sizeof(limits);
    CHECK(scpefe_revision_limits_default(&limits) == SCPEFE_STATUS_OK);
    limits.max_byte_string_bytes = 31;
    CHECK(scpefe_snapshot_revision_decode(
        valid, valid_size, &limits, &decoded
    ) == SCPEFE_STATUS_LIMIT_EXCEEDED);

    free(mutated);
    free(valid);
    return 0;
}

static int emits_readable_diagnostic_json(void)
{
    scpefe_revision_limits_v1 limits = {0};
    uint8_t *encoded = NULL;
    size_t encoded_size = 0;
    size_t json_size = 0;
    char *json = NULL;

    CHECK(encode_example(&limits, &encoded, &encoded_size) == 0);
    CHECK(scpefe_snapshot_revision_diagnostic_json(
        encoded, encoded_size, &limits, 0, NULL, 0, &json_size
    ) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    json = (char *)malloc(json_size + 1);
    CHECK(json != NULL);
    CHECK(scpefe_snapshot_revision_diagnostic_json(
        encoded, encoded_size, &limits, 0, json, json_size + 1, &json_size
    ) == SCPEFE_STATUS_OK);
    CHECK(strstr(json, "\"format_version\":1") != NULL);
    CHECK(strstr(json, "\"slot_identity_name\":\"Ada Lovelace\"") != NULL);
    CHECK(strstr(json, "\"client_profile_name\":\"Augusta Ada King\"") != NULL);
    CHECK(strstr(json, "\"codec\":\"none\"") != NULL);
    CHECK(strstr(json, "\"content\":") == NULL);

    free(json);
    json = NULL;
    CHECK(scpefe_snapshot_revision_diagnostic_json(
        encoded, encoded_size, &limits, 1, NULL, 0, &json_size
    ) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    json = (char *)malloc(json_size + 1);
    CHECK(json != NULL);
    CHECK(scpefe_snapshot_revision_diagnostic_json(
        encoded, encoded_size, &limits, 1, json, json_size + 1, &json_size
    ) == SCPEFE_STATUS_OK);
    CHECK(strstr(json, "\"content\":\"first line\\nsecond line\"") != NULL);

    free(json);
    free(encoded);
    return 0;
}

static int write_example_record(const char *path)
{
    scpefe_revision_limits_v1 limits = {0};
    uint8_t *encoded = NULL;
    size_t encoded_size = 0;
    FILE *output = NULL;

    CHECK(encode_example(&limits, &encoded, &encoded_size) == 0);
    output = fopen(path, "wb");
    CHECK(output != NULL);
    CHECK(fwrite(encoded, 1, encoded_size, output) == encoded_size);
    CHECK(fclose(output) == 0);
    free(encoded);
    return 0;
}

int main(int argc, char **argv)
{
    int result = round_trips_snapshot_revision();
    if (result != 0) return result;
    result = rejects_malformed_records_and_limit_violations();
    if (result != 0) return result;
    result = emits_readable_diagnostic_json();
    if (result != 0) return result;
    if (argc == 2) return write_example_record(argv[1]);
    return argc == 1 ? 0 : __LINE__;
}
