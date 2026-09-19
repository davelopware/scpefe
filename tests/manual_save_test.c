#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)

static int inspect_saved(
    const uint8_t *container, size_t container_size, const char *password,
    const uint8_t expected_document_id[SCPEFE_DOCUMENT_ID_SIZE],
    const uint8_t expected_slot_id[SCPEFE_SLOT_ID_SIZE], int expect_owner_slot)
{
    scpefe_unlocked_container *unlocked = NULL;
    scpefe_unlocked_container_v1 unlocked_view = {0};
    scpefe_unlocked_slot_access_v1 slot_access = {0};
    scpefe_decoded_snapshot_revision *revision = NULL;
    scpefe_snapshot_revision_v1 revision_view = {0};
    scpefe_revision_limits_v1 limits = {0};
    CHECK(scpefe_password_container_unlock(container, container_size,
        (const uint8_t *)password, strlen(password), &unlocked) == SCPEFE_STATUS_OK);
    unlocked_view.struct_size = sizeof(unlocked_view);
    CHECK(scpefe_unlocked_container_view(unlocked, &unlocked_view)
        == SCPEFE_STATUS_OK);
    slot_access.struct_size = sizeof(slot_access);
    CHECK(scpefe_unlocked_container_slot_access(unlocked, &slot_access)
        == SCPEFE_STATUS_OK);
    CHECK(slot_access.can_edit == 1);
    CHECK(memcmp(unlocked_view.document_id, expected_document_id,
        SCPEFE_DOCUMENT_ID_SIZE) == 0);
    if (expect_owner_slot) {
        CHECK(memcmp(slot_access.slot_id, expected_slot_id,
            SCPEFE_SLOT_ID_SIZE) == 0);
    }
    limits.struct_size = sizeof(limits);
    CHECK(scpefe_revision_limits_default(&limits) == SCPEFE_STATUS_OK);
    CHECK(scpefe_snapshot_revision_decode(unlocked_view.encoded_snapshot_revision,
        unlocked_view.encoded_snapshot_revision_size, &limits, &revision)
        == SCPEFE_STATUS_OK);
    revision_view.struct_size = sizeof(revision_view);
    CHECK(scpefe_decoded_snapshot_revision_view(revision, &revision_view)
        == SCPEFE_STATUS_OK);
    CHECK(revision_view.parent_count == 1);
    CHECK(revision_view.timestamp_ms == 1726747300456u);
    CHECK(revision_view.content_size == strlen(" first \nsecond\n"));
    CHECK(memcmp(revision_view.content, " first \nsecond\n",
        revision_view.content_size) == 0);
    CHECK(revision_view.client_profile_name_size == strlen("Grace Hopper"));
    CHECK(memcmp(revision_view.client_profile_name, "Grace Hopper",
        revision_view.client_profile_name_size) == 0);
    CHECK(revision_view.client_profile_email_size == strlen("grace@example.test"));
    CHECK(revision_view.device_name_size == strlen("Grace's PC"));
    if (expect_owner_slot) {
        CHECK(memcmp(revision_view.slot_id, expected_slot_id,
            SCPEFE_SLOT_ID_SIZE) == 0);
    }
    scpefe_decoded_snapshot_revision_destroy(revision);
    scpefe_unlocked_container_destroy(unlocked);
    return 0;
}

int main(void)
{
    static const char owner[] = "owner passphrase with independent words";
    static const char recovery[] = "offline recovery passphrase is different";
    const scpefe_new_document_v1 document = {
        sizeof(scpefe_new_document_v1),
        "Ada Lovelace", strlen("Ada Lovelace"),
        "ada@example.test", strlen("ada@example.test"),
        "Ada's PC", strlen("Ada's PC"),
        "initial text", strlen("initial text"), 1726747200123u,
        (const uint8_t *)owner, sizeof(owner) - 1,
        (const uint8_t *)recovery, sizeof(recovery) - 1,
    };
    uint8_t *container = NULL;
    size_t container_size = 0;
    scpefe_unlocked_container *unlocked = NULL;
    scpefe_unlocked_container_v1 view = {0};
    scpefe_unlocked_slot_access_v1 slot_access = {0};
    uint8_t document_id[SCPEFE_DOCUMENT_ID_SIZE];
    uint8_t slot_id[SCPEFE_SLOT_ID_SIZE];
    CHECK(scpefe_new_document_create(&document, NULL, 0, &container_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    container = (uint8_t *)malloc(container_size);
    CHECK(container != NULL);
    CHECK(scpefe_new_document_create(&document, container, container_size,
        &container_size) == SCPEFE_STATUS_OK);
    CHECK(scpefe_password_container_unlock(container, container_size,
        (const uint8_t *)owner, sizeof(owner) - 1, &unlocked) == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    CHECK(scpefe_unlocked_container_view(unlocked, &view) == SCPEFE_STATUS_OK);
    slot_access.struct_size = sizeof(slot_access);
    CHECK(scpefe_unlocked_container_slot_access(unlocked, &slot_access)
        == SCPEFE_STATUS_OK);
    CHECK(slot_access.can_edit == 1 && slot_access.recovery_slot == 0);
    memcpy(document_id, view.document_id, sizeof(document_id));
    memcpy(slot_id, slot_access.slot_id, sizeof(slot_id));
    scpefe_unlocked_container_destroy(unlocked);

    const scpefe_manual_save_v1 save = {
        sizeof(scpefe_manual_save_v1), container, container_size,
        (const uint8_t *)owner, sizeof(owner) - 1,
        "Grace Hopper", strlen("Grace Hopper"),
        "grace@example.test", strlen("grace@example.test"),
        "Grace's PC", strlen("Grace's PC"),
        " first \nsecond\n", strlen(" first \nsecond\n"), 1726747300456u,
    };
    size_t saved_size = 0;
    CHECK(scpefe_manual_save(&save, NULL, 0, &saved_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *saved = (uint8_t *)malloc(saved_size);
    CHECK(saved != NULL);
    CHECK(scpefe_manual_save(&save, saved, saved_size, &saved_size)
        == SCPEFE_STATUS_OK);
    CHECK(inspect_saved(saved, saved_size, owner, document_id, slot_id, 1) == 0);
    CHECK(inspect_saved(saved, saved_size, recovery, document_id, slot_id, 0) == 0);

    free(saved);
    free(container);
    return 0;
}
