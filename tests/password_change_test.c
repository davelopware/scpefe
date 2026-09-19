#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)

static uint32_t read_u32(const uint8_t *bytes)
{
    return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8)
        | ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
}

static int contains_bytes(
    const uint8_t *haystack, size_t haystack_size,
    const char *needle
)
{
    const size_t needle_size = strlen(needle);
    size_t index;
    if (needle_size > haystack_size) return 0;
    for (index = 0; index <= haystack_size - needle_size; ++index) {
        if (memcmp(haystack + index, needle, needle_size) == 0) return 1;
    }
    return 0;
}

static int unlock_values(
    const uint8_t *container, size_t container_size, const char *password,
    uint8_t document_id[SCPEFE_DOCUMENT_ID_SIZE],
    uint8_t slot_id[SCPEFE_SLOT_ID_SIZE],
    uint8_t **revision, size_t *revision_size, int expected_recovery
)
{
    scpefe_unlocked_container *unlocked = NULL;
    scpefe_unlocked_container_v1 view = {0};
    scpefe_unlocked_slot_access_v1 access = {0};
    CHECK(scpefe_password_container_unlock(
        container, container_size, (const uint8_t *)password, strlen(password),
        &unlocked) == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    CHECK(scpefe_unlocked_container_view(unlocked, &view) == SCPEFE_STATUS_OK);
    access.struct_size = sizeof(access);
    CHECK(scpefe_unlocked_container_slot_access(unlocked, &access)
        == SCPEFE_STATUS_OK);
    CHECK(access.recovery_slot == expected_recovery);
    memcpy(document_id, view.document_id, SCPEFE_DOCUMENT_ID_SIZE);
    memcpy(slot_id, access.slot_id, SCPEFE_SLOT_ID_SIZE);
    *revision = (uint8_t *)malloc(view.encoded_snapshot_revision_size);
    CHECK(*revision != NULL);
    memcpy(*revision, view.encoded_snapshot_revision,
        view.encoded_snapshot_revision_size);
    *revision_size = view.encoded_snapshot_revision_size;
    scpefe_unlocked_container_destroy(unlocked);
    return 0;
}

static int rejects_password(
    const uint8_t *container, size_t container_size, const char *password
)
{
    scpefe_unlocked_container *unlocked = (scpefe_unlocked_container *)(uintptr_t)1;
    CHECK(scpefe_password_container_unlock(
        container, container_size, (const uint8_t *)password, strlen(password),
        &unlocked) == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    CHECK(unlocked == NULL);
    return 0;
}

static int rejects_weak_change_without_output(
    const uint8_t *container, size_t container_size,
    const char *current_password, const char *weak_password,
    uint8_t *output
)
{
    size_t output_size = 777;
    memset(output, 0xa5, container_size);
    CHECK(scpefe_password_container_change_password(
        container, container_size,
        (const uint8_t *)current_password, strlen(current_password),
        (const uint8_t *)weak_password, strlen(weak_password), output,
        container_size, &output_size) == SCPEFE_STATUS_WEAK_PASSWORD);
    CHECK(output_size == 777);
    CHECK(output[0] == 0xa5 && output[container_size / 2] == 0xa5
        && output[container_size - 1] == 0xa5);
    return 0;
}

int main(void)
{
    static const char owner[] = "owner passphrase with independent words";
    static const char owner_new[] = "new owner passphrase with safer words";
    static const char recovery[] = "offline recovery passphrase is different";
    static const char recovery_new[] = "new recovery passphrase stored far offline";
    static const char wrong[] = "wrong but sufficiently lengthy passphrase";
    const scpefe_new_document_v1 document = {
        sizeof(scpefe_new_document_v1),
        "Ada Lovelace", strlen("Ada Lovelace"),
        "ada@example.test", strlen("ada@example.test"),
        "Ada's PC", strlen("Ada's PC"),
        "unchanged content and history\n", strlen("unchanged content and history\n"),
        1726747200123u,
        (const uint8_t *)owner, sizeof(owner) - 1,
        (const uint8_t *)recovery, sizeof(recovery) - 1,
    };
    size_t container_size = 0;
    CHECK(scpefe_new_document_create(&document, NULL, 0, &container_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *container = (uint8_t *)malloc(container_size);
    uint8_t *owner_changed = (uint8_t *)malloc(container_size);
    uint8_t *recovery_changed = (uint8_t *)malloc(container_size);
    CHECK(container != NULL && owner_changed != NULL && recovery_changed != NULL);
    CHECK(scpefe_new_document_create(
        &document, container, container_size, &container_size) == SCPEFE_STATUS_OK);
    CHECK(read_u32(container + 32) == 2);
    const size_t snapshot_offset = 160 + 2 * 65;

    uint8_t document_id[SCPEFE_DOCUMENT_ID_SIZE];
    uint8_t owner_slot_id[SCPEFE_SLOT_ID_SIZE];
    uint8_t recovery_slot_id[SCPEFE_SLOT_ID_SIZE];
    uint8_t ignored_document_id[SCPEFE_DOCUMENT_ID_SIZE];
    uint8_t *revision = NULL;
    uint8_t *ignored_revision = NULL;
    size_t revision_size = 0;
    size_t ignored_revision_size = 0;
    CHECK(unlock_values(container, container_size, owner, document_id,
        owner_slot_id, &revision, &revision_size, 0) == 0);
    CHECK(unlock_values(container, container_size, recovery, ignored_document_id,
        recovery_slot_id, &ignored_revision, &ignored_revision_size, 1) == 0);
    CHECK(memcmp(document_id, ignored_document_id, sizeof(document_id)) == 0);
    CHECK(revision_size == ignored_revision_size);
    CHECK(memcmp(revision, ignored_revision, revision_size) == 0);
    free(ignored_revision);

    size_t changed_size = 0;
    CHECK(scpefe_password_container_change_password(
        container, container_size, (const uint8_t *)owner, strlen(owner),
        (const uint8_t *)owner_new, strlen(owner_new), owner_changed,
        container_size, &changed_size) == SCPEFE_STATUS_OK);
    CHECK(changed_size == container_size);
    CHECK(memcmp(container + snapshot_offset, owner_changed + snapshot_offset,
        container_size - snapshot_offset) == 0);
    CHECK(memcmp(container + 160 + 65, owner_changed + 160 + 65, 65) == 0);
    CHECK(memcmp(container + 160, owner_changed + 160, 65) != 0);
    CHECK(!contains_bytes(owner_changed, changed_size, owner));
    CHECK(!contains_bytes(owner_changed, changed_size, owner_new));
    CHECK(rejects_password(owner_changed, changed_size, owner) == 0);

    uint8_t changed_document_id[SCPEFE_DOCUMENT_ID_SIZE];
    uint8_t changed_slot_id[SCPEFE_SLOT_ID_SIZE];
    uint8_t *changed_revision = NULL;
    size_t changed_revision_size = 0;
    CHECK(unlock_values(owner_changed, changed_size, owner_new,
        changed_document_id, changed_slot_id, &changed_revision,
        &changed_revision_size, 0) == 0);
    CHECK(memcmp(document_id, changed_document_id, sizeof(document_id)) == 0);
    CHECK(memcmp(owner_slot_id, changed_slot_id, sizeof(owner_slot_id)) == 0);
    CHECK(revision_size == changed_revision_size);
    CHECK(memcmp(revision, changed_revision, revision_size) == 0);
    free(changed_revision);
    CHECK(unlock_values(owner_changed, changed_size, recovery,
        ignored_document_id, changed_slot_id, &ignored_revision,
        &ignored_revision_size, 1) == 0);
    CHECK(memcmp(recovery_slot_id, changed_slot_id, sizeof(recovery_slot_id)) == 0);
    free(ignored_revision);

    CHECK(rejects_weak_change_without_output(owner_changed, container_size,
        owner_new, "short", recovery_changed) == 0);
    CHECK(rejects_weak_change_without_output(owner_changed, container_size,
        owner_new, "abcdefghijkl", recovery_changed) == 0);
    CHECK(rejects_weak_change_without_output(owner_changed, container_size,
        owner_new, "1234567890123456", recovery_changed) == 0);
    CHECK(rejects_weak_change_without_output(owner_changed, container_size,
        owner_new, "abcdefghijklm", recovery_changed) == 0);
    CHECK(rejects_weak_change_without_output(owner_changed, container_size,
        owner_new, "ABCDEFGHIJKL", recovery_changed) == 0);
    CHECK(rejects_weak_change_without_output(owner_changed, container_size,
        owner_new, "password123456", recovery_changed) == 0);
    CHECK(rejects_weak_change_without_output(owner_changed, container_size,
        owner_new, "qwertyuiopasdf", recovery_changed) == 0);
    CHECK(rejects_weak_change_without_output(owner_changed, container_size,
        owner_new, "abcabcabcabc", recovery_changed) == 0);
    CHECK(rejects_weak_change_without_output(owner_changed, container_size,
        owner_new, "orange orange orange orange orange", recovery_changed) == 0);
    CHECK(rejects_weak_change_without_output(owner_changed, container_size,
        owner_new, "aaaaaaaaaaaaabbbbbbbbbbbbb", recovery_changed) == 0);
    CHECK(rejects_weak_change_without_output(owner_changed, container_size,
        owner_new, "11111111111111222222222222", recovery_changed) == 0);
    CHECK(scpefe_password_container_change_password(
        owner_changed, container_size,
        (const uint8_t *)owner_new, strlen(owner_new),
        (const uint8_t *)recovery, strlen(recovery), recovery_changed,
        container_size, &changed_size) == SCPEFE_STATUS_PASSWORD_ALREADY_IN_USE);
    CHECK(scpefe_password_container_change_password(
        owner_changed, container_size,
        (const uint8_t *)wrong, strlen(wrong),
        (const uint8_t *)recovery_new, strlen(recovery_new), recovery_changed,
        container_size, &changed_size) == SCPEFE_STATUS_AUTHENTICATION_FAILED);

    CHECK(scpefe_password_container_change_password(
        owner_changed, container_size,
        (const uint8_t *)recovery, strlen(recovery),
        (const uint8_t *)recovery_new, strlen(recovery_new), recovery_changed,
        container_size, &changed_size) == SCPEFE_STATUS_OK);
    CHECK(changed_size == container_size);
    CHECK(memcmp(owner_changed + snapshot_offset,
        recovery_changed + snapshot_offset,
        container_size - snapshot_offset) == 0);
    CHECK(memcmp(owner_changed + 160, recovery_changed + 160, 65) == 0);
    CHECK(memcmp(owner_changed + 160 + 65,
        recovery_changed + 160 + 65, 65) != 0);
    CHECK(rejects_password(recovery_changed, changed_size, recovery) == 0);
    CHECK(unlock_values(recovery_changed, changed_size, recovery_new,
        changed_document_id, changed_slot_id, &changed_revision,
        &changed_revision_size, 1) == 0);
    CHECK(memcmp(document_id, changed_document_id, sizeof(document_id)) == 0);
    CHECK(memcmp(recovery_slot_id, changed_slot_id, sizeof(recovery_slot_id)) == 0);
    CHECK(revision_size == changed_revision_size);
    CHECK(memcmp(revision, changed_revision, revision_size) == 0);
    free(changed_revision);
    CHECK(unlock_values(recovery_changed, changed_size, owner_new,
        changed_document_id, changed_slot_id, &changed_revision,
        &changed_revision_size, 0) == 0);
    CHECK(memcmp(owner_slot_id, changed_slot_id, sizeof(owner_slot_id)) == 0);
    free(changed_revision);

    free(revision);
    free(recovery_changed);
    free(owner_changed);
    free(container);
    return 0;
}
