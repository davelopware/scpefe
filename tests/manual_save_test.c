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
    CHECK(revision_view.ancestor_count == 1);
    CHECK(memcmp(revision_view.ancestor_graph[0].revision_id,
        revision_view.parent_revision_ids, SCPEFE_REVISION_ID_SIZE) == 0);
    CHECK(revision_view.ancestor_graph[0].parent_count == 0);
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

    static const char temporary[] = "temporary invite passphrase with words";
    static const char invited[] = "claimed invite passphrase with words";
    const scpefe_invitation_create_v1 invitation = {
        sizeof(invitation), container, container_size,
        (const uint8_t *)owner, sizeof(owner) - 1,
        (const uint8_t *)temporary, sizeof(temporary) - 1,
        1, 0, 0, "Colleague", strlen("Colleague"),
    };
    size_t invited_size = 0;
    CHECK(scpefe_password_container_add_invitation(&invitation, NULL, 0,
        &invited_size) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *with_invitation = (uint8_t *)malloc(invited_size);
    CHECK(with_invitation != NULL);
    CHECK(scpefe_password_container_add_invitation(&invitation,
        with_invitation, invited_size, &invited_size) == SCPEFE_STATUS_OK);
    const scpefe_invitation_claim_v1 claim = {
        sizeof(claim), with_invitation, invited_size,
        (const uint8_t *)temporary, sizeof(temporary) - 1,
        (const uint8_t *)invited, sizeof(invited) - 1,
        "Colleague", strlen("Colleague"),
        "colleague@example.test", strlen("colleague@example.test"),
    };
    size_t claimed_size = 0;
    CHECK(scpefe_password_container_claim_invitation(&claim, NULL, 0,
        &claimed_size) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *claimed = (uint8_t *)malloc(claimed_size);
    CHECK(claimed != NULL);
    CHECK(scpefe_password_container_claim_invitation(&claim,
        claimed, claimed_size, &claimed_size) == SCPEFE_STATUS_OK);
    uint8_t session[SCPEFE_LEASE_SESSION_ID_SIZE];
    memset(session, 0x5a, sizeof(session));
    const scpefe_editing_lease_update_v1 lease_update = {
        sizeof(lease_update), claimed, claimed_size,
        (const uint8_t *)owner, sizeof(owner) - 1,
        {sizeof(scpefe_editing_lease_v1), 1, session, sizeof(session),
            7, 1726747250000u, 600000,
            "Ada", 3, "ada@example.test", strlen("ada@example.test"),
            "Ada's PC", strlen("Ada's PC")},
    };
    size_t source_size = 0;
    CHECK(scpefe_editing_lease_update(&lease_update, NULL, 0, &source_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *source = (uint8_t *)malloc(source_size);
    CHECK(source != NULL);
    CHECK(scpefe_editing_lease_update(&lease_update, source, source_size,
        &source_size) == SCPEFE_STATUS_OK);

    const scpefe_manual_save_v1 save = {
        sizeof(scpefe_manual_save_v1), source, source_size,
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
    memset(saved, 0x5a, saved_size);
    size_t required_size = 0;
    CHECK(scpefe_manual_save(&save, saved, saved_size - 1, &required_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    CHECK(required_size == saved_size);
    for (size_t index = 0; index < saved_size; ++index)
        CHECK(saved[index] == 0x5a);
    CHECK(scpefe_manual_save(&save, saved, saved_size, &saved_size)
        == SCPEFE_STATUS_OK);
    CHECK(inspect_saved(saved, saved_size, owner, document_id, slot_id, 1) == 0);
    CHECK(inspect_saved(saved, saved_size, recovery, document_id, slot_id, 0) == 0);
    CHECK(inspect_saved(saved, saved_size, invited, document_id, slot_id, 0) == 0);

    CHECK(scpefe_password_container_unlock(saved, saved_size,
        (const uint8_t *)owner, sizeof(owner) - 1, &unlocked)
        == SCPEFE_STATUS_OK);
    scpefe_editing_lease_v1 lease_view = {0};
    lease_view.struct_size = sizeof(lease_view);
    CHECK(scpefe_unlocked_container_editing_lease(unlocked, &lease_view)
        == SCPEFE_STATUS_OK);
    CHECK(lease_view.active == 1 && lease_view.heartbeat_counter == 7);
    CHECK(lease_view.holder_utc_ms == 1726747250000u);
    CHECK(memcmp(lease_view.session_id, session, sizeof(session)) == 0);
    CHECK(lease_view.holder_name_size == 3
        && memcmp(lease_view.holder_name, "Ada", 3) == 0);
    CHECK(lease_view.holder_email_size == strlen("ada@example.test")
        && memcmp(lease_view.holder_email, "ada@example.test",
            lease_view.holder_email_size) == 0);
    CHECK(lease_view.device_name_size == strlen("Ada's PC")
        && memcmp(lease_view.device_name, "Ada's PC",
            lease_view.device_name_size) == 0);
    size_t managed_count = 0;
    CHECK(scpefe_unlocked_container_managed_slot_count(unlocked, &managed_count)
        == SCPEFE_STATUS_OK);
    CHECK(managed_count == 1);
    scpefe_managed_slot_v1 managed = {0};
    managed.struct_size = sizeof(managed);
    CHECK(scpefe_unlocked_container_managed_slot(unlocked, 0, &managed)
        == SCPEFE_STATUS_OK);
    CHECK(managed.permissions_known == 1 && managed.can_edit == 1);
    CHECK(managed.identity_known == 1 && managed.must_be_changed == 0);
    CHECK(managed.identity_name_size == strlen("Colleague"));
    CHECK(memcmp(managed.identity_name, "Colleague",
        managed.identity_name_size) == 0);
    scpefe_unlocked_container_destroy(unlocked);

    scpefe_manual_save_v1 invalid_save = save;
    static const char wrong[] = "wrong passphrase with independent words";
    memset(saved, 0x3c, saved_size);
    invalid_save.password = (const uint8_t *)wrong;
    invalid_save.password_size = sizeof(wrong) - 1;
    CHECK(scpefe_manual_save(&invalid_save, saved, saved_size, &required_size)
        == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    uint8_t *corrupt = (uint8_t *)malloc(source_size);
    CHECK(corrupt != NULL);
    memcpy(corrupt, source, source_size);
    corrupt[source_size - 1] ^= 1;
    invalid_save = save;
    invalid_save.container = corrupt;
    CHECK(scpefe_manual_save(&invalid_save, saved, saved_size, &required_size)
        == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    invalid_save = save;
    invalid_save.container_size = source_size - 1;
    CHECK(scpefe_manual_save(&invalid_save, saved, saved_size, &required_size)
        == SCPEFE_STATUS_MALFORMED_CONTAINER);
    for (size_t index = 0; index < saved_size; ++index)
        CHECK(saved[index] == 0x3c);

    free(corrupt);
    free(source);
    free(claimed);
    free(with_invitation);
    free(saved);
    free(container);
    return 0;
}
