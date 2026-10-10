#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)

extern int crypto_generichash(unsigned char *, size_t, const unsigned char *,
    unsigned long long, const unsigned char *, size_t);

static const char password[] = "owner passphrase with independent words";

static int create_document(uint8_t **output, size_t *output_size)
{
    const scpefe_new_document_v1 document = {
        sizeof(document), "Ada", 3, "ada@example.test", 16, "Desk", 4,
        "base", 4, 1, (const uint8_t *)password, sizeof(password) - 1,
        NULL, 0,
    };
    CHECK(scpefe_new_document_create(&document, NULL, 0, output_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    *output = (uint8_t *)malloc(*output_size);
    CHECK(*output != NULL);
    CHECK(scpefe_new_document_create(&document, *output, *output_size, output_size)
        == SCPEFE_STATUS_OK);
    return 0;
}

static int save_branch(const uint8_t *base, size_t base_size,
    const char *content, uint64_t timestamp, uint8_t **output, size_t *output_size)
{
    const scpefe_manual_save_v1 save = {
        sizeof(save), base, base_size, (const uint8_t *)password, sizeof(password) - 1,
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

static int open_revision(const uint8_t *container, size_t container_size,
    scpefe_unlocked_container **unlocked,
    scpefe_decoded_snapshot_revision **revision,
    scpefe_snapshot_revision_v1 *view,
    uint8_t head_id[SCPEFE_REVISION_ID_SIZE])
{
    scpefe_unlocked_container_v1 container_view = {0};
    scpefe_revision_limits_v1 limits = {0};
    CHECK(scpefe_password_container_unlock(container, container_size,
        (const uint8_t *)password, sizeof(password) - 1, unlocked)
        == SCPEFE_STATUS_OK);
    container_view.struct_size = sizeof(container_view);
    CHECK(scpefe_unlocked_container_view(*unlocked, &container_view)
        == SCPEFE_STATUS_OK);
    CHECK(crypto_generichash(head_id, SCPEFE_REVISION_ID_SIZE,
        container_view.encoded_snapshot_revision,
        container_view.encoded_snapshot_revision_size, NULL, 0) == 0);
    limits.struct_size = sizeof(limits);
    CHECK(scpefe_revision_limits_default(&limits) == SCPEFE_STATUS_OK);
    CHECK(scpefe_snapshot_revision_decode(container_view.encoded_snapshot_revision,
        container_view.encoded_snapshot_revision_size, &limits, revision)
        == SCPEFE_STATUS_OK);
    view->struct_size = sizeof(*view);
    CHECK(scpefe_decoded_snapshot_revision_view(*revision, view)
        == SCPEFE_STATUS_OK);
    return 0;
}

static const scpefe_revision_graph_node_v1 *node_for(
    const scpefe_snapshot_revision_v1 *view, const uint8_t *id)
{
    for (size_t index = 0; index < view->ancestor_count; ++index) {
        if (memcmp(view->ancestor_graph[index].revision_id, id,
                SCPEFE_REVISION_ID_SIZE) == 0)
            return &view->ancestor_graph[index];
    }
    return NULL;
}

static int check_edge(const scpefe_snapshot_revision_v1 *view,
    const uint8_t *child, const uint8_t *parent)
{
    const scpefe_revision_graph_node_v1 *node = node_for(view, child);
    CHECK(node != NULL);
    CHECK(node->parent_count == 1);
    CHECK(memcmp(node->parent_revision_ids, parent, SCPEFE_REVISION_ID_SIZE) == 0);
    return 0;
}

int main(void)
{
    uint8_t *base = NULL, *local = NULL, *local_tip = NULL;
    uint8_t *current = NULL, *current_tip = NULL, *unrelated = NULL;
    uint8_t *merged = NULL;
    size_t base_size = 0, local_size = 0, local_tip_size = 0;
    size_t current_size = 0, current_tip_size = 0, unrelated_size = 0;
    size_t merged_size = 0;
    uint8_t base_id[SCPEFE_REVISION_ID_SIZE], local_id[SCPEFE_REVISION_ID_SIZE];
    uint8_t local_tip_id[SCPEFE_REVISION_ID_SIZE];
    uint8_t current_id[SCPEFE_REVISION_ID_SIZE];
    uint8_t current_tip_id[SCPEFE_REVISION_ID_SIZE];
    uint8_t merged_id[SCPEFE_REVISION_ID_SIZE];
    uint8_t content_hash[SCPEFE_CONTENT_HASH_SIZE];
    uint8_t author_slot_id[SCPEFE_SLOT_ID_SIZE];
    scpefe_unlocked_container *unlocked = NULL;
    scpefe_decoded_snapshot_revision *revision = NULL;
    scpefe_snapshot_revision_v1 view = {0};

    CHECK(create_document(&base, &base_size) == 0);
    CHECK(save_branch(base, base_size, "local", 2, &local, &local_size) == 0);
    CHECK(save_branch(local, local_size, "local tip", 3,
        &local_tip, &local_tip_size) == 0);
    CHECK(save_branch(base, base_size, "current", 4,
        &current, &current_size) == 0);
    CHECK(save_branch(current, current_size, "current tip", 5,
        &current_tip, &current_tip_size) == 0);
    CHECK(create_document(&unrelated, &unrelated_size) == 0);

    CHECK(open_revision(base, base_size, &unlocked, &revision, &view, base_id) == 0);
    scpefe_decoded_snapshot_revision_destroy(revision);
    scpefe_unlocked_container_destroy(unlocked);
    CHECK(open_revision(local, local_size, &unlocked, &revision, &view, local_id) == 0);
    scpefe_decoded_snapshot_revision_destroy(revision);
    scpefe_unlocked_container_destroy(unlocked);
    CHECK(open_revision(local_tip, local_tip_size, &unlocked, &revision,
        &view, local_tip_id) == 0);
    scpefe_decoded_snapshot_revision_destroy(revision);
    scpefe_unlocked_container_destroy(unlocked);
    CHECK(open_revision(current, current_size, &unlocked, &revision,
        &view, current_id) == 0);
    scpefe_decoded_snapshot_revision_destroy(revision);
    scpefe_unlocked_container_destroy(unlocked);
    CHECK(open_revision(current_tip, current_tip_size, &unlocked, &revision,
        &view, current_tip_id) == 0);
    CHECK(view.slot_id_size == sizeof(author_slot_id));
    memcpy(author_slot_id, view.slot_id, sizeof(author_slot_id));
    scpefe_decoded_snapshot_revision_destroy(revision);
    scpefe_unlocked_container_destroy(unlocked);

    scpefe_merge_save_v1 merge = {
        sizeof(merge), current_tip, current_tip_size, local_tip, local_tip_size,
        (const uint8_t *)password, sizeof(password) - 1,
        "Resolver", 8, "resolver@example.test", 21, "Laptop", 6,
        "resolved", 8, 6,
    };
    CHECK(scpefe_merge_save(&merge, NULL, 0, &merged_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    merged = (uint8_t *)malloc(merged_size);
    CHECK(merged != NULL);
    CHECK(scpefe_merge_save(&merge, merged, merged_size, &merged_size)
        == SCPEFE_STATUS_OK);
    CHECK(open_revision(merged, merged_size, &unlocked, &revision,
        &view, merged_id) == 0);
    CHECK(view.manually_sealed == 1);
    CHECK(memcmp(merged_id, local_tip_id, sizeof(merged_id)) != 0);
    CHECK(memcmp(merged_id, current_tip_id, sizeof(merged_id)) != 0);
    CHECK(view.parent_count == 2);
    CHECK(memcmp(view.parent_revision_ids, local_tip_id, SCPEFE_REVISION_ID_SIZE) == 0);
    CHECK(memcmp(view.parent_revision_ids + SCPEFE_REVISION_ID_SIZE,
        current_tip_id, SCPEFE_REVISION_ID_SIZE) == 0);
    CHECK(view.ancestor_count == 5);
    CHECK(node_for(&view, base_id) != NULL);
    CHECK(node_for(&view, base_id)->parent_count == 0);
    CHECK(check_edge(&view, local_id, base_id) == 0);
    CHECK(check_edge(&view, local_tip_id, local_id) == 0);
    CHECK(check_edge(&view, current_id, base_id) == 0);
    CHECK(check_edge(&view, current_tip_id, current_id) == 0);
    CHECK(view.content_size == 8 && memcmp(view.content, "resolved", 8) == 0);
    CHECK(crypto_generichash(content_hash, sizeof(content_hash),
        (const unsigned char *)"resolved", 8, NULL, 0) == 0);
    CHECK(view.content_hash_size == sizeof(content_hash));
    CHECK(memcmp(view.content_hash, content_hash, sizeof(content_hash)) == 0);
    CHECK(view.timestamp_ms == 6);
    CHECK(view.slot_id_size == sizeof(author_slot_id));
    CHECK(memcmp(view.slot_id, author_slot_id, sizeof(author_slot_id)) == 0);
    CHECK(view.slot_identity_name_size == 3
        && memcmp(view.slot_identity_name, "Ada", 3) == 0);
    CHECK(view.slot_identity_email_size == 16
        && memcmp(view.slot_identity_email, "ada@example.test", 16) == 0);
    CHECK(view.client_profile_name_size == 8
        && memcmp(view.client_profile_name, "Resolver", 8) == 0);
    CHECK(view.client_profile_email_size == 21
        && memcmp(view.client_profile_email, "resolver@example.test", 21) == 0);
    CHECK(view.device_name_size == 6 && memcmp(view.device_name, "Laptop", 6) == 0);
    scpefe_decoded_snapshot_revision_destroy(revision);
    scpefe_unlocked_container_destroy(unlocked);

    merge.local_container = current_tip;
    merge.local_container_size = current_tip_size;
    CHECK(scpefe_merge_save(&merge, NULL, 0, &merged_size)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    merge.local_container = current;
    merge.local_container_size = current_size;
    CHECK(scpefe_merge_save(&merge, NULL, 0, &merged_size)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    merge.current_container = current;
    merge.current_container_size = current_size;
    merge.local_container = current_tip;
    merge.local_container_size = current_tip_size;
    CHECK(scpefe_merge_save(&merge, NULL, 0, &merged_size)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    merge.local_container = unrelated;
    merge.local_container_size = unrelated_size;
    CHECK(scpefe_merge_save(&merge, NULL, 0, &merged_size)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    merge.local_container = local_tip;
    merge.local_container_size = local_tip_size;
    merge.password = (const uint8_t *)"wrong password";
    merge.password_size = 14;
    CHECK(scpefe_merge_save(&merge, NULL, 0, &merged_size)
        == SCPEFE_STATUS_AUTHENTICATION_FAILED);

    free(merged);
    free(unrelated);
    free(current_tip);
    free(current);
    free(local_tip);
    free(local);
    free(base);
    return 0;
}
