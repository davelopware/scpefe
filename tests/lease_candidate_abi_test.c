#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(value) do { if (!(value)) { \
    fprintf(stderr, "lease candidate failure at line %d\n", __LINE__); return 1; \
} } while (0)

static scpefe_status clock_read(void *instance, uint64_t *value)
{
    *value = *(uint64_t *)instance;
    return SCPEFE_STATUS_OK;
}

static int lease_view(scpefe_container *container,
    scpefe_owned_authenticated_state_view_v1 *view)
{
    scpefe_owned_authenticated_state *state = NULL;
    view->struct_size = sizeof(*view);
    view->abi_version = SCPEFE_ABI_VERSION;
    CHECK(scpefe_container_authenticated_state(container, &state) == SCPEFE_STATUS_OK);
    CHECK(scpefe_owned_authenticated_state_view(state, view) == SCPEFE_STATUS_OK);
    scpefe_owned_authenticated_state_destroy(state);
    return 0;
}

static int mode_is(scpefe_container *container, int editing, int lease_status)
{
    scpefe_container_lease_mode_v1 mode = {sizeof(mode), SCPEFE_ABI_VERSION};
    CHECK(scpefe_container_lease_mode(container, &mode) == SCPEFE_STATUS_OK);
    CHECK(mode.is_editing == editing && mode.lease_status == lease_status);
    return 0;
}

static int other_session_reads_only(scpefe_container *source,
    const scpefe_host_services_v1 *host,
    const scpefe_password_input_v1 *password, const uint8_t session_id[16])
{
    uint8_t *bytes = NULL;
    size_t size = 0;
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    scpefe_container_open_v1 open = {0};
    scpefe_owned_authenticated_state_view_v1 view = {0};
    scpefe_container_lease_change_v1 request = {0};
    scpefe_candidate_info_v1 info = {sizeof(info), SCPEFE_ABI_VERSION};
    CHECK(scpefe_container_copy_bytes(source, NULL, 0, &size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    bytes = (uint8_t *)malloc(size);
    CHECK(bytes != NULL);
    CHECK(scpefe_container_copy_bytes(source, bytes, size, &size) == SCPEFE_STATUS_OK);
    open.struct_size = sizeof(open);
    open.abi_version = SCPEFE_ABI_VERSION;
    open.bytes = bytes;
    open.bytes_size = size;
    CHECK(scpefe_context_create(host, &context) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_open(context, &open, &container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_unlock(container, password) == SCPEFE_STATUS_OK);
    CHECK(mode_is(container, 0, 2) == 0);
    CHECK(lease_view(container, &view) == 0 && view.lease_active);
    request.struct_size = sizeof(request);
    request.abi_version = SCPEFE_ABI_VERSION;
    request.operation_id = 1;
    request.action = SCPEFE_LEASE_RESUME;
    request.password = password->bytes;
    request.password_size = password->bytes_size;
    request.session_id = session_id;
    request.session_id_size = 16;
    request.expected_active = 1;
    request.expected_session_id = session_id;
    request.expected_session_id_size = 16;
    request.expected_heartbeat_counter = view.lease_heartbeat_counter;
    request.expected_holder_utc_ms = view.lease_holder_utc_ms;
    request.expected_duration_ms = view.lease_duration_ms;
    request.now_utc_ms = view.lease_holder_utc_ms + 1;
    request.duration_ms = view.lease_duration_ms;
    request.holder_name = "Ada";
    request.holder_name_size = 3;
    request.holder_email = "ada@example.test";
    request.holder_email_size = 16;
    request.device_name = "Desk";
    request.device_name_size = 4;
    CHECK(scpefe_container_prepare_lease_change(container, &request, &info)
        == SCPEFE_STATUS_INVALID_STATE);
    request.action = SCPEFE_LEASE_RELEASE;
    CHECK(scpefe_container_prepare_lease_change(container, &request, &info)
        == SCPEFE_STATUS_INVALID_STATE);
    CHECK(scpefe_container_submit_content(container, "blocked", 7)
        == SCPEFE_STATUS_INVALID_STATE);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    free(bytes);
    return 0;
}

static int prepare_and_publish(scpefe_container *container,
    scpefe_container_lease_change_v1 *request, uint64_t operation_id)
{
    scpefe_candidate_info_v1 info = {sizeof(info), SCPEFE_ABI_VERSION};
    uint32_t effects = 0;
    uint8_t *candidate = NULL, *committed = NULL;
    size_t candidate_size = 0, committed_size = 0;
    request->operation_id = operation_id;
    CHECK(scpefe_container_prepare_lease_change(container, request, &info)
        == SCPEFE_STATUS_OK);
    CHECK(info.operation_id == operation_id && info.byte_size > 0);
    CHECK((info.effect_mask & (SCPEFE_EFFECT_REREAD_TARGET
        | SCPEFE_EFFECT_JOURNAL_CANDIDATE | SCPEFE_EFFECT_PUBLISH_CANDIDATE))
        == (SCPEFE_EFFECT_REREAD_TARGET | SCPEFE_EFFECT_JOURNAL_CANDIDATE
            | SCPEFE_EFFECT_PUBLISH_CANDIDATE));
    CHECK(scpefe_container_copy_candidate(container, operation_id - 1,
        NULL, 0, &candidate_size) == SCPEFE_STATUS_STALE_OPERATION);
    CHECK(scpefe_container_copy_candidate(container, operation_id,
        NULL, 0, &candidate_size) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    CHECK(candidate_size == info.byte_size);
    candidate = (uint8_t *)malloc(candidate_size);
    CHECK(candidate != NULL);
    CHECK(scpefe_container_copy_candidate(container, operation_id,
        candidate, candidate_size, &candidate_size) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_acknowledge_save(container, operation_id - 1,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_STALE_OPERATION);
    CHECK(scpefe_container_acknowledge_save(container, operation_id,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_OK);
    CHECK((effects & SCPEFE_EFFECT_ADOPT_CANDIDATE) != 0);
    CHECK(scpefe_container_copy_bytes(container, NULL, 0, &committed_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    committed = (uint8_t *)malloc(committed_size);
    CHECK(committed != NULL);
    CHECK(scpefe_container_copy_bytes(container, committed, committed_size,
        &committed_size) == SCPEFE_STATUS_OK);
    CHECK(committed_size == candidate_size
        && memcmp(committed, candidate, candidate_size) == 0);
    CHECK(scpefe_container_acknowledge_save(container, operation_id,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_STALE_OPERATION);
    free(candidate);
    free(committed);
    return 0;
}

int main(void)
{
    uint64_t clock = 1;
    const uint8_t password[] = "0b4e79c5-7cfe-4b7c-b4f3-d89129cb7b5e";
    const uint8_t session_a[16] = {1};
    const uint8_t session_b[16] = {2};
    const uint8_t zero[16] = {0};
    scpefe_host_services_v1 host = {sizeof(host), SCPEFE_ABI_VERSION, &clock, clock_read};
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    scpefe_container_create_v1 create = {0};
    scpefe_revision_graph *graph = NULL;
    uint8_t head[32], content_head[32], after_head[32], after_content[32];
    scpefe_owned_authenticated_state_view_v1 view = {0};
    scpefe_password_input_v1 auth = {sizeof(auth), SCPEFE_ABI_VERSION,
        password, sizeof(password) - 1};
    scpefe_container_lease_change_v1 request = {0};
    scpefe_candidate_info_v1 info = {sizeof(info), SCPEFE_ABI_VERSION};
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
    create.document.content = "alpha\n";
    create.document.content_size = 6;
    create.document.timestamp_ms = 1;
    create.document.owner_password = password;
    create.document.owner_password_size = sizeof(password) - 1;
    CHECK(scpefe_context_create(&host, &context) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_create(context, &create, &container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_revision_graph(container, &graph) == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_graph_heads(graph, head, content_head) == SCPEFE_STATUS_OK);
    scpefe_revision_graph_destroy(graph);
    graph = NULL;
    CHECK(mode_is(container, 0, 0) == 0);
    CHECK(lease_view(container, &view) == 0);
    CHECK(!view.lease_active && view.lease_duration_ms == 600000);

    request.struct_size = sizeof(request);
    request.abi_version = SCPEFE_ABI_VERSION;
    request.action = SCPEFE_LEASE_ACQUIRE;
    request.password = password;
    request.password_size = sizeof(password) - 1;
    request.session_id = session_a;
    request.session_id_size = sizeof(session_a);
    request.expected_session_id = zero;
    request.expected_session_id_size = sizeof(zero);
    request.expected_duration_ms = 600000;
    request.now_utc_ms = 1000;
    request.duration_ms = 600000;
    request.holder_name = "Ada";
    request.holder_name_size = 3;
    request.holder_email = "ada@example.test";
    request.holder_email_size = 16;
    request.device_name = "Desk";
    request.device_name_size = 4;
    request.operation_id = 1;
    request.password = (const uint8_t *)"wrong password";
    request.password_size = strlen("wrong password");
    CHECK(scpefe_container_prepare_lease_change(container, &request, &info)
        == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    request.password = password;
    request.password_size = sizeof(password) - 1;
    request.expected_heartbeat_counter = 1;
    CHECK(scpefe_container_prepare_lease_change(container, &request, &info)
        == SCPEFE_STATUS_STALE_OPERATION);
    CHECK(mode_is(container, 0, 0) == 0);
    request.expected_heartbeat_counter = 0;
    CHECK(prepare_and_publish(container, &request, 1) == 0);
    CHECK(mode_is(container, 1, 1) == 0);
    CHECK(lease_view(container, &view) == 0);
    CHECK(view.lease_active && view.lease_heartbeat_counter == 1
        && memcmp(view.lease_session_id, session_a, 16) == 0);
    CHECK(other_session_reads_only(container, &host, &auth, session_a) == 0);
    CHECK(scpefe_container_revision_graph(container, &graph) == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_graph_heads(graph, after_head, after_content)
        == SCPEFE_STATUS_OK);
    CHECK(memcmp(head, after_head, 32) == 0
        && memcmp(content_head, after_content, 32) == 0);
    scpefe_revision_graph_destroy(graph);
    graph = NULL;

    request.action = SCPEFE_LEASE_REFRESH;
    request.expected_active = 1;
    request.expected_session_id = session_a;
    request.expected_heartbeat_counter = 1;
    request.expected_holder_utc_ms = 1000;
    request.now_utc_ms = 121000;
    request.session_id = session_b;
    request.operation_id = 2;
    CHECK(scpefe_container_prepare_lease_change(container, &request, &info)
        == SCPEFE_STATUS_INVALID_STATE);
    request.session_id = session_a;
    request.operation_id = 2;
    CHECK(scpefe_container_prepare_lease_change(container, &request, &info)
        == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_acknowledge_save(container, 2,
        SCPEFE_PUBLICATION_DEFINITE_FAILURE, &effects) == SCPEFE_STATUS_OK);
    CHECK(mode_is(container, 1, 1) == 0);
    CHECK(lease_view(container, &view) == 0 && view.lease_heartbeat_counter == 1);
    request.operation_id = 3;
    CHECK(scpefe_container_prepare_lease_change(container, &request, &info)
        == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_acknowledge_save(container, 3,
        SCPEFE_PUBLICATION_AMBIGUOUS, &effects) == SCPEFE_STATUS_OK);
    CHECK((effects & SCPEFE_EFFECT_RECOVER_CANDIDATE) != 0);
    CHECK(scpefe_container_resolve_save(container, 2, 1, &effects)
        == SCPEFE_STATUS_STALE_OPERATION);
    CHECK(scpefe_container_resolve_save(container, 3, 1, &effects)
        == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_resolve_save(container, 3, 1, &effects)
        == SCPEFE_STATUS_STALE_OPERATION);
    CHECK(lease_view(container, &view) == 0 && view.lease_heartbeat_counter == 2);

    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    {
        scpefe_container_lease_mode_v1 mode = {sizeof(mode), SCPEFE_ABI_VERSION};
        CHECK(scpefe_container_lease_mode(container, &mode) == SCPEFE_STATUS_LOCKED);
    }
    request.action = SCPEFE_LEASE_RESUME;
    request.expected_heartbeat_counter = 2;
    request.expected_holder_utc_ms = 121000;
    request.now_utc_ms = 122000;
    request.operation_id = 4;
    CHECK(scpefe_container_prepare_lease_change(container, &request, &info)
        == SCPEFE_STATUS_INVALID_STATE);
    CHECK(scpefe_container_unlock(container, &auth) == SCPEFE_STATUS_OK);
    CHECK(mode_is(container, 0, 1) == 0);
    CHECK(prepare_and_publish(container, &request, 4) == 0);
    CHECK(mode_is(container, 1, 1) == 0);

    request.action = SCPEFE_LEASE_RELEASE;
    request.expected_heartbeat_counter = 3;
    request.expected_holder_utc_ms = 122000;
    request.now_utc_ms = 123000;
    CHECK(prepare_and_publish(container, &request, 5) == 0);
    CHECK(mode_is(container, 0, 0) == 0);
    CHECK(lease_view(container, &view) == 0 && !view.lease_active);
    CHECK(scpefe_container_submit_content(container, "blocked", 7)
        == SCPEFE_STATUS_INVALID_STATE);

    request.action = SCPEFE_LEASE_ACQUIRE;
    request.session_id = session_b;
    request.expected_active = 0;
    request.expected_session_id = zero;
    request.expected_heartbeat_counter = 4;
    request.expected_holder_utc_ms = 123000;
    request.now_utc_ms = 124000;
    CHECK(prepare_and_publish(container, &request, 6) == 0);
    CHECK(mode_is(container, 1, 1) == 0);
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_unlock(container, &auth) == SCPEFE_STATUS_OK);
    request.action = SCPEFE_LEASE_TAKEOVER;
    request.session_id = session_a;
    request.expected_active = 1;
    request.expected_session_id = session_b;
    request.expected_heartbeat_counter = 1;
    request.expected_holder_utc_ms = 124000;
    request.now_utc_ms = 125000;
    request.operation_id = 7;
    CHECK(scpefe_container_prepare_lease_change(container, &request, &info)
        == SCPEFE_STATUS_INVALID_STATE);
    request.explicit_takeover = 1;
    CHECK(prepare_and_publish(container, &request, 7) == 0);
    CHECK(mode_is(container, 1, 1) == 0);
    CHECK(lease_view(container, &view) == 0
        && memcmp(view.lease_session_id, session_a, 16) == 0);
    CHECK(scpefe_container_revision_graph(container, &graph) == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_graph_heads(graph, after_head, after_content)
        == SCPEFE_STATUS_OK);
    CHECK(memcmp(head, after_head, 32) == 0
        && memcmp(content_head, after_content, 32) == 0);
    scpefe_revision_graph_destroy(graph);
    graph = NULL;
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    request.action = SCPEFE_LEASE_RELEASE;
    request.expected_session_id = session_a;
    request.expected_heartbeat_counter = 1;
    request.expected_holder_utc_ms = 125000;
    request.now_utc_ms = 126000;
    CHECK(prepare_and_publish(container, &request, 8) == 0);
    CHECK(scpefe_container_revision_graph(container, &graph) == SCPEFE_STATUS_LOCKED);
    CHECK(scpefe_container_unlock(container, &auth) == SCPEFE_STATUS_OK);
    CHECK(mode_is(container, 0, 0) == 0);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    return 0;
}
