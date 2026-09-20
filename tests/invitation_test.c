#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(value) do { if (!(value)) return __LINE__; } while (0)

static uint32_t read_u32(const uint8_t *input)
{
    return (uint32_t)input[0] | (uint32_t)input[1] << 8
        | (uint32_t)input[2] << 16 | (uint32_t)input[3] << 24;
}

static const uint8_t *invitation_record(const uint8_t *container, size_t size,
    size_t *record_size)
{
    static const uint8_t magic[] = {'S','C','P','I','N','V','0','2'};
    size_t offset;
    for (offset = 0; offset + sizeof(magic) + 12 < size; ++offset) {
        if (memcmp(container + offset, magic, sizeof(magic)) == 0) break;
    }
    if (offset + sizeof(magic) + 12 >= size || read_u32(container + offset + 8) == 0)
        return NULL;
    offset += 12;
    *record_size = 44 + read_u32(container + offset + 40);
    if (*record_size > size - offset) return NULL;
    return container + offset;
}

static scpefe_status add(const uint8_t *container, size_t size,
    const char *creator, const char *temporary, int edit, int add_passwords,
    uint8_t **result, size_t *result_size)
{
    const scpefe_invitation_create_v1 request = {
        sizeof(request), container, size,
        (const uint8_t *)creator, strlen(creator),
        (const uint8_t *)temporary, strlen(temporary),
        edit, add_passwords, 0, "New colleague", strlen("New colleague")
    };
    scpefe_status status = scpefe_password_container_add_invitation(
        &request, NULL, 0, result_size);
    if (status != SCPEFE_STATUS_BUFFER_TOO_SMALL) return status;
    *result = (uint8_t *)malloc(*result_size);
    if (*result == NULL) return SCPEFE_STATUS_OUT_OF_MEMORY;
    return scpefe_password_container_add_invitation(
        &request, *result, *result_size, result_size);
}

static scpefe_status claim(const uint8_t *container, size_t size,
    const char *temporary, const char *replacement,
    uint8_t **result, size_t *result_size)
{
    const scpefe_invitation_claim_v1 request = {
        sizeof(request), container, size,
        (const uint8_t *)temporary, strlen(temporary),
        (const uint8_t *)replacement, strlen(replacement),
        "Grace Hopper", strlen("Grace Hopper"),
        "grace@example.test", strlen("grace@example.test")
    };
    scpefe_status status = scpefe_password_container_claim_invitation(
        &request, NULL, 0, result_size);
    if (status != SCPEFE_STATUS_BUFFER_TOO_SMALL) return status;
    *result = (uint8_t *)malloc(*result_size);
    if (*result == NULL) return SCPEFE_STATUS_OUT_OF_MEMORY;
    return scpefe_password_container_claim_invitation(
        &request, *result, *result_size, result_size);
}

static scpefe_status change(const uint8_t *container, size_t size,
    const char *current, const char *replacement,
    uint8_t **result, size_t *result_size)
{
    scpefe_status status = scpefe_password_container_change_password(
        container, size, (const uint8_t *)current, strlen(current),
        (const uint8_t *)replacement, strlen(replacement), NULL, 0, result_size);
    if (status != SCPEFE_STATUS_BUFFER_TOO_SMALL) return status;
    *result = (uint8_t *)malloc(*result_size);
    if (*result == NULL) return SCPEFE_STATUS_OUT_OF_MEMORY;
    return scpefe_password_container_change_password(
        container, size, (const uint8_t *)current, strlen(current),
        (const uint8_t *)replacement, strlen(replacement),
        *result, *result_size, result_size);
}

static int access(const uint8_t *container, size_t size, const char *password,
    scpefe_unlocked_slot_access_v1 *view)
{
    scpefe_unlocked_container *unlocked = NULL;
    CHECK(scpefe_password_container_unlock(container, size,
        (const uint8_t *)password, strlen(password), &unlocked) == SCPEFE_STATUS_OK);
    view->struct_size = sizeof(*view);
    CHECK(scpefe_unlocked_container_slot_access(unlocked, view) == SCPEFE_STATUS_OK);
    scpefe_unlocked_container_destroy(unlocked);
    return 0;
}

int main(void)
{
    static const char owner[] = "owner passphrase with independent words";
    static const char recovery[] = "offline recovery passphrase is different";
    static const char temporary[] = "cobalt-lantern-river-planet-73";
    static const char delegated[] = "delegated-indigo-orbit-harbour-91";
    static const char replacement[] = "new invited passphrase with private words";
    static const char rewrapped_password[] = "rewrapped invited password remains private";
    const scpefe_new_document_v1 document = {
        sizeof(document), "Ada", 3, "ada@example.test", 16, "PC", 2,
        "secret text\n", 12, 1726747200123u,
        (const uint8_t *)owner, sizeof(owner) - 1,
        (const uint8_t *)recovery, sizeof(recovery) - 1
    };
    uint8_t *container = NULL, *invited = NULL, *claimed = NULL, *extra = NULL;
    uint8_t *delegated_invitation = NULL, *rewrapped = NULL;
    size_t size = 0, invited_size = 0, claimed_size = 0, extra_size = 0;
    size_t delegated_size = 0, rewrapped_size = 0;
    scpefe_unlocked_container *unlocked = NULL;
    scpefe_unlocked_slot_access_v1 slot = {0};
    CHECK(scpefe_new_document_create(&document, NULL, 0, &size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    container = (uint8_t *)malloc(size);
    CHECK(container != NULL);
    CHECK(scpefe_new_document_create(&document, container, size, &size)
        == SCPEFE_STATUS_OK);
    CHECK(add(container, size, owner, temporary, 1, 0,
        &invited, &invited_size) == SCPEFE_STATUS_OK);
    CHECK(access(invited, invited_size, temporary, &slot) == 0);
    CHECK(slot.can_edit == 1 && slot.can_add_passwords == 0
        && slot.must_be_changed == 1 && slot.recovery_slot == 0);
    CHECK(slot.identity_name_size == strlen("New colleague"));
    {
        uint8_t *tampered = (uint8_t *)malloc(invited_size);
        CHECK(tampered != NULL);
        memcpy(tampered, invited, invited_size);
        tampered[invited_size - 1] ^= 1;
        CHECK(scpefe_password_container_unlock(tampered, invited_size,
            (const uint8_t *)temporary, sizeof(temporary) - 1, &unlocked)
            == SCPEFE_STATUS_AUTHENTICATION_FAILED);
        CHECK(unlocked == NULL);
        free(tampered);
    }
    extra_size = 0;
    CHECK(scpefe_password_container_change_password(invited, invited_size,
        (const uint8_t *)temporary, sizeof(temporary) - 1,
        (const uint8_t *)replacement, sizeof(replacement) - 1,
        NULL, 0, &extra_size) == SCPEFE_STATUS_INVALID_ARGUMENT);
    CHECK(add(container, size, owner, delegated, 1, 1,
        &delegated_invitation, &delegated_size) == SCPEFE_STATUS_OK);
    CHECK(add(delegated_invitation, delegated_size, delegated,
        "nested invitation must never be created", 1, 0,
        &extra, &extra_size) == SCPEFE_STATUS_INVALID_ARGUMENT);
    free(extra); extra = NULL;
    CHECK(claim(invited, invited_size, temporary, replacement,
        &claimed, &claimed_size) == SCPEFE_STATUS_OK);
    CHECK(scpefe_password_container_unlock(claimed, claimed_size,
        (const uint8_t *)temporary, sizeof(temporary) - 1, &unlocked)
        == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    CHECK(access(claimed, claimed_size, replacement, &slot) == 0);
    CHECK(slot.must_be_changed == 0
        && slot.identity_name_size == strlen("Grace Hopper")
        && slot.identity_email_size == strlen("grace@example.test"));
    {
        size_t old_record_size = 0, current_record_size = 0;
        const uint8_t *old_record = invitation_record(
            invited, invited_size, &old_record_size);
        const uint8_t *current_record = invitation_record(
            claimed, claimed_size, &current_record_size);
        const size_t prefix_size = (size_t)(current_record - claimed);
        const size_t replay_size = claimed_size - current_record_size + old_record_size;
        const size_t allocation_size = replay_size > claimed_size
            ? replay_size : claimed_size;
        uint8_t *replayed = (uint8_t *)malloc(allocation_size);
        CHECK(old_record != NULL && current_record != NULL && replayed != NULL);
        memcpy(replayed, claimed, prefix_size);
        memcpy(replayed + prefix_size, old_record, old_record_size);
        memcpy(replayed + prefix_size + old_record_size,
            current_record + current_record_size,
            claimed_size - prefix_size - current_record_size);
        CHECK(scpefe_password_container_unlock(replayed, replay_size,
            (const uint8_t *)temporary, sizeof(temporary) - 1, &unlocked)
            == SCPEFE_STATUS_AUTHENTICATION_FAILED);
        CHECK(unlocked == NULL);
        CHECK(scpefe_password_container_unlock(claimed, claimed_size,
            (const uint8_t *)replacement, sizeof(replacement) - 1, &unlocked)
            == SCPEFE_STATUS_OK);
        scpefe_unlocked_container_destroy(unlocked); unlocked = NULL;
        memcpy(replayed, claimed, claimed_size);
        replayed[prefix_size + 44] ^= 1;
        CHECK(scpefe_password_container_unlock(replayed, claimed_size,
            (const uint8_t *)owner, sizeof(owner) - 1, &unlocked)
            == SCPEFE_STATUS_AUTHENTICATION_FAILED);
        CHECK(unlocked == NULL);
        free(replayed);
    }
    CHECK(claim(claimed, claimed_size, replacement,
        "second claim must not replace claimed identity", &extra, &extra_size)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    CHECK(add(claimed, claimed_size, replacement,
        "another safely generated invitation phrase", 1, 0,
        &extra, &extra_size) == SCPEFE_STATUS_INVALID_ARGUMENT);
    CHECK(change(claimed, claimed_size, replacement, rewrapped_password,
        &rewrapped, &rewrapped_size) == SCPEFE_STATUS_OK);
    CHECK(scpefe_password_container_unlock(rewrapped, rewrapped_size,
        (const uint8_t *)replacement, sizeof(replacement) - 1, &unlocked)
        == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    CHECK(access(rewrapped, rewrapped_size, rewrapped_password, &slot) == 0);
    CHECK(add(container, size, recovery,
        "recovery creates a constrained invitation", 0, 0,
        &extra, &extra_size) == SCPEFE_STATUS_OK);
    free(extra); extra = NULL;
    CHECK(add(container, size, recovery,
        "violet-correct-horse-battery-planet-92831", 0, 1,
        &extra, &extra_size) == SCPEFE_STATUS_INVALID_ARGUMENT);
    free(extra); free(rewrapped); free(delegated_invitation);
    free(claimed); free(invited); free(container);
    return 0;
}
