#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)

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
    size_t parents, size_t ancestors)
{
    scpefe_unlocked_container *unlocked = NULL;
    scpefe_decoded_snapshot_revision *revision = NULL;
    scpefe_snapshot_revision_v1 view = {0};
    CHECK(open_revision(container, container_size, password,
        &unlocked, &revision, &view) == 0);
    CHECK(view.manually_sealed == sealed);
    CHECK(view.parent_count == parents);
    CHECK(view.ancestor_count == ancestors);
    CHECK(view.content_size == strlen(content));
    CHECK(memcmp(view.content, content, view.content_size) == 0);
    CHECK((view.provisional_base_revision_size == 0) == sealed);
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

    const scpefe_regular_save_v1 first_save = {
        sizeof(scpefe_regular_save_v1), base, base_size,
        (const uint8_t *)password, sizeof(password) - 1,
        "Ada", 3, "ada@example.test", 16, "Ada PC", 6,
        "first provisional", 17, 2000,
    };
    uint8_t *first = NULL;
    size_t first_size = 0;
    CHECK(run_save(scpefe_regular_save, &first_save, &first, &first_size) == 0);
    CHECK(inspect(first, first_size, password, "first provisional", 0, 1, 1) == 0);

    scpefe_regular_save_v1 second_save = first_save;
    second_save.container = first;
    second_save.container_size = first_size;
    second_save.content = "second provisional";
    second_save.content_size = 18;
    second_save.timestamp_ms = 3000;
    uint8_t *second = NULL;
    size_t second_size = 0;
    CHECK(run_save(scpefe_regular_save, &second_save, &second, &second_size) == 0);
    CHECK(inspect(second, second_size, password, "second provisional", 0, 1, 1) == 0);

    size_t discarded_size = 0;
    CHECK(scpefe_provisional_save_discard(second, second_size,
        (const uint8_t *)password, sizeof(password) - 1, NULL, 0,
        &discarded_size) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *discarded = (uint8_t *)malloc(discarded_size);
    CHECK(discarded != NULL);
    CHECK(scpefe_provisional_save_discard(second, second_size,
        (const uint8_t *)password, sizeof(password) - 1,
        discarded, discarded_size, &discarded_size) == SCPEFE_STATUS_OK);
    CHECK(inspect(discarded, discarded_size, password, "sealed base", 1, 0, 0) == 0);

    const scpefe_manual_save_v1 manual = {
        sizeof(scpefe_manual_save_v1), second, second_size,
        (const uint8_t *)password, sizeof(password) - 1,
        "Ada", 3, "ada@example.test", 16, "Ada PC", 6,
        "second provisional", 18, 4000,
    };
    size_t sealed_size = 0;
    CHECK(scpefe_manual_save(&manual, NULL, 0, &sealed_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *sealed = (uint8_t *)malloc(sealed_size);
    CHECK(sealed != NULL);
    CHECK(scpefe_manual_save(&manual, sealed, sealed_size, &sealed_size)
        == SCPEFE_STATUS_OK);
    CHECK(inspect(sealed, sealed_size, password, "second provisional", 1, 1, 1) == 0);

    free(sealed); free(discarded); free(second); free(first); free(base);
    return 0;
}
