#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "stateful password test line %d: %s\n", __LINE__, #x); return 1; } } while (0)

static scpefe_status clock_read(void *opaque, uint64_t *value)
{
    *value = *(uint64_t *)opaque;
    return SCPEFE_STATUS_OK;
}

static scpefe_container_slot_change_v1 change_request(uint64_t operation,
    const char *current, const char *next)
{
    scpefe_container_slot_change_v1 request = {0};
    request.struct_size = sizeof(request);
    request.abi_version = SCPEFE_ABI_VERSION;
    request.operation_id = operation;
    request.kind = SCPEFE_SLOT_CHANGE_PASSWORD;
    request.actor_password = (const uint8_t *)current;
    request.actor_password_size = strlen(current);
    request.new_password = (const uint8_t *)next;
    request.new_password_size = strlen(next);
    request.client_name = "Ada";
    request.client_name_size = 3;
    request.client_email = "ada@example.test";
    request.client_email_size = 16;
    request.device = "test";
    request.device_size = 4;
    request.timestamp_ms = 100 + operation;
    return request;
}

static int authenticate(scpefe_container *container, const char *password,
    scpefe_status expected)
{
    scpefe_password_input_v1 input = {sizeof(input), SCPEFE_ABI_VERSION,
        (const uint8_t *)password, strlen(password)};
    CHECK(scpefe_container_unlock(container, &input) == expected);
    return 0;
}

static int bytes_contain(const uint8_t *bytes, size_t size, const char *text)
{
    const size_t length = strlen(text);
    size_t index;
    if (length > size) return 0;
    for (index = 0; index <= size - length; ++index)
        if (memcmp(bytes + index, text, length) == 0) return 1;
    return 0;
}

static int copy_bytes(scpefe_container *container, uint8_t **bytes, size_t *size)
{
    CHECK(scpefe_container_copy_bytes(container, NULL, 0, size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    *bytes = malloc(*size);
    CHECK(*bytes != NULL);
    CHECK(scpefe_container_copy_bytes(container, *bytes, *size, size)
        == SCPEFE_STATUS_OK);
    return 0;
}

static int publish(scpefe_container *container,
    scpefe_container_slot_change_v1 *request)
{
    scpefe_candidate_info_v1 info = {sizeof(info), SCPEFE_ABI_VERSION};
    uint32_t effects = 0;
    CHECK(scpefe_container_prepare_slot_change(container, request, &info)
        == SCPEFE_STATUS_OK);
    CHECK(info.effect_mask == (SCPEFE_EFFECT_REREAD_TARGET
        | SCPEFE_EFFECT_JOURNAL_CANDIDATE | SCPEFE_EFFECT_PUBLISH_CANDIDATE));
    CHECK(scpefe_container_acknowledge_save(container, request->operation_id,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_OK);
    CHECK((effects & SCPEFE_EFFECT_ADOPT_CANDIDATE) != 0);
    return 0;
}

int main(void)
{
    static const char owner[] = "owner passphrase with independent words";
    static const char owner_new[] = "new owner passphrase with safer words";
    static const char recovery[] = "offline recovery passphrase is different";
    static const char recovery_new[] = "new recovery passphrase stored far offline";
    static const char wrong[] = "wrong but sufficiently lengthy passphrase";
    static const char *weak[] = {"short", "password123456",
        "orange orange orange orange orange", "one two three four five"};
    uint64_t time = 42;
    scpefe_host_services_v1 host = {sizeof(host), SCPEFE_ABI_VERSION,
        &time, clock_read};
    scpefe_container_create_v1 create = {0};
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    scpefe_container_slot_change_v1 request;
    scpefe_candidate_info_v1 info = {sizeof(info), SCPEFE_ABI_VERSION};
    scpefe_revision_graph *history = NULL;
    uint8_t base_head[32], base_content[32], next_head[32], next_content[32];
    uint8_t *before = NULL, *pending = NULL, *current = NULL;
    size_t before_size = 0, pending_size = 0, current_size = 0;
    uint32_t effects = 0;
    size_t index;
    create.struct_size = sizeof(create);
    create.abi_version = SCPEFE_ABI_VERSION;
    create.document.struct_size = sizeof(create.document);
    create.document.profile_name = "Ada";
    create.document.profile_name_size = 3;
    create.document.profile_email = "ada@example.test";
    create.document.profile_email_size = 16;
    create.document.device_name = "test";
    create.document.device_name_size = 4;
    create.document.content = "unchanged content and history\n";
    create.document.content_size = strlen(create.document.content);
    create.document.timestamp_ms = 1;
    create.document.owner_password = (const uint8_t *)owner;
    create.document.owner_password_size = sizeof(owner) - 1;
    create.document.recovery_password = (const uint8_t *)recovery;
    create.document.recovery_password_size = sizeof(recovery) - 1;
    CHECK(scpefe_context_create(&host, &context) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_create(context, &create, &container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_revision_graph(container, &history) == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_graph_heads(history, base_head, base_content) == SCPEFE_STATUS_OK);
    scpefe_revision_graph_destroy(history);
    CHECK(copy_bytes(container, &before, &before_size) == 0);

    request = change_request(1, wrong, owner_new);
    CHECK(scpefe_container_prepare_slot_change(container, &request, &info)
        == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    request = change_request(1, owner, recovery);
    CHECK(scpefe_container_prepare_slot_change(container, &request, &info)
        == SCPEFE_STATUS_PASSWORD_ALREADY_IN_USE);
    for (index = 0; index < sizeof(weak) / sizeof(weak[0]); ++index) {
        request = change_request(1, owner, weak[index]);
        CHECK(scpefe_container_prepare_slot_change(container, &request, &info)
            == SCPEFE_STATUS_WEAK_PASSWORD);
    }
    CHECK(copy_bytes(container, &current, &current_size) == 0);
    CHECK(current_size == before_size && memcmp(before, current, before_size) == 0);
    free(current); current = NULL;

    request = change_request(1, owner, owner_new);
    CHECK(scpefe_container_prepare_slot_change(container, &request, &info)
        == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_copy_candidate(container, 1, NULL, 0, &pending_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    pending = malloc(pending_size);
    CHECK(pending != NULL);
    CHECK(scpefe_container_copy_candidate(container, 1, pending, pending_size,
        &pending_size) == SCPEFE_STATUS_OK);
    CHECK(!bytes_contain(pending, pending_size, owner)
        && !bytes_contain(pending, pending_size, owner_new));
    CHECK(copy_bytes(container, &current, &current_size) == 0);
    CHECK(current_size == before_size && memcmp(before, current, before_size) == 0);
    free(current); current = NULL;
    CHECK(scpefe_container_acknowledge_save(container, 1,
        SCPEFE_PUBLICATION_DEFINITE_FAILURE, &effects) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_copy_candidate(container, 1, NULL, 0, &pending_size)
        == SCPEFE_STATUS_STALE_OPERATION);
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    CHECK(authenticate(container, owner_new, SCPEFE_STATUS_AUTHENTICATION_FAILED) == 0);
    CHECK(authenticate(container, owner, SCPEFE_STATUS_OK) == 0);
    request = change_request(2, owner, owner_new);
    CHECK(publish(container, &request) == 0);
    CHECK(scpefe_container_revision_graph(container, &history) == SCPEFE_STATUS_OK);
    CHECK(scpefe_revision_graph_heads(history, next_head, next_content) == SCPEFE_STATUS_OK);
    CHECK(memcmp(base_head, next_head, sizeof(base_head)) != 0);
    CHECK(memcmp(base_content, next_content, sizeof(base_content)) == 0);
    scpefe_revision_graph_destroy(history);
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    CHECK(authenticate(container, owner, SCPEFE_STATUS_AUTHENTICATION_FAILED) == 0);
    CHECK(authenticate(container, recovery, SCPEFE_STATUS_OK) == 0);
    request = change_request(3, recovery, recovery_new);
    CHECK(publish(container, &request) == 0);
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    CHECK(authenticate(container, recovery, SCPEFE_STATUS_AUTHENTICATION_FAILED) == 0);
    CHECK(authenticate(container, owner_new, SCPEFE_STATUS_OK) == 0);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    free(before); free(pending);
    scpefe_context_destroy(context);
    return 0;
}
