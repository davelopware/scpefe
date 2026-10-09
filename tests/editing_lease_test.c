#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)

static int contains(const uint8_t *bytes, size_t size, const char *text)
{
    const size_t text_size = strlen(text);
    for (size_t i = 0; i + text_size <= size; ++i)
        if (memcmp(bytes + i, text, text_size) == 0) return 1;
    return 0;
}

static int update_lease(const uint8_t *container, size_t container_size,
    const char *password, scpefe_editing_lease_v1 lease,
    uint8_t **result, size_t *result_size)
{
    const scpefe_editing_lease_update_v1 update = {
        sizeof(scpefe_editing_lease_update_v1), container, container_size,
        (const uint8_t *)password, strlen(password), lease,
    };
    CHECK(scpefe_editing_lease_update(&update, NULL, 0, result_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    *result = (uint8_t *)malloc(*result_size);
    CHECK(*result != NULL);
    CHECK(scpefe_editing_lease_update(&update, *result, *result_size, result_size)
        == SCPEFE_STATUS_OK);
    return 0;
}

static int same_access(const uint8_t *before, size_t before_size,
    const uint8_t *after, size_t after_size, const char *password)
{
    scpefe_unlocked_container *old = NULL, *current = NULL;
    scpefe_unlocked_container_v1 old_view = {0}, current_view = {0};
    scpefe_unlocked_slot_access_v1 old_slot = {0}, current_slot = {0};
    uint8_t old_key[SCPEFE_WORK_JOURNAL_KEY_SIZE];
    uint8_t current_key[SCPEFE_WORK_JOURNAL_KEY_SIZE];
    size_t old_key_size = 0, current_key_size = 0;
    CHECK(scpefe_password_container_unlock(before, before_size,
        (const uint8_t *)password, strlen(password), &old) == SCPEFE_STATUS_OK);
    CHECK(scpefe_password_container_unlock(after, after_size,
        (const uint8_t *)password, strlen(password), &current) == SCPEFE_STATUS_OK);
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
    old_slot.struct_size = current_slot.struct_size = sizeof(old_slot);
    CHECK(scpefe_unlocked_container_slot_access(old, &old_slot) == SCPEFE_STATUS_OK);
    CHECK(scpefe_unlocked_container_slot_access(current, &current_slot)
        == SCPEFE_STATUS_OK);
    CHECK(old_slot.slot_id_size == current_slot.slot_id_size
        && memcmp(old_slot.slot_id, current_slot.slot_id,
            old_slot.slot_id_size) == 0);
    CHECK(old_slot.can_edit == current_slot.can_edit
        && old_slot.recovery_slot == current_slot.recovery_slot
        && old_slot.can_add_passwords == current_slot.can_add_passwords
        && old_slot.can_remove_passwords == current_slot.can_remove_passwords
        && old_slot.must_be_changed == current_slot.must_be_changed);
    CHECK(old_slot.identity_name_size == current_slot.identity_name_size
        && old_slot.identity_email_size == current_slot.identity_email_size);
    if (old_slot.identity_name_size != 0)
        CHECK(memcmp(old_slot.identity_name, current_slot.identity_name,
            old_slot.identity_name_size) == 0);
    if (old_slot.identity_email_size != 0)
        CHECK(memcmp(old_slot.identity_email, current_slot.identity_email,
            old_slot.identity_email_size) == 0);
    CHECK(scpefe_unlocked_container_work_journal_key(old,
        old_key, sizeof(old_key), &old_key_size) == SCPEFE_STATUS_OK);
    CHECK(scpefe_unlocked_container_work_journal_key(current,
        current_key, sizeof(current_key), &current_key_size) == SCPEFE_STATUS_OK);
    CHECK(old_key_size == current_key_size
        && memcmp(old_key, current_key, old_key_size) == 0);
    scpefe_unlocked_container_destroy(old);
    scpefe_unlocked_container_destroy(current);
    return 0;
}

static int preserves_all_access(const uint8_t *before, size_t before_size,
    const uint8_t *after, size_t after_size,
    const char *owner, const char *recovery, const char *invited)
{
    CHECK(same_access(before, before_size, after, after_size, owner) == 0);
    CHECK(same_access(before, before_size, after, after_size, recovery) == 0);
    CHECK(same_access(before, before_size, after, after_size, invited) == 0);
    return 0;
}

int main(void)
{
    static const char password[] = "owner passphrase with independent words";
    static const char recovery[] = "offline recovery passphrase is different";
    static const char temporary[] = "temporary invite passphrase with words";
    static const char invited[] = "claimed invite passphrase with words";
    const scpefe_new_document_v1 document = {
        sizeof(scpefe_new_document_v1),
        "Ada", 3, "ada@example.test", 16, "Desk", 4,
        "text", 4, 1000,
        (const uint8_t *)password, sizeof(password) - 1,
        (const uint8_t *)recovery, sizeof(recovery) - 1,
    };
    size_t original_size = 0;
    CHECK(scpefe_new_document_create(&document, NULL, 0, &original_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *original = (uint8_t *)malloc(original_size);
    CHECK(original != NULL);
    CHECK(scpefe_new_document_create(&document, original, original_size,
        &original_size) == SCPEFE_STATUS_OK);

    const scpefe_invitation_create_v1 invitation = {
        sizeof(invitation), original, original_size,
        (const uint8_t *)password, strlen(password),
        (const uint8_t *)temporary, strlen(temporary),
        0, 0, 0, "Reader", strlen("Reader"),
    };
    size_t invitation_size = 0;
    CHECK(scpefe_password_container_add_invitation(&invitation, NULL, 0,
        &invitation_size) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *with_invitation = (uint8_t *)malloc(invitation_size);
    CHECK(with_invitation != NULL);
    CHECK(scpefe_password_container_add_invitation(&invitation,
        with_invitation, invitation_size, &invitation_size) == SCPEFE_STATUS_OK);
    const scpefe_invitation_claim_v1 claim = {
        sizeof(claim), with_invitation, invitation_size,
        (const uint8_t *)temporary, strlen(temporary),
        (const uint8_t *)invited, strlen(invited),
        "Grace", strlen("Grace"), "grace@example.test", strlen("grace@example.test"),
    };
    size_t source_size = 0;
    CHECK(scpefe_password_container_claim_invitation(&claim, NULL, 0,
        &source_size) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *source = (uint8_t *)malloc(source_size);
    CHECK(source != NULL);
    CHECK(scpefe_password_container_claim_invitation(&claim,
        source, source_size, &source_size) == SCPEFE_STATUS_OK);

    uint8_t session[SCPEFE_LEASE_SESSION_ID_SIZE];
    memset(session, 0x5a, sizeof(session));
    scpefe_editing_lease_v1 lease = {
        sizeof(scpefe_editing_lease_v1), 1, session, sizeof(session),
        1, 2000, 600000,
        "Ada", 3, "ada@example.test", 16, "Desk", 4,
    };
    uint8_t *acquired = NULL;
    size_t acquired_size = 0;
    CHECK(update_lease(source, source_size, password, lease,
        &acquired, &acquired_size) == 0);
    CHECK(!contains(acquired, acquired_size, "ada@example.test"));
    CHECK(preserves_all_access(source, source_size, acquired, acquired_size,
        password, recovery, invited) == 0);

    scpefe_unlocked_container *unlocked = NULL;
    CHECK(scpefe_password_container_unlock(acquired, acquired_size,
        (const uint8_t *)password, strlen(password), &unlocked) == SCPEFE_STATUS_OK);
    scpefe_editing_lease_v1 view = {0};
    view.struct_size = sizeof(view);
    CHECK(scpefe_unlocked_container_editing_lease(unlocked, &view)
        == SCPEFE_STATUS_OK);
    CHECK(view.active == 1 && view.heartbeat_counter == 1);
    CHECK(view.duration_ms == 600000 && view.holder_utc_ms == 2000);
    CHECK(memcmp(view.session_id, session, sizeof(session)) == 0);
    CHECK(view.holder_name_size == 3 && memcmp(view.holder_name, "Ada", 3) == 0);
    scpefe_unlocked_container_destroy(unlocked);

    lease.heartbeat_counter = 2;
    lease.holder_utc_ms = 122000;
    lease.holder_name = "Grace";
    lease.holder_name_size = strlen("Grace");
    lease.holder_email = "grace@example.test";
    lease.holder_email_size = strlen("grace@example.test");
    uint8_t *refreshed = NULL;
    size_t refreshed_size = 0;
    CHECK(update_lease(acquired, acquired_size, password, lease,
        &refreshed, &refreshed_size) == 0);
    CHECK(preserves_all_access(acquired, acquired_size, refreshed, refreshed_size,
        password, recovery, invited) == 0);
    CHECK(scpefe_password_container_unlock(refreshed, refreshed_size,
        (const uint8_t *)invited, strlen(invited), &unlocked) == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    CHECK(scpefe_unlocked_container_editing_lease(unlocked, &view)
        == SCPEFE_STATUS_OK);
    CHECK(view.active == 1 && view.heartbeat_counter == 2);
    CHECK(view.holder_name_size == strlen("Grace")
        && memcmp(view.holder_name, "Grace", view.holder_name_size) == 0);
    scpefe_unlocked_container_destroy(unlocked);
    lease.active = 0;
    uint8_t *released = NULL;
    size_t released_size = 0;
    CHECK(update_lease(refreshed, refreshed_size, password, lease,
        &released, &released_size) == 0);
    CHECK(preserves_all_access(refreshed, refreshed_size, released, released_size,
        password, recovery, invited) == 0);
    CHECK(scpefe_password_container_unlock(released, released_size,
        (const uint8_t *)password, strlen(password), &unlocked) == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    CHECK(scpefe_unlocked_container_editing_lease(unlocked, &view)
        == SCPEFE_STATUS_OK);
    CHECK(view.active == 0 && view.heartbeat_counter == 2);
    scpefe_unlocked_container_destroy(unlocked);

    scpefe_editing_lease_update_v1 rejected = {
        sizeof(rejected), released, released_size,
        (const uint8_t *)"wrong password", strlen("wrong password"), lease,
    };
    size_t rejected_size = 0;
    CHECK(scpefe_editing_lease_update(&rejected, NULL, 0, &rejected_size)
        == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    uint8_t *tampered = (uint8_t *)malloc(released_size);
    CHECK(tampered != NULL);
    memcpy(tampered, released, released_size);
    tampered[released_size - 1] ^= 1;
    rejected.container = tampered;
    rejected.password = (const uint8_t *)password;
    rejected.password_size = strlen(password);
    CHECK(scpefe_editing_lease_update(&rejected, NULL, 0, &rejected_size)
        == SCPEFE_STATUS_AUTHENTICATION_FAILED);

    const scpefe_manual_save_v1 save = {
        sizeof(save), released, released_size,
        (const uint8_t *)password, strlen(password),
        "Ada", 3, "ada@example.test", strlen("ada@example.test"),
        "Desk", 4, "saved after lease changes", strlen("saved after lease changes"),
        123000,
    };
    size_t saved_size = 0;
    CHECK(scpefe_manual_save(&save, NULL, 0, &saved_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *saved = (uint8_t *)malloc(saved_size);
    CHECK(saved != NULL);
    CHECK(scpefe_manual_save(&save, saved, saved_size, &saved_size)
        == SCPEFE_STATUS_OK);
    const char *passwords[] = {password, recovery, invited};
    for (size_t index = 0; index < 3; ++index) {
        CHECK(scpefe_password_container_unlock(saved, saved_size,
            (const uint8_t *)passwords[index], strlen(passwords[index]),
            &unlocked) == SCPEFE_STATUS_OK);
        view.struct_size = sizeof(view);
        CHECK(scpefe_unlocked_container_editing_lease(unlocked, &view)
            == SCPEFE_STATUS_OK);
        CHECK(view.active == 0 && view.heartbeat_counter == 2);
        scpefe_unlocked_container_destroy(unlocked);
    }

    free(saved);
    free(tampered);
    free(released);
    free(refreshed);
    free(acquired);
    free(source);
    free(with_invitation);
    free(original);
    return 0;
}
