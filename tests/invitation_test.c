#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdio.h>
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
    static const uint8_t magic[] = {'S','C','P','I','N','V','0','3'};
    size_t offset;
    for (offset = 0; offset + sizeof(magic) + 12 < size; ++offset) {
        if (memcmp(container + offset, magic, sizeof(magic)) == 0) break;
    }
    if (offset + sizeof(magic) + 12 >= size || read_u32(container + offset + 8) == 0)
        return NULL;
    offset += 12;
    *record_size = 44 + read_u32(container + offset + 40);
    if (*record_size > size - offset) return NULL;
    if (*record_size + 28 > size - offset) return NULL;
    *record_size += 28 + read_u32(container + offset + *record_size + 24);
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

static scpefe_status update_permissions(const uint8_t *container, size_t size,
    const char *administrator, const uint8_t slot_id[SCPEFE_SLOT_ID_SIZE],
    int edit, int add_passwords, int remove_passwords,
    uint8_t **result, size_t *result_size)
{
    const scpefe_slot_permissions_update_v1 request = {
        sizeof(request), container, size,
        (const uint8_t *)administrator, strlen(administrator),
        slot_id, SCPEFE_SLOT_ID_SIZE, edit, add_passwords, remove_passwords
    };
    scpefe_status status = scpefe_password_container_update_slot_permissions(
        &request, NULL, 0, result_size);
    if (status != SCPEFE_STATUS_BUFFER_TOO_SMALL) return status;
    *result = (uint8_t *)malloc(*result_size);
    if (*result == NULL) return SCPEFE_STATUS_OUT_OF_MEMORY;
    return scpefe_password_container_update_slot_permissions(
        &request, *result, *result_size, result_size);
}

static scpefe_status remove_slot(const uint8_t *container, size_t size,
    const char *administrator, const uint8_t slot_id[SCPEFE_SLOT_ID_SIZE],
    uint8_t **result, size_t *result_size)
{
    const scpefe_slot_remove_v1 request = {
        sizeof(request), container, size,
        (const uint8_t *)administrator, strlen(administrator),
        slot_id, SCPEFE_SLOT_ID_SIZE
    };
    scpefe_status status = scpefe_password_container_remove_slot(
        &request, NULL, 0, result_size);
    if (status != SCPEFE_STATUS_BUFFER_TOO_SMALL) return status;
    *result = (uint8_t *)malloc(*result_size);
    if (*result == NULL) return SCPEFE_STATUS_OUT_OF_MEMORY;
    return scpefe_password_container_remove_slot(
        &request, *result, *result_size, result_size);
}

static scpefe_status reconcile(const uint8_t *container, size_t size,
    const char *password, const char *name, const char *email,
    uint8_t **result, size_t *result_size)
{
    const scpefe_slot_identity_reconcile_v1 request = {
        sizeof(request), container, size,
        (const uint8_t *)password, strlen(password),
        name, strlen(name), email, strlen(email)
    };
    scpefe_status status = scpefe_password_container_reconcile_identity(
        &request, NULL, 0, result_size);
    if (status != SCPEFE_STATUS_BUFFER_TOO_SMALL) return status;
    *result = (uint8_t *)malloc(*result_size);
    if (*result == NULL) return SCPEFE_STATUS_OUT_OF_MEMORY;
    return scpefe_password_container_reconcile_identity(
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

/* Compares authenticated document identity and exact revision bytes after a slot edit. */
static int same_document(const uint8_t *before, size_t before_size,
    const uint8_t *after, size_t after_size, const char *owner)
{
    scpefe_unlocked_container *old = NULL, *current = NULL;
    scpefe_unlocked_container_v1 old_view = {0}, current_view = {0};
    scpefe_editing_lease_v1 old_lease = {0}, current_lease = {0};
    CHECK(scpefe_password_container_unlock(before, before_size,
        (const uint8_t *)owner, strlen(owner), &old) == SCPEFE_STATUS_OK);
    CHECK(scpefe_password_container_unlock(after, after_size,
        (const uint8_t *)owner, strlen(owner), &current) == SCPEFE_STATUS_OK);
    old_view.struct_size = current_view.struct_size = sizeof(old_view);
    CHECK(scpefe_unlocked_container_view(old, &old_view) == SCPEFE_STATUS_OK);
    CHECK(scpefe_unlocked_container_view(current, &current_view) == SCPEFE_STATUS_OK);
    CHECK(old_view.document_id_size == current_view.document_id_size
        && memcmp(old_view.document_id, current_view.document_id,
            old_view.document_id_size) == 0);
    CHECK(old_view.encoded_snapshot_revision_size
        == current_view.encoded_snapshot_revision_size
        && memcmp(old_view.encoded_snapshot_revision,
            current_view.encoded_snapshot_revision,
            old_view.encoded_snapshot_revision_size) == 0);
    old_lease.struct_size = current_lease.struct_size = sizeof(old_lease);
    CHECK(scpefe_unlocked_container_editing_lease(old, &old_lease)
        == SCPEFE_STATUS_OK);
    CHECK(scpefe_unlocked_container_editing_lease(current, &current_lease)
        == SCPEFE_STATUS_OK);
    CHECK(old_lease.active == current_lease.active
        && old_lease.heartbeat_counter == current_lease.heartbeat_counter
        && old_lease.holder_utc_ms == current_lease.holder_utc_ms
        && old_lease.duration_ms == current_lease.duration_ms);
    CHECK(old_lease.session_id_size == current_lease.session_id_size);
    if (old_lease.session_id_size != 0)
        CHECK(memcmp(old_lease.session_id, current_lease.session_id,
            old_lease.session_id_size) == 0);
    CHECK(old_lease.holder_name_size == current_lease.holder_name_size
        && old_lease.holder_email_size == current_lease.holder_email_size
        && old_lease.device_name_size == current_lease.device_name_size);
    if (old_lease.holder_name_size != 0)
        CHECK(memcmp(old_lease.holder_name, current_lease.holder_name,
            old_lease.holder_name_size) == 0);
    if (old_lease.holder_email_size != 0)
        CHECK(memcmp(old_lease.holder_email, current_lease.holder_email,
            old_lease.holder_email_size) == 0);
    if (old_lease.device_name_size != 0)
        CHECK(memcmp(old_lease.device_name, current_lease.device_name,
            old_lease.device_name_size) == 0);
    scpefe_unlocked_container_destroy(old);
    scpefe_unlocked_container_destroy(current);
    return 0;
}

/* Compares the selected slot's stable role across a password rotation. */
static int same_role(const uint8_t *before, size_t before_size,
    const char *old_password, const uint8_t *after, size_t after_size,
    const char *new_password)
{
    scpefe_unlocked_container *old = NULL, *current = NULL;
    scpefe_unlocked_slot_access_v1 old_slot = {0}, current_slot = {0};
    CHECK(scpefe_password_container_unlock(before, before_size,
        (const uint8_t *)old_password, strlen(old_password), &old)
        == SCPEFE_STATUS_OK);
    CHECK(scpefe_password_container_unlock(after, after_size,
        (const uint8_t *)new_password, strlen(new_password), &current)
        == SCPEFE_STATUS_OK);
    old_slot.struct_size = current_slot.struct_size = sizeof(old_slot);
    CHECK(scpefe_unlocked_container_slot_access(old, &old_slot)
        == SCPEFE_STATUS_OK);
    CHECK(scpefe_unlocked_container_slot_access(current, &current_slot)
        == SCPEFE_STATUS_OK);
    CHECK(old_slot.slot_id_size == SCPEFE_SLOT_ID_SIZE
        && current_slot.slot_id_size == SCPEFE_SLOT_ID_SIZE
        && memcmp(old_slot.slot_id, current_slot.slot_id,
            SCPEFE_SLOT_ID_SIZE) == 0);
    CHECK(old_slot.can_edit == current_slot.can_edit
        && old_slot.can_add_passwords == current_slot.can_add_passwords
        && old_slot.can_remove_passwords == current_slot.can_remove_passwords
        && old_slot.recovery_slot == current_slot.recovery_slot
        && old_slot.must_be_changed == current_slot.must_be_changed);
    CHECK(old_slot.identity_name_size == current_slot.identity_name_size
        && old_slot.identity_email_size == current_slot.identity_email_size);
    if (old_slot.identity_name_size != 0)
        CHECK(memcmp(old_slot.identity_name, current_slot.identity_name,
            old_slot.identity_name_size) == 0);
    if (old_slot.identity_email_size != 0)
        CHECK(memcmp(old_slot.identity_email, current_slot.identity_email,
            old_slot.identity_email_size) == 0);
    scpefe_unlocked_container_destroy(old);
    scpefe_unlocked_container_destroy(current);
    return 0;
}

/* Checks the authenticated identity while its borrowed strings are alive. */
static int identity_is(const uint8_t *container, size_t size,
    const char *password, const char *name, const char *email)
{
    scpefe_unlocked_container *unlocked = NULL;
    scpefe_unlocked_slot_access_v1 slot = {0};
    CHECK(scpefe_password_container_unlock(container, size,
        (const uint8_t *)password, strlen(password), &unlocked)
        == SCPEFE_STATUS_OK);
    slot.struct_size = sizeof(slot);
    CHECK(scpefe_unlocked_container_slot_access(unlocked, &slot)
        == SCPEFE_STATUS_OK);
    CHECK(slot.identity_name_size == strlen(name)
        && slot.identity_email_size == strlen(email));
    CHECK(memcmp(slot.identity_name, name, strlen(name)) == 0
        && memcmp(slot.identity_email, email, strlen(email)) == 0);
    scpefe_unlocked_container_destroy(unlocked);
    return 0;
}

/* Checks that an unaffected ordinary slot keeps its immutable identifier. */
static int same_slot_id(const uint8_t *before, size_t before_size,
    const uint8_t *after, size_t after_size, const char *password)
{
    scpefe_unlocked_container *old = NULL, *current = NULL;
    scpefe_unlocked_slot_access_v1 old_slot = {0}, current_slot = {0};
    CHECK(scpefe_password_container_unlock(before, before_size,
        (const uint8_t *)password, strlen(password), &old) == SCPEFE_STATUS_OK);
    CHECK(scpefe_password_container_unlock(after, after_size,
        (const uint8_t *)password, strlen(password), &current)
        == SCPEFE_STATUS_OK);
    old_slot.struct_size = current_slot.struct_size = sizeof(old_slot);
    CHECK(scpefe_unlocked_container_slot_access(old, &old_slot) == SCPEFE_STATUS_OK);
    CHECK(scpefe_unlocked_container_slot_access(current, &current_slot)
        == SCPEFE_STATUS_OK);
    CHECK(old_slot.slot_id_size == SCPEFE_SLOT_ID_SIZE
        && current_slot.slot_id_size == SCPEFE_SLOT_ID_SIZE
        && memcmp(old_slot.slot_id, current_slot.slot_id,
            SCPEFE_SLOT_ID_SIZE) == 0);
    scpefe_unlocked_container_destroy(old);
    scpefe_unlocked_container_destroy(current);
    return 0;
}

/* Loads a checked-in legacy container without changing its authenticated bytes. */
static uint8_t *read_fixture(const char *root, const char *name, size_t *size)
{
    char path[1024];
    if (snprintf(path, sizeof(path), "%s/apps/windows/test/fixtures/%s",
        root, name) >= (int)sizeof(path)) return NULL;
    FILE *input = fopen(path, "rb");
    if (input == NULL) return NULL;
    if (fseek(input, 0, SEEK_END) != 0) { fclose(input); return NULL; }
    const long length = ftell(input);
    if (length <= 0 || fseek(input, 0, SEEK_SET) != 0) {
        fclose(input); return NULL;
    }
    uint8_t *bytes = (uint8_t *)malloc((size_t)length / 2);
    if (bytes == NULL) { fclose(input); return NULL; }
    *size = 0;
    unsigned int value;
    while (fscanf(input, " %2x", &value) == 1) {
        if (*size >= (size_t)length / 2) { free(bytes); fclose(input); return NULL; }
        bytes[(*size)++] = (uint8_t)value;
    }
    fclose(input);
    return bytes;
}

/* Checks both authenticated known values and intentionally unknown legacy fields. */
static int legacy_metadata(const char *root)
{
    static const char owner[] = "owner passphrase with independent words";
    const char *fixtures[] = {
        "legacy-invitation-v2.hex",
        "password-container-v2-history-invitations.hex"
    };
    for (size_t index = 0; index < 2; ++index) {
        size_t size = 0, count = 0;
        uint8_t *container = read_fixture(root, fixtures[index], &size);
        scpefe_unlocked_container *unlocked = NULL;
        scpefe_managed_slot_v1 managed = {0};
        CHECK(container != NULL && size > 0);
        CHECK(scpefe_password_container_unlock(container, size,
            (const uint8_t *)owner, strlen(owner), &unlocked) == SCPEFE_STATUS_OK);
        CHECK(scpefe_unlocked_container_managed_slot_count(unlocked, &count)
            == SCPEFE_STATUS_OK && count > 0);
        managed.struct_size = sizeof(managed);
        CHECK(scpefe_unlocked_container_managed_slot(unlocked, 0, &managed)
            == SCPEFE_STATUS_OK);
        CHECK(managed.slot_id_size == SCPEFE_SLOT_ID_SIZE);
        CHECK(managed.slot_id_known == (int)index
            && managed.permissions_known == (int)index
            && managed.identity_known == (int)index
            && managed.must_be_changed_known == (int)index);
        scpefe_unlocked_container_destroy(unlocked);
        free(container);
    }
    return 0;
}

int main(int argc, char **argv)
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
    CHECK(add(container, size, owner, "short", 1, 0,
        &extra, &extra_size) == SCPEFE_STATUS_WEAK_PASSWORD);
    CHECK(add(container, size, owner, temporary, 1, 0,
        &invited, &invited_size) == SCPEFE_STATUS_OK);
    CHECK(add(invited, invited_size, owner, temporary, 1, 0,
        &extra, &extra_size) == SCPEFE_STATUS_PASSWORD_ALREADY_IN_USE);
    CHECK(add(invited, invited_size, owner, recovery, 1, 0,
        &extra, &extra_size) == SCPEFE_STATUS_PASSWORD_ALREADY_IN_USE);
    CHECK(same_document(container, size, invited, invited_size, owner) == 0);
    CHECK(access(invited, invited_size, owner, &slot) == 0);
    CHECK(slot.can_edit && slot.can_add_passwords && slot.can_remove_passwords);
    CHECK(access(invited, invited_size, recovery, &slot) == 0);
    CHECK(slot.recovery_slot && slot.can_edit && slot.can_add_passwords
        && slot.can_remove_passwords);
    {
        size_t count = 0;
        scpefe_managed_slot_v1 managed = {0};
        CHECK(scpefe_password_container_unlock(invited, invited_size,
            (const uint8_t *)owner, sizeof(owner) - 1, &unlocked)
            == SCPEFE_STATUS_OK);
        CHECK(scpefe_unlocked_container_managed_slot_count(unlocked, &count)
            == SCPEFE_STATUS_OK && count == 1);
        managed.struct_size = sizeof(managed);
        CHECK(scpefe_unlocked_container_managed_slot(unlocked, 0, &managed)
            == SCPEFE_STATUS_OK);
        CHECK(managed.must_be_changed && managed.must_be_changed_known
            && managed.slot_id_known && managed.permissions_known
            && managed.identity_known);
        CHECK(managed.identity_name_size == strlen("New colleague")
            && managed.identity_email_size == 0);
        scpefe_unlocked_container_destroy(unlocked); unlocked = NULL;
    }
    CHECK(claim(invited, invited_size, temporary, "short",
        &extra, &extra_size) == SCPEFE_STATUS_WEAK_PASSWORD);
    CHECK(claim(invited, invited_size, temporary, owner,
        &extra, &extra_size) == SCPEFE_STATUS_PASSWORD_ALREADY_IN_USE);
    CHECK(claim(invited, invited_size, temporary, recovery,
        &extra, &extra_size) == SCPEFE_STATUS_PASSWORD_ALREADY_IN_USE);
    CHECK(access(invited, invited_size, temporary, &slot) == 0);
    CHECK(slot.can_edit == 1 && slot.can_add_passwords == 0
        && slot.must_be_changed == 1 && slot.recovery_slot == 0);
    CHECK(slot.identity_name_size == strlen("New colleague"));
    CHECK(reconcile(invited, invited_size, temporary,
        "Grace Hopper", "grace@example.test", &extra, &extra_size)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    CHECK(reconcile(invited, invited_size, recovery,
        "Recovery Operator", "recovery@example.test", &extra, &extra_size)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
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
    {
        uint8_t *two_invited = NULL, *one_claimed = NULL;
        size_t two_size = 0, one_size = 0, count = 0;
        CHECK(add(invited, invited_size, owner, delegated, 1, 0,
            &two_invited, &two_size) == SCPEFE_STATUS_OK);
        CHECK(claim(two_invited, two_size, temporary, replacement,
            &one_claimed, &one_size) == SCPEFE_STATUS_OK);
        CHECK(same_document(two_invited, two_size, one_claimed, one_size,
            owner) == 0);
        CHECK(same_slot_id(two_invited, two_size, one_claimed, one_size,
            delegated) == 0);
        CHECK(access(one_claimed, one_size, recovery, &slot) == 0);
        CHECK(slot.recovery_slot);
        CHECK(scpefe_password_container_unlock(one_claimed, one_size,
            (const uint8_t *)owner, sizeof(owner) - 1, &unlocked)
            == SCPEFE_STATUS_OK);
        CHECK(scpefe_unlocked_container_managed_slot_count(unlocked, &count)
            == SCPEFE_STATUS_OK && count == 2);
        scpefe_unlocked_container_destroy(unlocked); unlocked = NULL;
        free(one_claimed); free(two_invited);
    }
    CHECK(claim(invited, invited_size, temporary, replacement,
        &claimed, &claimed_size) == SCPEFE_STATUS_OK);
    CHECK(same_document(invited, invited_size, claimed, claimed_size, owner) == 0);
    CHECK(access(claimed, claimed_size, owner, &slot) == 0);
    CHECK(slot.can_edit && slot.can_add_passwords && slot.can_remove_passwords);
    CHECK(access(claimed, claimed_size, recovery, &slot) == 0);
    CHECK(slot.recovery_slot && slot.can_edit && slot.can_add_passwords
        && slot.can_remove_passwords);
    CHECK(scpefe_password_container_unlock(claimed, claimed_size,
        (const uint8_t *)temporary, sizeof(temporary) - 1, &unlocked)
        == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    CHECK(access(claimed, claimed_size, replacement, &slot) == 0);
    CHECK(slot.must_be_changed == 0
        && slot.identity_name_size == strlen("Grace Hopper")
        && slot.identity_email_size == strlen("grace@example.test"));
    {
        uint8_t before_id[SCPEFE_SLOT_ID_SIZE];
        CHECK(scpefe_password_container_unlock(invited, invited_size,
            (const uint8_t *)temporary, sizeof(temporary) - 1, &unlocked)
            == SCPEFE_STATUS_OK);
        slot.struct_size = sizeof(slot);
        CHECK(scpefe_unlocked_container_slot_access(unlocked, &slot)
            == SCPEFE_STATUS_OK);
        memcpy(before_id, slot.slot_id, sizeof(before_id));
        scpefe_unlocked_container_destroy(unlocked); unlocked = NULL;
        CHECK(scpefe_password_container_unlock(claimed, claimed_size,
            (const uint8_t *)replacement, sizeof(replacement) - 1, &unlocked)
            == SCPEFE_STATUS_OK);
        CHECK(scpefe_unlocked_container_slot_access(unlocked, &slot)
            == SCPEFE_STATUS_OK);
        CHECK(slot.slot_id_size == sizeof(before_id)
            && memcmp(slot.slot_id, before_id, sizeof(before_id)) == 0);
        scpefe_unlocked_container_destroy(unlocked); unlocked = NULL;
    }
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
        memcpy(replayed, claimed, claimed_size);
        replayed[prefix_size + 44 + read_u32(current_record + 40) + 28] ^= 1;
        CHECK(scpefe_password_container_unlock(replayed, claimed_size,
            (const uint8_t *)owner, sizeof(owner) - 1, &unlocked)
            == SCPEFE_STATUS_AUTHENTICATION_FAILED);
        CHECK(unlocked == NULL);
        memcpy(replayed, claimed, claimed_size);
        replayed[prefix_size + current_record_size] ^= 1;
        extra_size = 0;
        CHECK(scpefe_password_container_change_password(
            replayed, claimed_size,
            (const uint8_t *)owner, sizeof(owner) - 1,
            (const uint8_t *)"violet-correct-horse-battery-planet-92831",
            strlen("violet-correct-horse-battery-planet-92831"),
            NULL, 0, &extra_size) == SCPEFE_STATUS_AUTHENTICATION_FAILED);
        CHECK(scpefe_password_container_change_password(
            replayed, claimed_size,
            (const uint8_t *)recovery, sizeof(recovery) - 1,
            (const uint8_t *)"harbour-orchid-cobalt-window-forest-63842",
            strlen("harbour-orchid-cobalt-window-forest-63842"),
            NULL, 0, &extra_size) == SCPEFE_STATUS_AUTHENTICATION_FAILED);
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
    CHECK(same_document(claimed, claimed_size, rewrapped, rewrapped_size,
        owner) == 0);
    CHECK(same_role(claimed, claimed_size, replacement,
        rewrapped, rewrapped_size, rewrapped_password) == 0);
    CHECK(same_slot_id(claimed, claimed_size, rewrapped, rewrapped_size,
        owner) == 0);
    CHECK(same_slot_id(claimed, claimed_size, rewrapped, rewrapped_size,
        recovery) == 0);
    CHECK(scpefe_password_container_unlock(rewrapped, rewrapped_size,
        (const uint8_t *)replacement, sizeof(replacement) - 1, &unlocked)
        == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    CHECK(access(rewrapped, rewrapped_size, rewrapped_password, &slot) == 0);
    {
        const char *owner_new = "owner rotates after invitation was claimed";
        uint8_t *owner_rotated = NULL;
        size_t owner_rotated_size = 0;
        CHECK(change(claimed, claimed_size, owner, owner_new,
            &owner_rotated, &owner_rotated_size) == SCPEFE_STATUS_OK);
        CHECK(same_document(claimed, claimed_size,
            owner_rotated, owner_rotated_size, recovery) == 0);
        CHECK(same_role(claimed, claimed_size, owner,
            owner_rotated, owner_rotated_size, owner_new) == 0);
        CHECK(same_slot_id(claimed, claimed_size,
            owner_rotated, owner_rotated_size, replacement) == 0);
        CHECK(same_slot_id(claimed, claimed_size,
            owner_rotated, owner_rotated_size, recovery) == 0);
        CHECK(scpefe_password_container_unlock(owner_rotated,
            owner_rotated_size, (const uint8_t *)owner, strlen(owner), &unlocked)
            == SCPEFE_STATUS_AUTHENTICATION_FAILED);
        free(owner_rotated);
    }
    CHECK(change(claimed, claimed_size, replacement, owner,
        &extra, &extra_size) == SCPEFE_STATUS_PASSWORD_ALREADY_IN_USE);
    CHECK(change(claimed, claimed_size, replacement, recovery,
        &extra, &extra_size) == SCPEFE_STATUS_PASSWORD_ALREADY_IN_USE);
    CHECK(change(claimed, claimed_size, replacement, "short",
        &extra, &extra_size) == SCPEFE_STATUS_WEAK_PASSWORD);
    CHECK(add(container, size, recovery,
        "recovery creates a constrained invitation", 0, 0,
        &extra, &extra_size) == SCPEFE_STATUS_OK);
    free(extra); extra = NULL;
    CHECK(add(container, size, recovery,
        "violet-correct-horse-battery-planet-92831", 0, 1,
        &extra, &extra_size) == SCPEFE_STATUS_INVALID_ARGUMENT);
    {
        uint8_t *current = container;
        size_t current_size = size;
        for (unsigned int index = 0; index < 7; ++index) {
            char password[64];
            uint8_t *next = NULL;
            size_t next_size = 0;
            CHECK(snprintf(password, sizeof(password),
                "dfc132af-600b-4d41-a1d8-0d55bbaee%03x", index)
                == 36);
            CHECK(add(current, current_size, owner, password, 0, 0,
                &next, &next_size) == SCPEFE_STATUS_OK);
            if (current != container) free(current);
            current = next; current_size = next_size;
        }
        CHECK(add(current, current_size, owner,
            "dfc132af-600b-4d41-a1d8-0d55bbaee007", 0, 0,
            &extra, &extra_size) == SCPEFE_STATUS_LIMIT_EXCEEDED);
        free(current);
    }
    {
        uint8_t managed_id[SCPEFE_SLOT_ID_SIZE];
        uint8_t owner_id[SCPEFE_SLOT_ID_SIZE];
        uint8_t *administered = NULL, *reconciled = NULL, *removed = NULL;
        uint8_t *view_rotated = NULL, *owner_reconciled = NULL;
        size_t administered_size = 0, reconciled_size = 0, removed_size = 0;
        size_t view_rotated_size = 0, owner_reconciled_size = 0;
        const char *view_password = "view-only holder rotates a private password";
        size_t managed_count = 0;
        scpefe_managed_slot_v1 managed = {0};
        CHECK(scpefe_password_container_unlock(claimed, claimed_size,
            (const uint8_t *)owner, sizeof(owner) - 1, &unlocked)
            == SCPEFE_STATUS_OK);
        CHECK(scpefe_unlocked_container_managed_slot_count(unlocked, &managed_count)
            == SCPEFE_STATUS_OK && managed_count == 1);
        managed.struct_size = sizeof(managed);
        CHECK(scpefe_unlocked_container_managed_slot(unlocked, 0, &managed)
            == SCPEFE_STATUS_OK);
        CHECK(managed.slot_id_size == SCPEFE_SLOT_ID_SIZE);
        CHECK(managed.identity_name_size == strlen("Grace Hopper")
            && memcmp(managed.identity_name, "Grace Hopper",
                managed.identity_name_size) == 0);
        CHECK(managed.identity_email_size == strlen("grace@example.test")
            && memcmp(managed.identity_email, "grace@example.test",
                managed.identity_email_size) == 0);
        CHECK(managed.slot_id_known && managed.permissions_known
            && managed.identity_known && managed.must_be_changed_known);
        const char *borrowed_name = managed.identity_name;
        scpefe_managed_slot_v1 repeated = {0};
        repeated.struct_size = sizeof(repeated);
        CHECK(scpefe_unlocked_container_managed_slot(unlocked, 0, &repeated)
            == SCPEFE_STATUS_OK);
        CHECK(repeated.identity_name == borrowed_name);
        memcpy(managed_id, managed.slot_id, sizeof(managed_id));
        slot.struct_size = sizeof(slot);
        CHECK(scpefe_unlocked_container_slot_access(unlocked, &slot)
            == SCPEFE_STATUS_OK);
        memcpy(owner_id, slot.slot_id, sizeof(owner_id));
        scpefe_unlocked_container_destroy(unlocked); unlocked = NULL;
        CHECK(remove_slot(claimed, claimed_size, owner, owner_id,
            &removed, &removed_size) == SCPEFE_STATUS_INVALID_ARGUMENT);
        CHECK(update_permissions(claimed, claimed_size, owner, managed_id,
            0, 1, 0, &administered, &administered_size)
            == SCPEFE_STATUS_INVALID_ARGUMENT);
        CHECK(update_permissions(claimed, claimed_size, owner, managed_id,
            0, 0, 0, &administered, &administered_size) == SCPEFE_STATUS_OK);
        CHECK(access(administered, administered_size, replacement, &slot) == 0);
        CHECK(slot.can_edit == 0 && slot.can_add_passwords == 0
            && slot.can_remove_passwords == 0);
        CHECK(change(administered, administered_size, replacement,
            view_password, &view_rotated, &view_rotated_size) == SCPEFE_STATUS_OK);
        CHECK(same_document(administered, administered_size,
            view_rotated, view_rotated_size, owner) == 0);
        CHECK(same_role(administered, administered_size, replacement,
            view_rotated, view_rotated_size, view_password) == 0);
        CHECK(same_slot_id(administered, administered_size,
            view_rotated, view_rotated_size, owner) == 0);
        CHECK(same_slot_id(administered, administered_size,
            view_rotated, view_rotated_size, recovery) == 0);
        CHECK(scpefe_password_container_unlock(view_rotated, view_rotated_size,
            (const uint8_t *)replacement, sizeof(replacement) - 1, &unlocked)
            == SCPEFE_STATUS_AUTHENTICATION_FAILED);
        CHECK(reconcile(view_rotated, view_rotated_size, view_password,
            "Rear Admiral Grace Hopper", "hopper@example.test",
            &reconciled, &reconciled_size) == SCPEFE_STATUS_OK);
        CHECK(same_document(view_rotated, view_rotated_size,
            reconciled, reconciled_size, owner) == 0);
        CHECK(same_slot_id(view_rotated, view_rotated_size,
            reconciled, reconciled_size, view_password) == 0);
        CHECK(access(reconciled, reconciled_size, view_password, &slot) == 0);
        CHECK(slot.can_edit == 0 && slot.can_add_passwords == 0
            && slot.can_remove_passwords == 0);
        CHECK(slot.identity_name_size == strlen("Rear Admiral Grace Hopper")
            && slot.identity_email_size == strlen("hopper@example.test"));
        CHECK(identity_is(reconciled, reconciled_size, view_password,
            "Rear Admiral Grace Hopper", "hopper@example.test") == 0);
        CHECK(reconcile(reconciled, reconciled_size, owner,
            "Augusta Ada King", "ada.king@example.test",
            &owner_reconciled, &owner_reconciled_size) == SCPEFE_STATUS_OK);
        CHECK(same_document(reconciled, reconciled_size,
            owner_reconciled, owner_reconciled_size, owner) == 0);
        CHECK(same_slot_id(reconciled, reconciled_size,
            owner_reconciled, owner_reconciled_size, owner) == 0);
        CHECK(same_slot_id(reconciled, reconciled_size,
            owner_reconciled, owner_reconciled_size, view_password) == 0);
        CHECK(same_slot_id(reconciled, reconciled_size,
            owner_reconciled, owner_reconciled_size, recovery) == 0);
        CHECK(access(owner_reconciled, owner_reconciled_size, owner, &slot) == 0);
        CHECK(slot.identity_name_size == strlen("Augusta Ada King")
            && slot.identity_email_size == strlen("ada.king@example.test"));
        CHECK(slot.can_edit && slot.can_add_passwords
            && slot.can_remove_passwords);
        CHECK(identity_is(owner_reconciled, owner_reconciled_size, owner,
            "Augusta Ada King", "ada.king@example.test") == 0);
        CHECK(identity_is(owner_reconciled, owner_reconciled_size, view_password,
            "Rear Admiral Grace Hopper", "hopper@example.test") == 0);
        CHECK(reconcile(reconciled, reconciled_size, recovery,
            "Recovery Operator", "recovery@example.test",
            &extra, &extra_size) == SCPEFE_STATUS_INVALID_ARGUMENT);
        CHECK(remove_slot(reconciled, reconciled_size, owner, managed_id,
            &removed, &removed_size) == SCPEFE_STATUS_OK);
        CHECK(scpefe_password_container_unlock(removed, removed_size,
            (const uint8_t *)view_password, strlen(view_password), &unlocked)
            == SCPEFE_STATUS_AUTHENTICATION_FAILED);
        CHECK(access(removed, removed_size, owner, &slot) == 0);
        CHECK(slot.can_edit == 1 && slot.can_add_passwords == 1
            && slot.can_remove_passwords == 1);
        free(owner_reconciled); free(view_rotated);
        free(removed); free(reconciled); free(administered);
    }
    free(extra); free(rewrapped); free(delegated_invitation);
    free(claimed); free(invited); free(container);
    CHECK(argc == 2 && legacy_metadata(argv[1]) == 0);
    return 0;
}
