#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(value) do { if (!(value)) return __LINE__; } while (0)

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
    static const char replacement[] = "new invited passphrase with private words";
    const scpefe_new_document_v1 document = {
        sizeof(document), "Ada", 3, "ada@example.test", 16, "PC", 2,
        "secret text\n", 12, 1726747200123u,
        (const uint8_t *)owner, sizeof(owner) - 1,
        (const uint8_t *)recovery, sizeof(recovery) - 1
    };
    uint8_t *container = NULL, *invited = NULL, *claimed = NULL, *extra = NULL;
    size_t size = 0, invited_size = 0, claimed_size = 0, extra_size = 0;
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
    CHECK(claim(invited, invited_size, temporary, replacement,
        &claimed, &claimed_size) == SCPEFE_STATUS_OK);
    CHECK(scpefe_password_container_unlock(claimed, claimed_size,
        (const uint8_t *)temporary, sizeof(temporary) - 1, &unlocked)
        == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    CHECK(access(claimed, claimed_size, replacement, &slot) == 0);
    CHECK(slot.must_be_changed == 0
        && slot.identity_name_size == strlen("Grace Hopper")
        && slot.identity_email_size == strlen("grace@example.test"));
    CHECK(add(claimed, claimed_size, replacement,
        "another safely generated invitation phrase", 1, 0,
        &extra, &extra_size) == SCPEFE_STATUS_INVALID_ARGUMENT);
    CHECK(add(container, size, recovery,
        "recovery creates a constrained invitation", 0, 0,
        &extra, &extra_size) == SCPEFE_STATUS_OK);
    free(extra); extra = NULL;
    CHECK(add(container, size, recovery,
        "violet-correct-horse-battery-planet-92831", 0, 1,
        &extra, &extra_size) == SCPEFE_STATUS_INVALID_ARGUMENT);
    free(extra); free(claimed); free(invited); free(container);
    return 0;
}
