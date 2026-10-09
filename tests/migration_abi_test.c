#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int crypto_generichash(unsigned char *, size_t, const unsigned char *,
    unsigned long long, const unsigned char *, size_t);

#define CHECK(expression) do { \
    if (!(expression)) { \
        fprintf(stderr, "check failed at line %d: %s\n", __LINE__, #expression); \
        return 1; \
    } \
} while (0)

/* Loads the existing version-2 history fixture as container bytes. */
static uint8_t *read_legacy_fixture(const char *root, size_t *size)
{
    char path[1024];
    if (snprintf(path, sizeof(path),
        "%s/apps/windows/test/fixtures/password-container-v2-history-invitations.hex",
        root) >= (int)sizeof(path)) return NULL;
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

/* Verifies migration lineage, retained text, and a subsequent C ABI save. */
static int migration_round_trip(const char *root)
{
    static const char owner[] = "owner passphrase with independent words";
    static const char guest[] = "violet zeppelin compass orchid museum glacier";
    const uint8_t session[SCPEFE_LEASE_SESSION_ID_SIZE] = {0x7a};
    size_t legacy_size = 0;
    uint8_t *legacy = read_legacy_fixture(root, &legacy_size);
    CHECK(legacy != NULL && legacy_size != 0);

    scpefe_unlocked_container *before = NULL;
    scpefe_unlocked_container_v1 before_view = {0};
    scpefe_revision_limits_v1 limits = {0};
    limits.struct_size = sizeof(limits);
    CHECK(scpefe_revision_limits_default(&limits) == SCPEFE_STATUS_OK);
    CHECK(scpefe_password_container_unlock(legacy, legacy_size,
        (const uint8_t *)owner, sizeof(owner) - 1, &before) == SCPEFE_STATUS_OK);
    before_view.struct_size = sizeof(before_view);
    CHECK(scpefe_unlocked_container_view(before, &before_view) == SCPEFE_STATUS_OK);
    uint8_t previous_head[SCPEFE_REVISION_ID_SIZE];
    uint8_t document_id[SCPEFE_DOCUMENT_ID_SIZE];
    CHECK(crypto_generichash(previous_head, sizeof(previous_head),
        before_view.encoded_snapshot_revision,
        before_view.encoded_snapshot_revision_size, NULL, 0) == 0);
    scpefe_decoded_snapshot_revision *revision = NULL;
    scpefe_snapshot_revision_v1 view = {0};
    CHECK(scpefe_snapshot_revision_decode(before_view.encoded_snapshot_revision,
        before_view.encoded_snapshot_revision_size, &limits, &revision)
        == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    CHECK(scpefe_decoded_snapshot_revision_view(revision, &view) == SCPEFE_STATUS_OK);
    const size_t prior_ancestors = view.ancestor_count;
    scpefe_decoded_snapshot_revision_destroy(revision);
    memcpy(document_id, before_view.document_id, sizeof(document_id));
    scpefe_unlocked_container_destroy(before);

    scpefe_migration_v1 request = {
        sizeof(request), legacy, legacy_size,
        (const uint8_t *)owner, sizeof(owner) - 1,
        "Ada", 3, "ada@example.test", 16, "Current PC", 10, 2000,
        {sizeof(scpefe_editing_lease_v1), 1, session, sizeof(session),
            1, 2000, SCPEFE_DEFAULT_LEASE_DURATION_MS,
            "Ada", 3, "ada@example.test", 16, "Current PC", 10},
    };
    size_t migrated_size = 0;
    CHECK(scpefe_migrate_document(&request, NULL, 0, &migrated_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *migrated = (uint8_t *)malloc(migrated_size);
    CHECK(migrated != NULL);
    CHECK(scpefe_migrate_document(&request, migrated, migrated_size,
        &migrated_size) == SCPEFE_STATUS_OK);

    scpefe_unlocked_container *after = NULL;
    scpefe_unlocked_container_v1 after_view = {0};
    CHECK(scpefe_password_container_unlock(migrated, migrated_size,
        (const uint8_t *)owner, sizeof(owner) - 1, &after) == SCPEFE_STATUS_OK);
    after_view.struct_size = sizeof(after_view);
    CHECK(scpefe_unlocked_container_view(after, &after_view) == SCPEFE_STATUS_OK);
    CHECK(memcmp(after_view.document_id, document_id, sizeof(document_id)) == 0);
    CHECK(scpefe_snapshot_revision_decode(after_view.encoded_snapshot_revision,
        after_view.encoded_snapshot_revision_size, &limits, &revision)
        == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    CHECK(scpefe_decoded_snapshot_revision_view(revision, &view) == SCPEFE_STATUS_OK);
    CHECK(view.manually_sealed == 1 && view.parent_count == 1
        && view.ancestor_count == prior_ancestors + 1);
    CHECK(memcmp(view.parent_revision_ids, previous_head,
        sizeof(previous_head)) == 0);
    CHECK(view.content_size == strlen("third historical version")
        && memcmp(view.content, "third historical version", view.content_size) == 0);
    CHECK(view.event_type_size == strlen("format-migration")
        && memcmp(view.event_type, "format-migration", view.event_type_size) == 0);
    CHECK(view.event_detail_size == strlen("container-version-2-to-3")
        && memcmp(view.event_detail, "container-version-2-to-3",
            view.event_detail_size) == 0);
    CHECK(view.timestamp_ms == 2000
        && view.client_profile_name_size == 3
        && memcmp(view.client_profile_name, "Ada", 3) == 0
        && view.device_name_size == 10
        && memcmp(view.device_name, "Current PC", 10) == 0);
    CHECK(memcmp(view.ancestor_graph[view.ancestor_count - 1].revision_id,
        previous_head, sizeof(previous_head)) == 0);
    uint8_t migration_head[SCPEFE_REVISION_ID_SIZE];
    CHECK(crypto_generichash(migration_head, sizeof(migration_head),
        after_view.encoded_snapshot_revision,
        after_view.encoded_snapshot_revision_size, NULL, 0) == 0);
    scpefe_decoded_snapshot_revision_destroy(revision);
    scpefe_unlocked_container_destroy(after);

    const scpefe_manual_save_v1 save = {
        sizeof(save), migrated, migrated_size,
        (const uint8_t *)owner, sizeof(owner) - 1,
        "Ada", 3, "ada@example.test", 16, "Current PC", 10,
        "saved after migration", 21, 2500,
    };
    size_t saved_size = 0;
    CHECK(scpefe_manual_save(&save, NULL, 0, &saved_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *saved = (uint8_t *)malloc(saved_size);
    CHECK(saved != NULL);
    CHECK(scpefe_manual_save(&save, saved, saved_size, &saved_size)
        == SCPEFE_STATUS_OK);
    CHECK(scpefe_password_container_unlock(saved, saved_size,
        (const uint8_t *)owner, sizeof(owner) - 1, &after) == SCPEFE_STATUS_OK);
    after_view.struct_size = sizeof(after_view);
    CHECK(scpefe_unlocked_container_view(after, &after_view) == SCPEFE_STATUS_OK);
    CHECK(scpefe_snapshot_revision_decode(after_view.encoded_snapshot_revision,
        after_view.encoded_snapshot_revision_size, &limits, &revision)
        == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    CHECK(scpefe_decoded_snapshot_revision_view(revision, &view) == SCPEFE_STATUS_OK);
    CHECK(view.parent_count == 1 && view.ancestor_count == prior_ancestors + 2
        && view.manually_sealed == 1);
    CHECK(memcmp(view.parent_revision_ids, migration_head,
        sizeof(migration_head)) == 0);
    CHECK(view.content_size == strlen("saved after migration")
        && memcmp(view.content, "saved after migration", view.content_size) == 0);
    scpefe_decoded_snapshot_revision_destroy(revision);
    scpefe_unlocked_container_destroy(after);

    request.password = (const uint8_t *)guest;
    request.password_size = sizeof(guest) - 1;
    CHECK(scpefe_migrate_document(&request, NULL, 0, &migrated_size)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    request.password = (const uint8_t *)"wrong password";
    request.password_size = strlen("wrong password");
    CHECK(scpefe_migrate_document(&request, NULL, 0, &migrated_size)
        == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    request.password = (const uint8_t *)owner;
    request.password_size = sizeof(owner) - 1;
    request.container = migrated;
    request.container_size = migrated_size;
    CHECK(scpefe_migrate_document(&request, NULL, 0, &migrated_size)
        == SCPEFE_STATUS_UNSUPPORTED_FORMAT);

    free(saved);
    free(migrated);
    free(legacy);
    return 0;
}

/* Verifies malformed migration arguments and the full migration path. */
int main(int argc, char **argv)
{
    const uint8_t container[] = {0};
    const uint8_t password[] = {'p'};
    const uint8_t session[SCPEFE_LEASE_SESSION_ID_SIZE] = {0};
    const char invalid_utf8[] = {(char)0xff};
    const char text[] = "Ada";
    size_t output_size = 0;
    scpefe_migration_v1 migration = {
        sizeof(migration), container, sizeof(container), password, sizeof(password),
        text, 3, text, 3, text, 3, 1,
        {sizeof(scpefe_editing_lease_v1), 1, session, sizeof(session), 1, 1,
            600000, text, 3, text, 3, text, 3}
    };

    migration.lease.holder_name = NULL;
    CHECK(scpefe_migrate_document(&migration, NULL, 0, &output_size)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    migration.lease.holder_name = text;

    migration.lease.holder_email = invalid_utf8;
    migration.lease.holder_email_size = sizeof(invalid_utf8);
    CHECK(scpefe_migrate_document(&migration, NULL, 0, &output_size)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    migration.lease.holder_email = text;
    migration.lease.holder_email_size = 3;

    migration.lease.device_name_size = 4097;
    CHECK(scpefe_migrate_document(&migration, NULL, 0, &output_size)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    CHECK(argc == 2);
    CHECK(migration_round_trip(argv[1]) == 0);
    return 0;
}
