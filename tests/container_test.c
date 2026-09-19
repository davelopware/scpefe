#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) \
    do { \
        if (!(condition)) return __LINE__; \
    } while (0)

static const uint8_t slot_id[SCPEFE_SLOT_ID_SIZE] = {
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
    0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
};

static const uint8_t content_hash[SCPEFE_CONTENT_HASH_SIZE] = {
    0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27,
    0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f,
    0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
    0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f,
};

static int contains_bytes(
    const uint8_t *haystack,
    size_t haystack_size,
    const uint8_t *needle,
    size_t needle_size
)
{
    size_t index = 0;
    if (needle_size == 0 || needle_size > haystack_size) return 0;
    for (index = 0; index <= haystack_size - needle_size; ++index) {
        if (memcmp(haystack + index, needle, needle_size) == 0) return 1;
    }
    return 0;
}

static int encode_snapshot(uint8_t **encoded, size_t *encoded_size)
{
    static const char identity[] = "Container Owner";
    static const char email[] = "owner@example.test";
    static const char device[] = "private-device";
    static const char content[] = "encrypted snapshot contents";
    scpefe_revision_limits_v1 limits = {0};
    const scpefe_snapshot_revision_v1 revision = {
        sizeof(scpefe_snapshot_revision_v1),
        SCPEFE_REVISION_FORMAT_VERSION,
        NULL,
        0,
        1726747200123u,
        slot_id,
        sizeof(slot_id),
        identity,
        sizeof(identity) - 1,
        email,
        sizeof(email) - 1,
        identity,
        sizeof(identity) - 1,
        email,
        sizeof(email) - 1,
        device,
        sizeof(device) - 1,
        content_hash,
        sizeof(content_hash),
        content,
        sizeof(content) - 1,
    };
    limits.struct_size = sizeof(limits);
    CHECK(scpefe_revision_limits_default(&limits) == SCPEFE_STATUS_OK);
    CHECK(scpefe_snapshot_revision_encode(
        &revision, &limits, NULL, 0, encoded_size
    ) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    *encoded = (uint8_t *)malloc(*encoded_size);
    CHECK(*encoded != NULL);
    CHECK(scpefe_snapshot_revision_encode(
        &revision, &limits, *encoded, *encoded_size, encoded_size
    ) == SCPEFE_STATUS_OK);
    return 0;
}

static int create_container(
    const uint8_t *password,
    size_t password_size,
    const uint8_t *snapshot,
    size_t snapshot_size,
    uint8_t **container,
    size_t *container_size
)
{
    CHECK(scpefe_password_container_create(
        password, password_size, snapshot, snapshot_size,
        NULL, 0, container_size
    ) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    *container = (uint8_t *)malloc(*container_size);
    CHECK(*container != NULL);
    CHECK(scpefe_password_container_create(
        password, password_size, snapshot, snapshot_size,
        *container, *container_size, container_size
    ) == SCPEFE_STATUS_OK);
    return 0;
}

static int creates_and_unlocks_private_container(void)
{
    static const uint8_t password[] = "owner passphrase has several words";
    static const uint8_t wrong_password[] = "entirely different passphrase";
    static const uint8_t plaintext[] = "encrypted snapshot contents";
    static const uint8_t identity[] = "Container Owner";
    uint8_t *snapshot = NULL;
    size_t snapshot_size = 0;
    uint8_t *first = NULL;
    size_t first_size = 0;
    uint8_t *second = NULL;
    size_t second_size = 0;
    scpefe_unlocked_container *unlocked = NULL;
    scpefe_unlocked_container_v1 view = {0};
    uint8_t first_document_id[SCPEFE_DOCUMENT_ID_SIZE] = {0};

    CHECK(encode_snapshot(&snapshot, &snapshot_size) == 0);
    CHECK(create_container(
        password, sizeof(password) - 1, snapshot, snapshot_size,
        &first, &first_size
    ) == 0);
    CHECK(create_container(
        password, sizeof(password) - 1, snapshot, snapshot_size,
        &second, &second_size
    ) == 0);
    CHECK(first_size == second_size);
    CHECK(memcmp(first, second, first_size) != 0);
    CHECK(memcmp(first + 32, second + 32, 16) != 0); /* Owner KDF salts. */
    CHECK(!contains_bytes(first, first_size, password, sizeof(password) - 1));
    CHECK(!contains_bytes(first, first_size, plaintext, sizeof(plaintext) - 1));
    CHECK(!contains_bytes(first, first_size, identity, sizeof(identity) - 1));

    CHECK(scpefe_password_container_unlock(
        first, first_size, password, sizeof(password) - 1, &unlocked
    ) == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    CHECK(scpefe_unlocked_container_view(unlocked, &view) == SCPEFE_STATUS_OK);
    CHECK(view.document_id_size == SCPEFE_DOCUMENT_ID_SIZE);
    CHECK(view.encoded_snapshot_revision_size == snapshot_size);
    CHECK(memcmp(view.encoded_snapshot_revision, snapshot, snapshot_size) == 0);
    memcpy(first_document_id, view.document_id, sizeof(first_document_id));
    scpefe_unlocked_container_destroy(unlocked);
    unlocked = NULL;

    CHECK(scpefe_password_container_unlock(
        second, second_size, password, sizeof(password) - 1, &unlocked
    ) == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    CHECK(scpefe_unlocked_container_view(unlocked, &view) == SCPEFE_STATUS_OK);
    CHECK(memcmp(view.document_id, first_document_id,
        sizeof(first_document_id)) != 0);
    scpefe_unlocked_container_destroy(unlocked);
    unlocked = NULL;

    CHECK(scpefe_password_container_unlock(
        first, first_size, password, sizeof(password) - 1, &unlocked
    ) == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    CHECK(scpefe_unlocked_container_view(unlocked, &view) == SCPEFE_STATUS_OK);
    CHECK(memcmp(view.document_id, first_document_id,
        sizeof(first_document_id)) == 0);
    scpefe_unlocked_container_destroy(unlocked);
    unlocked = NULL;

    CHECK(scpefe_password_container_unlock(
        first, first_size, wrong_password, sizeof(wrong_password) - 1, &unlocked
    ) == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    CHECK(unlocked == NULL);

    first[first_size - 1] ^= 0x01;
    CHECK(scpefe_password_container_unlock(
        first, first_size, password, sizeof(password) - 1, &unlocked
    ) == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    CHECK(unlocked == NULL);

    free(second);
    free(first);
    free(snapshot);
    return 0;
}

int main(void)
{
    const int result = creates_and_unlocks_private_container();
    if (result != 0) {
        fprintf(stderr, "container test failed at line %d\n", result);
    }
    return result;
}
