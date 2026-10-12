#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(value) do { if (!(value)) { \
    fprintf(stderr, "revised compaction failed at line %d\n", __LINE__); return 1; \
} } while (0)

static scpefe_status read_clock(void *instance, uint64_t *value)
{
    *value = *(uint64_t *)instance;
    return SCPEFE_STATUS_OK;
}

static int copy_bytes(scpefe_container *container, uint8_t **bytes, size_t *size)
{
    CHECK(scpefe_container_copy_bytes(container, NULL, 0, size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    *bytes = (uint8_t *)malloc(*size);
    CHECK(*bytes != NULL);
    CHECK(scpefe_container_copy_bytes(container, *bytes, *size, size)
        == SCPEFE_STATUS_OK);
    return 0;
}

static int publish(scpefe_container *container, uint64_t operation_id)
{
    uint32_t effects = 0;
    CHECK(scpefe_container_acknowledge_save(container, operation_id,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_OK);
    CHECK((effects & SCPEFE_EFFECT_ADOPT_CANDIDATE) != 0);
    return 0;
}

static int inspect_candidate(const uint8_t *bytes, size_t size,
    const scpefe_host_services_v1 *host, const uint8_t *password,
    size_t password_size, size_t cutoff_content_index,
    const uint8_t original_ids[13][SCPEFE_REVISION_ID_SIZE])
{
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    scpefe_revision_graph *graph = NULL;
    scpefe_revision_page *page = NULL;
    scpefe_revision_result *result = NULL;
    scpefe_revision_result_view_v1 text = {sizeof(text)};
    scpefe_container_open_v1 open = {sizeof(open), SCPEFE_ABI_VERSION, bytes, size};
    scpefe_password_input_v1 auth = {sizeof(auth), SCPEFE_ABI_VERSION,
        password, password_size};
    size_t count = 0;
    char latest[16];
    CHECK(scpefe_context_create(host, &context) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_open(context, &open, &container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_unlock(container, &auth) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_revision_graph(container, &graph) == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_graph_list(graph, 0, 14, &page) == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_page_count(page, &count) == SCPEFE_STATUS_OK
        && count == 14);
    for (size_t i = 0; i < 14; ++i) {
        scpefe_revision_metadata_v1 metadata = {0};
        metadata.struct_size = sizeof(metadata);
        CHECK(scpefe_revision_page_metadata(page, i, &metadata)
            == SCPEFE_STATUS_OK);
        if (i == 0) {
            CHECK(metadata.original_kind == 2 && metadata.storage_kind == 0);
            CHECK(metadata.event_type_size == 10
                && memcmp(metadata.event_type, "compaction", 10) == 0);
            continue;
        }
        const size_t content_index = 13 - i;
        CHECK(memcmp(metadata.id, original_ids[content_index],
            SCPEFE_REVISION_ID_SIZE) == 0);
        if (content_index < cutoff_content_index) {
            CHECK(metadata.storage_kind == 4 && !metadata.body_available
                && !metadata.text_available);
            CHECK(scpefe_revision_graph_body(graph, metadata.id, &result)
                == SCPEFE_STATUS_BODY_UNAVAILABLE && result == NULL);
            CHECK(scpefe_revision_graph_reconstruct(graph, metadata.id, &result)
                == SCPEFE_STATUS_BODY_UNAVAILABLE && result == NULL);
        } else {
            CHECK(metadata.storage_kind == (content_index == cutoff_content_index
                ? 3 : 2) && metadata.body_available && metadata.text_available);
            CHECK(scpefe_revision_graph_reconstruct(graph, metadata.id, &result)
                == SCPEFE_STATUS_OK);
            CHECK(scpefe_revision_result_view(result, &text) == SCPEFE_STATUS_OK);
            snprintf(latest, sizeof(latest), "revision %02zu\n", content_index);
            if (content_index == 0)
                CHECK(text.text_size == 9
                    && memcmp(text.text, "baseline\n", 9) == 0);
            else CHECK(text.text_size == strlen(latest)
                && memcmp(text.text, latest, text.text_size) == 0);
            scpefe_revision_result_destroy(result);
            result = NULL;
        }
    }
    scpefe_revision_page_destroy(page);
    scpefe_revision_graph_destroy(graph);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    return 0;
}

int main(void)
{
    const uint8_t password[] = "0b4e79c5-7cfe-4b7c-b4f3-d89129cb7b5e";
    const uint8_t session[16] = {1};
    const uint8_t zero[16] = {0};
    uint64_t clock = 1;
    scpefe_host_services_v1 host = {sizeof(host), SCPEFE_ABI_VERSION,
        &clock, read_clock};
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    scpefe_container_create_v1 create = {0};
    scpefe_container_lease_change_v1 lease = {0};
    scpefe_container_save_v1 save = {0};
    scpefe_container_compaction_v1 compact = {0};
    scpefe_candidate_info_v1 info = {sizeof(info), SCPEFE_ABI_VERSION};
    uint8_t original_ids[13][SCPEFE_REVISION_ID_SIZE] = {{0}};
    uint8_t *backup = NULL, *candidate = NULL;
    size_t backup_size = 0, candidate_size = 0;
    uint32_t effects = 0;

    create.struct_size = sizeof(create);
    create.abi_version = SCPEFE_ABI_VERSION;
    create.document.struct_size = sizeof(create.document);
    create.document.profile_name = "Ada";
    create.document.profile_name_size = 3;
    create.document.profile_email = "ada@example.test";
    create.document.profile_email_size = 16;
    create.document.device_name = "Desk";
    create.document.device_name_size = 4;
    create.document.content = "baseline\n";
    create.document.content_size = 9;
    create.document.timestamp_ms = 1;
    create.document.owner_password = password;
    create.document.owner_password_size = sizeof(password) - 1;
    CHECK(scpefe_context_create(&host, &context) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_create(context, &create, &container) == SCPEFE_STATUS_OK);

    lease.struct_size = sizeof(lease);
    lease.abi_version = SCPEFE_ABI_VERSION;
    lease.operation_id = 1;
    lease.action = SCPEFE_LEASE_ACQUIRE;
    lease.password = password;
    lease.password_size = sizeof(password) - 1;
    lease.session_id = session;
    lease.session_id_size = sizeof(session);
    lease.expected_session_id = zero;
    lease.expected_session_id_size = sizeof(zero);
    lease.expected_duration_ms = 600000;
    lease.now_utc_ms = 1000;
    lease.duration_ms = 600000;
    lease.holder_name = "Ada";
    lease.holder_name_size = 3;
    lease.holder_email = "ada@example.test";
    lease.holder_email_size = 16;
    lease.device_name = "Desk";
    lease.device_name_size = 4;
    CHECK(scpefe_container_prepare_lease_change(container, &lease, &info)
        == SCPEFE_STATUS_OK);
    CHECK(publish(container, 1) == 0);

    save.struct_size = sizeof(save);
    save.abi_version = SCPEFE_ABI_VERSION;
    save.kind = SCPEFE_SAVE_MANUAL;
    save.password = password;
    save.password_size = sizeof(password) - 1;
    save.profile_name = "Ada";
    save.profile_name_size = 3;
    save.profile_email = "ada@example.test";
    save.profile_email_size = 16;
    save.device_name = "Desk";
    save.device_name_size = 4;
    for (size_t i = 1; i <= 12; ++i) {
        char content[16];
        const int length = snprintf(content, sizeof(content), "revision %02zu\n", i);
        CHECK(length > 0 && (size_t)length < sizeof(content));
        CHECK(scpefe_container_submit_content(container, content, (size_t)length)
            == SCPEFE_STATUS_OK);
        save.operation_id = i + 1;
        save.timestamp_ms = i + 1;
        CHECK(scpefe_container_prepare_save(container, &save, &info)
            == SCPEFE_STATUS_OK);
        CHECK(publish(container, save.operation_id) == 0);
    }
    {
        scpefe_revision_graph *graph = NULL;
        scpefe_revision_page *page = NULL;
        CHECK(scpefe_container_revision_graph(container, &graph) == SCPEFE_STATUS_OK);
        CHECK(scpefe_revision_graph_list(graph, 0, 13, &page) == SCPEFE_STATUS_OK);
        for (size_t i = 0; i < 13; ++i) {
            scpefe_revision_metadata_v1 metadata = {0};
            metadata.struct_size = sizeof(metadata);
            CHECK(scpefe_revision_page_metadata(page, i, &metadata)
                == SCPEFE_STATUS_OK);
            memcpy(original_ids[12 - i], metadata.id, SCPEFE_REVISION_ID_SIZE);
        }
        scpefe_revision_page_destroy(page);
        scpefe_revision_graph_destroy(graph);
    }
    CHECK(copy_bytes(container, &backup, &backup_size) == 0);

    compact.struct_size = sizeof(compact);
    compact.abi_version = SCPEFE_ABI_VERSION;
    compact.password = password;
    compact.password_size = sizeof(password) - 1;
    compact.lease_session_id = session;
    compact.lease_session_id_size = sizeof(session);
    compact.lease_heartbeat_counter = 1;
    compact.explicit_decision = 1;
    compact.clean_state_confirmed = 1;
    compact.backup_verified = 1;
    compact.verified_backup_bytes = backup;
    compact.verified_backup_size = backup_size;
    compact.client_name = "Ada";
    compact.client_name_size = 3;
    compact.client_email = "ada@example.test";
    compact.client_email_size = 16;
    compact.device_name = "Desk";
    compact.device_name_size = 4;
    compact.timestamp_ms = 100;
    compact.operation_id = 14;
    CHECK(compact.retention_is_explicit == 0 && compact.retain_deltas == 0);
    CHECK(scpefe_container_submit_content(container, "unsaved\n", 8)
        == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_prepare_compaction(container, &compact, &info)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    CHECK(scpefe_container_submit_content(container, "revision 12\n", 12)
        == SCPEFE_STATUS_OK);
    compact.explicit_decision = 0;
    CHECK(scpefe_container_prepare_compaction(container, &compact, &info)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    compact.explicit_decision = 1;
    compact.backup_verified = 0;
    CHECK(scpefe_container_prepare_compaction(container, &compact, &info)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    compact.backup_verified = 1;
    compact.clean_state_confirmed = 0;
    CHECK(scpefe_container_prepare_compaction(container, &compact, &info)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    compact.clean_state_confirmed = 1;
    compact.lease_heartbeat_counter = 2;
    CHECK(scpefe_container_prepare_compaction(container, &compact, &info)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    compact.lease_heartbeat_counter = 1;
    backup[backup_size - 1] ^= 1;
    CHECK(scpefe_container_prepare_compaction(container, &compact, &info)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    backup[backup_size - 1] ^= 1;
    compact.password = (const uint8_t *)"wrong password";
    compact.password_size = strlen("wrong password");
    CHECK(scpefe_container_prepare_compaction(container, &compact, &info)
        == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    compact.password = password;
    compact.password_size = sizeof(password) - 1;

    for (size_t n = 0; n < 3; ++n) {
        const size_t cutoff = n == 0 ? 2 : n == 1 ? 12 : 11;
        compact.operation_id = 14 + n;
        if (n != 0) compact.retention_is_explicit = 1;
        compact.retain_deltas = n == 0 ? 0 : n - 1;
        CHECK(scpefe_container_prepare_compaction(container, &compact, &info)
            == SCPEFE_STATUS_OK);
        CHECK(info.operation_id == compact.operation_id
            && info.byte_size > 0);
        CHECK((info.effect_mask & (SCPEFE_EFFECT_REREAD_TARGET
            | SCPEFE_EFFECT_JOURNAL_CANDIDATE | SCPEFE_EFFECT_PUBLISH_CANDIDATE))
            == (SCPEFE_EFFECT_REREAD_TARGET | SCPEFE_EFFECT_JOURNAL_CANDIDATE
                | SCPEFE_EFFECT_PUBLISH_CANDIDATE));
        CHECK(scpefe_container_copy_candidate(container, compact.operation_id,
            NULL, 0, &candidate_size) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
        candidate = (uint8_t *)malloc(candidate_size);
        CHECK(candidate != NULL);
        CHECK(scpefe_container_copy_candidate(container, compact.operation_id,
            candidate, candidate_size, &candidate_size) == SCPEFE_STATUS_OK);
        CHECK(inspect_candidate(candidate, candidate_size, &host,
            password, sizeof(password) - 1, cutoff, original_ids) == 0);
        if (n == 2) CHECK(publish(container, compact.operation_id) == 0);
        else CHECK(scpefe_container_acknowledge_save(container,
            compact.operation_id, SCPEFE_PUBLICATION_DEFINITE_FAILURE, &effects)
            == SCPEFE_STATUS_OK);
        free(candidate);
        candidate = NULL;
    }
    compact.retention_is_explicit = 2;
    CHECK(scpefe_container_prepare_compaction(container, &compact, &info)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    compact.retention_is_explicit = 1;
    CHECK(scpefe_container_prepare_compaction(container, &compact, &info)
        == SCPEFE_STATUS_STALE_OPERATION);
    CHECK(scpefe_container_submit_content(container, "provisional\n", 12)
        == SCPEFE_STATUS_OK);
    save.kind = SCPEFE_SAVE_REGULAR;
    save.operation_id = 17;
    save.timestamp_ms = 200;
    CHECK(scpefe_container_prepare_save(container, &save, &info)
        == SCPEFE_STATUS_OK);
    CHECK(publish(container, save.operation_id) == 0);
    free(backup);
    backup = NULL;
    backup_size = 0;
    CHECK(copy_bytes(container, &backup, &backup_size) == 0);
    compact.operation_id = 18;
    compact.verified_backup_bytes = backup;
    compact.verified_backup_size = backup_size;
    compact.retention_is_explicit = 1;
    compact.retain_deltas = 0;
    CHECK(scpefe_container_prepare_compaction(container, &compact, &info)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    free(backup);
    return 0;
}
