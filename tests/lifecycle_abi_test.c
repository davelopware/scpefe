#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)

static scpefe_status clock_read(void *instance, uint64_t *value)
{
    *value = *(uint64_t *)instance;
    return SCPEFE_STATUS_OK;
}

int main(void)
{
    uint64_t time = 42;
    scpefe_host_services_v1 host = {sizeof(host), SCPEFE_ABI_VERSION, &time, clock_read};
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    scpefe_container *second = NULL;
    scpefe_container *closed_handle = NULL;
    scpefe_context *other_context = NULL;
    scpefe_container *other_container = NULL;
    const uint8_t password[] = "0b4e79c5-7cfe-4b7c-b4f3-d89129cb7b5e";
    const uint8_t wrong[] = "f5ee6791-97ad-44bc-8a72-b79b7b26316a";
    scpefe_container_create_v1 create = {0};
    scpefe_container_open_v1 open = {0};
    scpefe_password_input_v1 authentication = {sizeof(authentication), SCPEFE_ABI_VERSION,
        password, sizeof(password) - 1};
    scpefe_container_status_v1 status = {0};
    scpefe_owned_snapshot_view_v1 view = {0};
    scpefe_owned_snapshot *snapshot = NULL;
    scpefe_owned_snapshot *retained_snapshot = NULL;
    uint8_t *encrypted = NULL;
    size_t encrypted_size = 0;

    CHECK(scpefe_context_create(&host, &context) == SCPEFE_STATUS_OK);
    create.struct_size = sizeof(create);
    create.abi_version = SCPEFE_ABI_VERSION;
    create.document.struct_size = sizeof(create.document);
    create.document.profile_name = "Ada";
    create.document.profile_name_size = 3;
    create.document.profile_email = "ada@example.org";
    create.document.profile_email_size = 15;
    create.document.device_name = "test";
    create.document.device_name_size = 4;
    create.document.content = "first line";
    create.document.content_size = 10;
    create.document.timestamp_ms = 123;
    create.document.owner_password = password;
    create.document.owner_password_size = sizeof(password) - 1;
    create.abi_version = 999;
    CHECK(scpefe_container_create(context, &create, &container) == SCPEFE_STATUS_UNSUPPORTED_ABI);
    create.abi_version = SCPEFE_ABI_VERSION;
    create.document.owner_password_size = 4097;
    CHECK(scpefe_container_create(context, &create, &container) == SCPEFE_STATUS_LIMIT_EXCEEDED);
    create.document.owner_password_size = sizeof(password) - 1;
    create.document.owner_password = (const uint8_t *)"weak";
    create.document.owner_password_size = 4;
    CHECK(scpefe_container_create(context, &create, &container) == SCPEFE_STATUS_WEAK_PASSWORD);
    create.document.owner_password = password;
    create.document.owner_password_size = sizeof(password) - 1;
    create.document.content = NULL;
    CHECK(scpefe_container_create(context, &create, &container)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    CHECK(container == NULL);
    create.document.content = "first line";
    create.document.struct_size = sizeof(create.document) - 1;
    CHECK(scpefe_container_create(context, &create, &container)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    create.document.struct_size = sizeof(create.document);
    CHECK(scpefe_container_create(context, &create, &container) == SCPEFE_STATUS_OK);
    CHECK(container != NULL);
    CHECK(scpefe_context_create(&host, &other_context) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_create(other_context, &create, &other_container)
        == SCPEFE_STATUS_OK);
    CHECK(other_container != container);
    CHECK(scpefe_container_create(context, &create, &second)
        == SCPEFE_STATUS_INVALID_STATE);

    status.struct_size = sizeof(status);
    status.abi_version = SCPEFE_ABI_VERSION;
    CHECK(scpefe_container_status(container, &status) == SCPEFE_STATUS_OK);
    CHECK(!status.is_locked && status.can_edit && status.can_add_passwords);
    status.abi_version = 999;
    CHECK(scpefe_container_status(container, &status) == SCPEFE_STATUS_UNSUPPORTED_ABI);
    status.abi_version = SCPEFE_ABI_VERSION;
    CHECK(scpefe_container_copy_bytes(container, NULL, 0, &encrypted_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    CHECK(encrypted_size > 160);
    encrypted = malloc(encrypted_size);
    CHECK(encrypted != NULL);
    CHECK(scpefe_container_copy_bytes(container, encrypted, encrypted_size, &encrypted_size)
        == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_read(container, &snapshot) == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    view.abi_version = SCPEFE_ABI_VERSION;
    CHECK(scpefe_owned_snapshot_view(snapshot, &view) == SCPEFE_STATUS_OK);
    CHECK(view.content_size == 10 && memcmp(view.content, "first line", 10) == 0);
    CHECK(view.encoded_revision_size > 0);
    view.abi_version = 999;
    CHECK(scpefe_owned_snapshot_view(snapshot, &view) == SCPEFE_STATUS_UNSUPPORTED_ABI);
    view.abi_version = SCPEFE_ABI_VERSION;
    retained_snapshot = snapshot;
    snapshot = NULL;

    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_read(container, &snapshot) == SCPEFE_STATUS_LOCKED);
    CHECK(snapshot == NULL);
    CHECK(scpefe_owned_snapshot_view(retained_snapshot, &view) == SCPEFE_STATUS_OK);
    CHECK(view.content_size == 10 && memcmp(view.content, "first line", 10) == 0);
    CHECK(scpefe_container_status(container, &status) == SCPEFE_STATUS_OK);
    CHECK(status.is_locked && !status.can_edit);
    CHECK(scpefe_container_status(other_container, &status) == SCPEFE_STATUS_OK);
    CHECK(!status.is_locked && status.can_edit);
    CHECK(scpefe_container_close(other_container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(other_context);
    authentication.bytes = wrong;
    authentication.bytes_size = sizeof(wrong) - 1;
    CHECK(scpefe_container_unlock(container, &authentication)
        == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    CHECK(scpefe_container_read(container, &snapshot) == SCPEFE_STATUS_LOCKED);
    authentication.abi_version = 999;
    CHECK(scpefe_container_unlock(container, &authentication)
        == SCPEFE_STATUS_UNSUPPORTED_ABI);
    authentication.abi_version = SCPEFE_ABI_VERSION;
    authentication.bytes = NULL;
    CHECK(scpefe_container_unlock(container, &authentication)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    authentication.bytes = wrong;
    authentication.bytes_size = 4097;
    CHECK(scpefe_container_unlock(container, &authentication)
        == SCPEFE_STATUS_LIMIT_EXCEEDED);
    authentication.bytes = password;
    authentication.bytes_size = sizeof(password) - 1;
    CHECK(scpefe_container_unlock(container, &authentication) == SCPEFE_STATUS_OK);
    closed_handle = container;
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_read(container, &snapshot) == SCPEFE_STATUS_INVALID_STATE);
    CHECK(scpefe_owned_snapshot_view(retained_snapshot, &view) == SCPEFE_STATUS_OK);
    CHECK(view.content_size == 10 && memcmp(view.content, "first line", 10) == 0);

    open.struct_size = sizeof(open);
    open.abi_version = SCPEFE_ABI_VERSION;
    open.bytes = encrypted;
    open.bytes_size = encrypted_size;
    open.bytes_size = 33u * 1024u * 1024u + 1u;
    CHECK(scpefe_container_open(context, &open, &container) == SCPEFE_STATUS_LIMIT_EXCEEDED);
    open.bytes_size = encrypted_size;
    encrypted[7] = 2;
    encrypted[8] = 2;
    CHECK(scpefe_container_open(context, &open, &container) == SCPEFE_STATUS_UNSUPPORTED_FORMAT);
    encrypted[7] = 3;
    encrypted[8] = 3;
    encrypted[0] = 0;
    CHECK(scpefe_container_open(context, &open, &container) == SCPEFE_STATUS_MALFORMED_CONTAINER);
    encrypted[0] = 'S';
    CHECK(scpefe_container_open(context, &open, &container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_lock(closed_handle) == SCPEFE_STATUS_INVALID_STATE);
    CHECK(scpefe_container_read(container, &snapshot) == SCPEFE_STATUS_LOCKED);
    CHECK(snapshot == NULL);
    CHECK(scpefe_container_unlock(container, &authentication) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_read(container, &snapshot) == SCPEFE_STATUS_OK);
    scpefe_owned_snapshot_destroy(snapshot);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);

    open.abi_version = 999;
    CHECK(scpefe_container_open(context, &open, &container) == SCPEFE_STATUS_UNSUPPORTED_ABI);
    open.abi_version = SCPEFE_ABI_VERSION;
    open.bytes = NULL;
    CHECK(scpefe_container_open(context, &open, &container) == SCPEFE_STATUS_INVALID_ARGUMENT);
    free(encrypted);
    scpefe_context_destroy(context);
    CHECK(scpefe_owned_snapshot_view(retained_snapshot, &view) == SCPEFE_STATUS_OK);
    CHECK(view.content_size == 10 && memcmp(view.content, "first line", 10) == 0);
    scpefe_owned_snapshot_destroy(retained_snapshot);
    return 0;
}
