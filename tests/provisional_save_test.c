#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)

extern int crypto_generichash(unsigned char *, size_t, const unsigned char *,
    unsigned long long, const unsigned char *, size_t);

static int head_id(const uint8_t *container, size_t container_size,
    const char *password, uint8_t id[SCPEFE_REVISION_ID_SIZE])
{
    scpefe_unlocked_container *unlocked = NULL;
    scpefe_unlocked_container_v1 view = {0};
    CHECK(scpefe_password_container_unlock(container, container_size,
        (const uint8_t *)password, strlen(password), &unlocked) == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    CHECK(scpefe_unlocked_container_view(unlocked, &view) == SCPEFE_STATUS_OK);
    CHECK(crypto_generichash(id, SCPEFE_REVISION_ID_SIZE,
        view.encoded_snapshot_revision, view.encoded_snapshot_revision_size,
        NULL, 0) == 0);
    scpefe_unlocked_container_destroy(unlocked);
    return 0;
}

static int open_revision(const uint8_t *container, size_t container_size,
    const char *password, scpefe_unlocked_container **unlocked,
    scpefe_decoded_snapshot_revision **revision, scpefe_snapshot_revision_v1 *view)
{
    scpefe_unlocked_container_v1 unlocked_view = {0};
    scpefe_revision_limits_v1 limits = {0};
    CHECK(scpefe_password_container_unlock(container, container_size,
        (const uint8_t *)password, strlen(password), unlocked) == SCPEFE_STATUS_OK);
    unlocked_view.struct_size = sizeof(unlocked_view);
    CHECK(scpefe_unlocked_container_view(*unlocked, &unlocked_view) == SCPEFE_STATUS_OK);
    limits.struct_size = sizeof(limits);
    CHECK(scpefe_revision_limits_default(&limits) == SCPEFE_STATUS_OK);
    CHECK(scpefe_snapshot_revision_decode(unlocked_view.encoded_snapshot_revision,
        unlocked_view.encoded_snapshot_revision_size, &limits, revision)
        == SCPEFE_STATUS_OK);
    view->struct_size = sizeof(*view);
    CHECK(scpefe_decoded_snapshot_revision_view(*revision, view) == SCPEFE_STATUS_OK);
    return 0;
}

static int inspect(const uint8_t *container, size_t container_size,
    const char *password, const char *content, int sealed,
    size_t parents, size_t ancestors, const uint8_t *sealed_base_id,
    const char *profile_name, uint64_t timestamp_ms)
{
    scpefe_unlocked_container *unlocked = NULL;
    scpefe_decoded_snapshot_revision *revision = NULL;
    scpefe_snapshot_revision_v1 view = {0};
    CHECK(open_revision(container, container_size, password,
        &unlocked, &revision, &view) == 0);
    CHECK(view.manually_sealed == sealed);
    CHECK(view.parent_count == parents);
    CHECK(view.ancestor_count == ancestors);
    CHECK(view.format_version == 1);
    CHECK(view.content_size == strlen(content));
    CHECK(memcmp(view.content, content, view.content_size) == 0);
    uint8_t expected_content_hash[SCPEFE_REVISION_ID_SIZE];
    CHECK(crypto_generichash(expected_content_hash, sizeof(expected_content_hash),
        (const uint8_t *)content, strlen(content), NULL, 0) == 0);
    CHECK(view.content_hash_size == sizeof(expected_content_hash));
    CHECK(memcmp(view.content_hash, expected_content_hash,
        sizeof(expected_content_hash)) == 0);
    CHECK((view.provisional_base_revision_size == 0) == sealed);
    CHECK(view.timestamp_ms == timestamp_ms);
    CHECK(view.client_profile_name_size == strlen(profile_name));
    CHECK(memcmp(view.client_profile_name, profile_name,
        view.client_profile_name_size) == 0);
    CHECK(view.client_profile_email_size == strlen("ada@example.test"));
    CHECK(memcmp(view.client_profile_email, "ada@example.test",
        view.client_profile_email_size) == 0);
    CHECK(view.slot_identity_name_size == 3);
    CHECK(memcmp(view.slot_identity_name, "Ada", 3) == 0);
    if (sealed_base_id != NULL) {
        CHECK(view.parent_count == 1 && view.ancestor_count == 1);
        CHECK(memcmp(view.parent_revision_ids, sealed_base_id,
            SCPEFE_REVISION_ID_SIZE) == 0);
        CHECK(memcmp(view.ancestor_graph[0].revision_id, sealed_base_id,
            SCPEFE_REVISION_ID_SIZE) == 0);
        CHECK(view.ancestor_graph[0].parent_count == 0);
        if (!sealed) {
            scpefe_decoded_snapshot_revision *base_revision = NULL;
            scpefe_snapshot_revision_v1 base_view = {0};
            scpefe_revision_limits_v1 limits = {0};
            limits.struct_size = sizeof(limits);
            CHECK(scpefe_revision_limits_default(&limits) == SCPEFE_STATUS_OK);
            CHECK(scpefe_snapshot_revision_decode(view.provisional_base_revision,
                view.provisional_base_revision_size, &limits, &base_revision)
                == SCPEFE_STATUS_OK);
            base_view.struct_size = sizeof(base_view);
            CHECK(scpefe_decoded_snapshot_revision_view(base_revision, &base_view)
                == SCPEFE_STATUS_OK);
            CHECK(base_view.manually_sealed == 1);
            CHECK(base_view.content_size == strlen("sealed base"));
            CHECK(memcmp(base_view.content, "sealed base", base_view.content_size) == 0);
            scpefe_decoded_snapshot_revision_destroy(base_revision);
        }
    }
    scpefe_decoded_snapshot_revision_destroy(revision);
    scpefe_unlocked_container_destroy(unlocked);
    return 0;
}

static int run_save(scpefe_status (*operation)(const scpefe_regular_save_v1 *,
        uint8_t *, size_t, size_t *),
    const scpefe_regular_save_v1 *save, uint8_t **output, size_t *output_size)
{
    CHECK(operation(save, NULL, 0, output_size) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    *output = (uint8_t *)malloc(*output_size);
    CHECK(*output != NULL);
    CHECK(operation(save, *output, *output_size, output_size) == SCPEFE_STATUS_OK);
    return 0;
}

int main(void)
{
    static const char password[] = "owner passphrase with independent words";
    const scpefe_new_document_v1 document = {
        sizeof(scpefe_new_document_v1),
        "Ada", 3, "ada@example.test", 16, "Ada PC", 6,
        "sealed base", 11, 1000,
        (const uint8_t *)password, sizeof(password) - 1, NULL, 0,
    };
    size_t base_size = 0;
    CHECK(scpefe_new_document_create(&document, NULL, 0, &base_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *base = (uint8_t *)malloc(base_size);
    CHECK(base != NULL);
    CHECK(scpefe_new_document_create(&document, base, base_size, &base_size)
        == SCPEFE_STATUS_OK);
    uint8_t base_id[SCPEFE_REVISION_ID_SIZE];
    uint8_t first_id[SCPEFE_REVISION_ID_SIZE];
    uint8_t second_id[SCPEFE_REVISION_ID_SIZE];
    CHECK(head_id(base, base_size, password, base_id) == 0);
    size_t rejected_size = 0;
    CHECK(scpefe_provisional_save_discard(base, base_size,
        (const uint8_t *)password, sizeof(password) - 1,
        NULL, 0, &rejected_size) == SCPEFE_STATUS_INVALID_ARGUMENT);

    const scpefe_regular_save_v1 first_save = {
        sizeof(scpefe_regular_save_v1), base, base_size,
        (const uint8_t *)password, sizeof(password) - 1,
        "Ada", 3, "ada@example.test", 16, "Ada PC", 6,
        "first provisional", 17, 2000,
    };
    uint8_t *first = NULL;
    size_t first_size = 0;
    CHECK(run_save(scpefe_regular_save, &first_save, &first, &first_size) == 0);
    CHECK(inspect(first, first_size, password, "first provisional", 0, 1, 1,
        base_id, "Ada", 2000) == 0);
    CHECK(head_id(first, first_size, password, first_id) == 0);

    scpefe_regular_save_v1 second_save = first_save;
    second_save.container = first;
    second_save.container_size = first_size;
    second_save.content = "second provisional";
    second_save.content_size = 18;
    second_save.profile_name = "Grace";
    second_save.profile_name_size = 5;
    second_save.timestamp_ms = 3000;
    uint8_t *second = NULL;
    size_t second_size = 0;
    CHECK(run_save(scpefe_regular_save, &second_save, &second, &second_size) == 0);
    CHECK(inspect(second, second_size, password, "second provisional", 0, 1, 1,
        base_id, "Grace", 3000) == 0);
    CHECK(head_id(second, second_size, password, second_id) == 0);
    CHECK(memcmp(first_id, second_id, sizeof(first_id)) != 0);
    CHECK(memcmp(second_id, base_id, sizeof(second_id)) != 0);

    /* A provisional revision cannot itself serve as a provisional base. */
    scpefe_unlocked_container *first_unlocked = NULL;
    scpefe_unlocked_container *second_unlocked = NULL;
    scpefe_unlocked_container_v1 first_container_view = {0};
    scpefe_unlocked_container_v1 second_container_view = {0};
    scpefe_decoded_snapshot_revision *second_revision = NULL;
    scpefe_snapshot_revision_v1 invalid_revision = {0};
    scpefe_revision_limits_v1 limits = {0};
    CHECK(scpefe_password_container_unlock(first, first_size,
        (const uint8_t *)password, sizeof(password) - 1,
        &first_unlocked) == SCPEFE_STATUS_OK);
    CHECK(scpefe_password_container_unlock(second, second_size,
        (const uint8_t *)password, sizeof(password) - 1,
        &second_unlocked) == SCPEFE_STATUS_OK);
    first_container_view.struct_size = sizeof(first_container_view);
    second_container_view.struct_size = sizeof(second_container_view);
    CHECK(scpefe_unlocked_container_view(first_unlocked, &first_container_view)
        == SCPEFE_STATUS_OK);
    CHECK(scpefe_unlocked_container_view(second_unlocked, &second_container_view)
        == SCPEFE_STATUS_OK);
    limits.struct_size = sizeof(limits);
    CHECK(scpefe_revision_limits_default(&limits) == SCPEFE_STATUS_OK);
    CHECK(scpefe_snapshot_revision_decode(
        second_container_view.encoded_snapshot_revision,
        second_container_view.encoded_snapshot_revision_size, &limits,
        &second_revision) == SCPEFE_STATUS_OK);
    invalid_revision.struct_size = sizeof(invalid_revision);
    CHECK(scpefe_decoded_snapshot_revision_view(second_revision,
        &invalid_revision) == SCPEFE_STATUS_OK);
    invalid_revision.provisional_base_revision =
        first_container_view.encoded_snapshot_revision;
    invalid_revision.provisional_base_revision_size =
        first_container_view.encoded_snapshot_revision_size;
    size_t invalid_encoded_size = 0;
    CHECK(scpefe_snapshot_revision_encode(&invalid_revision, &limits,
        NULL, 0, &invalid_encoded_size) == SCPEFE_STATUS_INVALID_ARGUMENT);
    scpefe_decoded_snapshot_revision_destroy(second_revision);
    scpefe_unlocked_container_destroy(second_unlocked);
    scpefe_unlocked_container_destroy(first_unlocked);

    size_t discarded_size = 0;
    CHECK(scpefe_provisional_save_discard(second, second_size,
        (const uint8_t *)password, sizeof(password) - 1, NULL, 0,
        &discarded_size) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *discarded = (uint8_t *)malloc(discarded_size);
    CHECK(discarded != NULL);
    CHECK(scpefe_provisional_save_discard(second, second_size,
        (const uint8_t *)password, sizeof(password) - 1,
        discarded, discarded_size, &discarded_size) == SCPEFE_STATUS_OK);
    CHECK(inspect(discarded, discarded_size, password, "sealed base", 1, 0, 0,
        NULL, "Ada", 1000) == 0);
    uint8_t discarded_id[SCPEFE_REVISION_ID_SIZE];
    CHECK(head_id(discarded, discarded_size, password, discarded_id) == 0);
    CHECK(memcmp(discarded_id, base_id, sizeof(base_id)) == 0);

    const scpefe_manual_save_v1 manual = {
        sizeof(scpefe_manual_save_v1), second, second_size,
        (const uint8_t *)password, sizeof(password) - 1,
        "Grace", 5, "ada@example.test", 16, "Grace PC", 8,
        "second provisional", 18, 4000,
    };
    size_t sealed_size = 0;
    CHECK(scpefe_manual_save(&manual, NULL, 0, &sealed_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *sealed = (uint8_t *)malloc(sealed_size);
    CHECK(sealed != NULL);
    CHECK(scpefe_manual_save(&manual, sealed, sealed_size, &sealed_size)
        == SCPEFE_STATUS_OK);
    CHECK(inspect(sealed, sealed_size, password, "second provisional", 1, 1, 1,
        base_id, "Grace", 4000) == 0);
    uint8_t sealed_id[SCPEFE_REVISION_ID_SIZE];
    CHECK(head_id(sealed, sealed_size, password, sealed_id) == 0);
    CHECK(memcmp(sealed_id, second_id, sizeof(sealed_id)) != 0);
    CHECK(scpefe_provisional_save_discard(sealed, sealed_size,
        (const uint8_t *)password, sizeof(password) - 1,
        NULL, 0, &discarded_size) == SCPEFE_STATUS_INVALID_ARGUMENT);

    scpefe_regular_save_v1 next_save = second_save;
    next_save.container = sealed;
    next_save.container_size = sealed_size;
    next_save.content = "next provisional";
    next_save.content_size = 16;
    next_save.timestamp_ms = 5000;
    uint8_t *next = NULL;
    size_t next_size = 0;
    CHECK(run_save(scpefe_regular_save, &next_save, &next, &next_size) == 0);
    scpefe_unlocked_container *next_unlocked = NULL;
    scpefe_decoded_snapshot_revision *next_revision = NULL;
    scpefe_snapshot_revision_v1 next_view = {0};
    CHECK(open_revision(next, next_size, password, &next_unlocked,
        &next_revision, &next_view) == 0);
    CHECK(next_view.manually_sealed == 0);
    CHECK(next_view.parent_count == 1 && next_view.ancestor_count == 2);
    CHECK(memcmp(next_view.parent_revision_ids, sealed_id,
        SCPEFE_REVISION_ID_SIZE) == 0);
    CHECK(memcmp(next_view.ancestor_graph[0].revision_id, base_id,
        SCPEFE_REVISION_ID_SIZE) == 0);
    CHECK(memcmp(next_view.ancestor_graph[1].revision_id, sealed_id,
        SCPEFE_REVISION_ID_SIZE) == 0);
    CHECK(next_view.ancestor_graph[1].parent_count == 1);
    CHECK(memcmp(next_view.ancestor_graph[1].parent_revision_ids, base_id,
        SCPEFE_REVISION_ID_SIZE) == 0);
    CHECK(next_view.content_size == 16);
    CHECK(memcmp(next_view.content, "next provisional", 16) == 0);
    scpefe_decoded_snapshot_revision_destroy(next_revision);
    scpefe_unlocked_container_destroy(next_unlocked);

    size_t restored_size = 0;
    CHECK(scpefe_provisional_save_discard(next, next_size,
        (const uint8_t *)password, sizeof(password) - 1,
        NULL, 0, &restored_size) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *restored = (uint8_t *)malloc(restored_size);
    CHECK(restored != NULL);
    CHECK(scpefe_provisional_save_discard(next, next_size,
        (const uint8_t *)password, sizeof(password) - 1,
        restored, restored_size, &restored_size) == SCPEFE_STATUS_OK);
    uint8_t restored_id[SCPEFE_REVISION_ID_SIZE];
    CHECK(head_id(restored, restored_size, password, restored_id) == 0);
    CHECK(memcmp(restored_id, sealed_id, sizeof(sealed_id)) == 0);

    scpefe_regular_save_v1 invalid = second_save;
    invalid.content = "bad\rtext";
    invalid.content_size = 8;
    CHECK(scpefe_regular_save(&invalid, NULL, 0, &discarded_size)
        == SCPEFE_STATUS_INVALID_ARGUMENT);

    free(restored); free(next); free(sealed); free(discarded);
    free(second); free(first); free(base);
    return 0;
}
