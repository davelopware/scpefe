#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)

static int opens_with(
    const uint8_t *container,
    size_t container_size,
    const char *password,
    uint8_t work_journal_key[SCPEFE_WORK_JOURNAL_KEY_SIZE]
)
{
    scpefe_unlocked_container *unlocked = NULL;
    scpefe_unlocked_container_v1 container_view = {0};
    scpefe_decoded_snapshot_revision *revision = NULL;
    scpefe_snapshot_revision_v1 revision_view = {0};
    scpefe_revision_limits_v1 limits = {0};
    CHECK(scpefe_password_container_unlock(
        container, container_size, (const uint8_t *)password, strlen(password),
        &unlocked
    ) == SCPEFE_STATUS_OK);
    container_view.struct_size = sizeof(container_view);
    CHECK(scpefe_unlocked_container_view(unlocked, &container_view)
        == SCPEFE_STATUS_OK);
    if (work_journal_key != NULL) {
        size_t key_size = 0;
        CHECK(scpefe_unlocked_container_work_journal_key(
            unlocked, NULL, 0, &key_size) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
        CHECK(key_size == SCPEFE_WORK_JOURNAL_KEY_SIZE);
        CHECK(scpefe_unlocked_container_work_journal_key(
            unlocked, work_journal_key, SCPEFE_WORK_JOURNAL_KEY_SIZE, &key_size)
            == SCPEFE_STATUS_OK);
    }
    limits.struct_size = sizeof(limits);
    CHECK(scpefe_revision_limits_default(&limits) == SCPEFE_STATUS_OK);
    CHECK(scpefe_snapshot_revision_decode(
        container_view.encoded_snapshot_revision,
        container_view.encoded_snapshot_revision_size, &limits, &revision
    ) == SCPEFE_STATUS_OK);
    revision_view.struct_size = sizeof(revision_view);
    CHECK(scpefe_decoded_snapshot_revision_view(revision, &revision_view)
        == SCPEFE_STATUS_OK);
    CHECK(revision_view.parent_count == 0);
    CHECK(revision_view.timestamp_ms == 1726747200123u);
    CHECK(revision_view.slot_id_size == SCPEFE_SLOT_ID_SIZE);
    CHECK(revision_view.slot_identity_name_size == strlen("Ada Lovelace"));
    CHECK(memcmp(revision_view.slot_identity_name, "Ada Lovelace",
        strlen("Ada Lovelace")) == 0);
    CHECK(revision_view.client_profile_email_size == strlen("ada@example.test"));
    CHECK(memcmp(revision_view.client_profile_email, "ada@example.test",
        strlen("ada@example.test")) == 0);
    CHECK(revision_view.device_name_size == strlen("Ada's PC"));
    CHECK(revision_view.content_size == strlen("initial text\n"));
    CHECK(memcmp(revision_view.content, "initial text\n",
        strlen("initial text\n")) == 0);
    scpefe_decoded_snapshot_revision_destroy(revision);
    scpefe_unlocked_container_destroy(unlocked);
    return 0;
}

int main(void)
{
    static const uint8_t five_e_acute[] = {
        0xc3, 0xa9, 0xc3, 0xa9, 0xc3, 0xa9, 0xc3, 0xa9, 0xc3, 0xa9
    };
    static const uint8_t six_e_acute[] = {
        0xc3, 0xa9, 0xc3, 0xa9, 0xc3, 0xa9, 0xc3, 0xa9, 0xc3, 0xa9, 0xc3, 0xa9
    };
    static const char owner[] = "owner passphrase with independent words";
    static const char recovery[] = "offline recovery passphrase is different";
    const scpefe_new_document_v1 document = {
        sizeof(scpefe_new_document_v1),
        "Ada Lovelace", strlen("Ada Lovelace"),
        "ada@example.test", strlen("ada@example.test"),
        "Ada's PC", strlen("Ada's PC"),
        "initial text\n", strlen("initial text\n"),
        1726747200123u,
        (const uint8_t *)owner, sizeof(owner) - 1,
        (const uint8_t *)recovery, sizeof(recovery) - 1,
    };
    scpefe_new_document_v1 invalid = document;
    uint8_t *container = NULL;
    size_t container_size = 0;
    scpefe_unlocked_container *unlocked = NULL;
    uint8_t owner_journal_key[SCPEFE_WORK_JOURNAL_KEY_SIZE];
    uint8_t recovery_journal_key[SCPEFE_WORK_JOURNAL_KEY_SIZE];

    CHECK(scpefe_password_meets_policy((const uint8_t *)owner, sizeof(owner) - 1));
    CHECK(!scpefe_password_meets_policy((const uint8_t *)"passwordpassword", 16));
    CHECK(!scpefe_password_meets_policy((const uint8_t *)"short", 5));
    CHECK(scpefe_assess_password_policy((const uint8_t *)"short", 5)
        == SCPEFE_PASSWORD_POLICY_MINIMUM_LENGTH);
    CHECK(scpefe_assess_password_policy(five_e_acute, sizeof(five_e_acute))
        == SCPEFE_PASSWORD_POLICY_MINIMUM_LENGTH);
    CHECK(scpefe_assess_password_policy(six_e_acute, sizeof(six_e_acute))
        == SCPEFE_PASSWORD_POLICY_PREDICTABLE);
    CHECK(scpefe_assess_password_policy(NULL, 0)
        == SCPEFE_PASSWORD_POLICY_INVALID);
    CHECK(scpefe_password_meets_policy(
        (const uint8_t *)"550e8400-e29b-41d4-a716-446655440000", 36));
    CHECK(scpefe_password_meets_policy(
        (const uint8_t *)"550E8400-E29B-41D4-A716-446655440000", 36));
    CHECK(!scpefe_password_meets_policy(
        (const uint8_t *)"00000000-0000-1000-8000-000000000000", 36));

    CHECK(scpefe_new_document_create(&document, NULL, 0, &container_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    CHECK(container_size > 0);
    container = (uint8_t *)malloc(container_size);
    CHECK(container != NULL);
    CHECK(scpefe_new_document_create(
        &document, container, container_size, &container_size
    ) == SCPEFE_STATUS_OK);
    CHECK(opens_with(container, container_size, owner, owner_journal_key) == 0);
    CHECK(opens_with(container, container_size, recovery, recovery_journal_key) == 0);
    CHECK(memcmp(owner_journal_key, recovery_journal_key,
        sizeof(owner_journal_key)) == 0);
    container[7] = 2; /* Version-2 magic with a version-3 integer is invalid. */
    unlocked = (scpefe_unlocked_container *)(uintptr_t)1;
    CHECK(scpefe_password_container_unlock(
        container, container_size, (const uint8_t *)owner, sizeof(owner) - 1,
        &unlocked
    ) == SCPEFE_STATUS_MALFORMED_CONTAINER);
    CHECK(unlocked == NULL);
    container[7] = 3;
    container[8] = 2; /* Version-3 magic with a version-2 integer is invalid. */
    unlocked = (scpefe_unlocked_container *)(uintptr_t)1;
    CHECK(scpefe_password_container_unlock(
        container, container_size, (const uint8_t *)owner, sizeof(owner) - 1,
        &unlocked
    ) == SCPEFE_STATUS_MALFORMED_CONTAINER);
    CHECK(unlocked == NULL);
    container[8] = 3;
    CHECK(scpefe_password_container_unlock(
        container, container_size, (const uint8_t *)"wrong password", 14,
        &unlocked
    ) == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    CHECK(unlocked == NULL);

    invalid.profile_name_size = 0;
    CHECK(scpefe_new_document_create(&invalid, NULL, 0, &container_size)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    invalid = document;
    invalid.owner_password = (const uint8_t *)"short";
    invalid.owner_password_size = 5;
    CHECK(scpefe_new_document_create(&invalid, NULL, 0, &container_size)
        == SCPEFE_STATUS_WEAK_PASSWORD);
    invalid = document;
    invalid.owner_password = (const uint8_t *)"passwordpassword";
    invalid.owner_password_size = 16;
    CHECK(scpefe_new_document_create(&invalid, NULL, 0, &container_size)
        == SCPEFE_STATUS_WEAK_PASSWORD);
    invalid = document;
    invalid.recovery_password = invalid.owner_password;
    invalid.recovery_password_size = invalid.owner_password_size;
    CHECK(scpefe_new_document_create(&invalid, NULL, 0, &container_size)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    invalid = document;
    invalid.recovery_password = NULL;
    invalid.recovery_password_size = 0;
    CHECK(scpefe_new_document_create(&invalid, NULL, 0, &container_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    container = (uint8_t *)realloc(container, container_size);
    CHECK(container != NULL);
    CHECK(scpefe_new_document_create(
        &invalid, container, container_size, &container_size
    ) == SCPEFE_STATUS_OK);
    CHECK(opens_with(container, container_size, owner, NULL) == 0);
    free(container);
    return 0;
}
