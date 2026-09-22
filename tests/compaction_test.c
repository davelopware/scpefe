#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

int crypto_generichash(unsigned char *, size_t, const unsigned char *,
    unsigned long long, const unsigned char *, size_t);

#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)

static int rewrite_lease(const uint8_t *container, size_t container_size,
    const char *password, const uint8_t session[SCPEFE_LEASE_SESSION_ID_SIZE],
    uint8_t **result, size_t *result_size)
{
    const scpefe_editing_lease_v1 lease = {
        sizeof(lease), 1, session, SCPEFE_LEASE_SESSION_ID_SIZE,
        7, 2000, SCPEFE_DEFAULT_LEASE_DURATION_MS,
        "Ada", 3, "ada@example.test", 16, "Desk", 4,
    };
    const scpefe_editing_lease_update_v1 update = {
        sizeof(update), container, container_size,
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

int main(void)
{
    static const char owner[] = "owner passphrase with independent words";
    static const char recovery[] = "offline recovery passphrase is different";
    const scpefe_new_document_v1 document = {
        sizeof(document), "Ada", 3, "ada@example.test", 16, "Desk", 4,
        "initial", 7, 1000,
        (const uint8_t *)owner, sizeof(owner) - 1,
        (const uint8_t *)recovery, sizeof(recovery) - 1,
    };
    size_t original_size = 0;
    CHECK(scpefe_new_document_create(&document, NULL, 0, &original_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *original = (uint8_t *)malloc(original_size);
    CHECK(original != NULL);
    CHECK(scpefe_new_document_create(&document, original, original_size,
        &original_size) == SCPEFE_STATUS_OK);

    const scpefe_manual_save_v1 save = {
        sizeof(save), original, original_size,
        (const uint8_t *)owner, sizeof(owner) - 1,
        "Ada", 3, "ada@example.test", 16, "Desk", 4,
        "current text", 12, 3000,
    };
    size_t saved_size = 0;
    CHECK(scpefe_manual_save(&save, NULL, 0, &saved_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *saved = (uint8_t *)malloc(saved_size);
    CHECK(saved != NULL);
    CHECK(scpefe_manual_save(&save, saved, saved_size, &saved_size)
        == SCPEFE_STATUS_OK);

    uint8_t session[SCPEFE_LEASE_SESSION_ID_SIZE];
    memset(session, 0x6b, sizeof(session));
    uint8_t *leased = NULL;
    size_t leased_size = 0;
    CHECK(rewrite_lease(saved, saved_size, owner, session,
        &leased, &leased_size) == 0);

    scpefe_unlocked_container *before = NULL;
    scpefe_unlocked_container_v1 before_view = {0};
    CHECK(scpefe_password_container_unlock(leased, leased_size,
        (const uint8_t *)owner, sizeof(owner) - 1, &before) == SCPEFE_STATUS_OK);
    before_view.struct_size = sizeof(before_view);
    CHECK(scpefe_unlocked_container_view(before, &before_view) == SCPEFE_STATUS_OK);
    uint8_t document_id[SCPEFE_DOCUMENT_ID_SIZE];
    uint8_t previous_head[SCPEFE_REVISION_ID_SIZE];
    memcpy(document_id, before_view.document_id, sizeof(document_id));
    CHECK(crypto_generichash(previous_head, sizeof(previous_head),
        before_view.encoded_snapshot_revision,
        before_view.encoded_snapshot_revision_size, NULL, 0) == 0);
    scpefe_unlocked_container_destroy(before);

    scpefe_compaction_v1 request = {
        sizeof(request), leased, leased_size,
        (const uint8_t *)owner, sizeof(owner) - 1,
        session, sizeof(session), 7,
    };
    size_t compacted_size = 0;
    CHECK(scpefe_compact_document(&request, NULL, 0, &compacted_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *compacted = (uint8_t *)malloc(compacted_size);
    CHECK(compacted != NULL);
    CHECK(scpefe_compact_document(&request, compacted, compacted_size,
        &compacted_size) == SCPEFE_STATUS_OK);

    scpefe_unlocked_container *after = NULL;
    scpefe_unlocked_container_v1 after_view = {0};
    scpefe_unlocked_slot_access_v1 access = {0};
    CHECK(scpefe_password_container_unlock(compacted, compacted_size,
        (const uint8_t *)recovery, sizeof(recovery) - 1, &after) == SCPEFE_STATUS_OK);
    after_view.struct_size = sizeof(after_view);
    access.struct_size = sizeof(access);
    CHECK(scpefe_unlocked_container_view(after, &after_view) == SCPEFE_STATUS_OK);
    CHECK(scpefe_unlocked_container_slot_access(after, &access) == SCPEFE_STATUS_OK);
    CHECK(memcmp(after_view.document_id, document_id, sizeof(document_id)) == 0);
    CHECK(access.recovery_slot == 1 && access.can_add_passwords == 1
        && access.can_remove_passwords == 1);

    scpefe_revision_limits_v1 limits = {0};
    scpefe_decoded_snapshot_revision *revision = NULL;
    scpefe_snapshot_revision_v1 view = {0};
    limits.struct_size = sizeof(limits);
    CHECK(scpefe_revision_limits_default(&limits) == SCPEFE_STATUS_OK);
    CHECK(scpefe_snapshot_revision_decode(after_view.encoded_snapshot_revision,
        after_view.encoded_snapshot_revision_size, &limits, &revision)
        == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    CHECK(scpefe_decoded_snapshot_revision_view(revision, &view) == SCPEFE_STATUS_OK);
    CHECK(view.manually_sealed == 1 && view.parent_count == 1
        && view.ancestor_count == 0);
    CHECK(memcmp(view.parent_revision_ids, previous_head,
        sizeof(previous_head)) == 0);
    CHECK(view.content_size == 12
        && memcmp(view.content, "current text", 12) == 0);
    scpefe_decoded_snapshot_revision_destroy(revision);
    scpefe_unlocked_container_destroy(after);

    request.password = (const uint8_t *)recovery;
    request.password_size = sizeof(recovery) - 1;
    CHECK(scpefe_compact_document(&request, NULL, 0, &compacted_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    request.password = (const uint8_t *)owner;
    request.password_size = sizeof(owner) - 1;
    request.lease_heartbeat_counter = 8;
    CHECK(scpefe_compact_document(&request, NULL, 0, &compacted_size)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    const scpefe_regular_save_v1 regular = {
        sizeof(regular), leased, leased_size,
        (const uint8_t *)owner, sizeof(owner) - 1,
        "Ada", 3, "ada@example.test", 16, "Desk", 4,
        "provisional text", 16, 4000,
    };
    size_t provisional_size = 0;
    CHECK(scpefe_regular_save(&regular, NULL, 0, &provisional_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *provisional = (uint8_t *)malloc(provisional_size);
    CHECK(provisional != NULL);
    CHECK(scpefe_regular_save(&regular, provisional, provisional_size,
        &provisional_size) == SCPEFE_STATUS_OK);
    request.container = provisional;
    request.container_size = provisional_size;
    request.lease_heartbeat_counter = 7;
    CHECK(scpefe_compact_document(&request, NULL, 0, &compacted_size)
        == SCPEFE_STATUS_INVALID_ARGUMENT);

    free(provisional);
    free(compacted);
    free(leased);
    free(saved);
    free(original);
    return 0;
}
