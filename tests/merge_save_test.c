#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)

static int save_branch(const uint8_t *base, size_t base_size, const char *password,
    const char *content, uint64_t timestamp, uint8_t **output, size_t *output_size)
{
    const scpefe_manual_save_v1 save = {
        sizeof(save), base, base_size, (const uint8_t *)password, strlen(password),
        "Ada", 3, "ada@example.test", 16, "Desk", 4,
        content, strlen(content), timestamp,
    };
    CHECK(scpefe_manual_save(&save, NULL, 0, output_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    *output = (uint8_t *)malloc(*output_size);
    CHECK(*output != NULL);
    CHECK(scpefe_manual_save(&save, *output, *output_size, output_size)
        == SCPEFE_STATUS_OK);
    return 0;
}

int main(void)
{
    static const char password[] = "owner passphrase with independent words";
    const scpefe_new_document_v1 document = {
        sizeof(document), "Ada", 3, "ada@example.test", 16, "Desk", 4,
        "base", 4, 1, (const uint8_t *)password, sizeof(password) - 1,
        NULL, 0,
    };
    size_t base_size = 0;
    CHECK(scpefe_new_document_create(&document, NULL, 0, &base_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *base = (uint8_t *)malloc(base_size);
    CHECK(base != NULL);
    CHECK(scpefe_new_document_create(&document, base, base_size, &base_size)
        == SCPEFE_STATUS_OK);
    uint8_t *local = NULL;
    uint8_t *current = NULL;
    size_t local_size = 0;
    size_t current_size = 0;
    CHECK(save_branch(base, base_size, password, "local", 2,
        &local, &local_size) == 0);
    CHECK(save_branch(base, base_size, password, "current", 3,
        &current, &current_size) == 0);

    const scpefe_merge_save_v1 merge = {
        sizeof(merge), current, current_size, local, local_size,
        (const uint8_t *)password, sizeof(password) - 1,
        "Ada", 3, "ada@example.test", 16, "Desk", 4,
        "resolved", 8, 4,
    };
    size_t merged_size = 0;
    CHECK(scpefe_merge_save(&merge, NULL, 0, &merged_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *merged = (uint8_t *)malloc(merged_size);
    CHECK(merged != NULL);
    CHECK(scpefe_merge_save(&merge, merged, merged_size, &merged_size)
        == SCPEFE_STATUS_OK);

    scpefe_unlocked_container *unlocked = NULL;
    scpefe_unlocked_container_v1 container_view = {0};
    scpefe_decoded_snapshot_revision *revision = NULL;
    scpefe_snapshot_revision_v1 revision_view = {0};
    scpefe_revision_limits_v1 limits = {0};
    CHECK(scpefe_password_container_unlock(merged, merged_size,
        (const uint8_t *)password, sizeof(password) - 1, &unlocked)
        == SCPEFE_STATUS_OK);
    container_view.struct_size = sizeof(container_view);
    CHECK(scpefe_unlocked_container_view(unlocked, &container_view)
        == SCPEFE_STATUS_OK);
    limits.struct_size = sizeof(limits);
    CHECK(scpefe_revision_limits_default(&limits) == SCPEFE_STATUS_OK);
    CHECK(scpefe_snapshot_revision_decode(container_view.encoded_snapshot_revision,
        container_view.encoded_snapshot_revision_size, &limits, &revision)
        == SCPEFE_STATUS_OK);
    revision_view.struct_size = sizeof(revision_view);
    CHECK(scpefe_decoded_snapshot_revision_view(revision, &revision_view)
        == SCPEFE_STATUS_OK);
    CHECK(revision_view.parent_count == 2);
    CHECK(revision_view.ancestor_count == 3);
    CHECK(revision_view.content_size == 8);
    CHECK(memcmp(revision_view.content, "resolved", 8) == 0);

    scpefe_decoded_snapshot_revision_destroy(revision);
    scpefe_unlocked_container_destroy(unlocked);
    free(merged);
    free(current);
    free(local);
    free(base);
    return 0;
}
