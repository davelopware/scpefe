#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stddef.h>
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
    uint64_t time = 1;
    const uint8_t password[] = "0b4e79c5-7cfe-4b7c-b4f3-d89129cb7b5e";
    scpefe_host_services_v1 host = {sizeof(host), SCPEFE_ABI_VERSION, &time, clock_read};
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    scpefe_container_create_v1 create = {0};
    create.struct_size = sizeof(create);
    create.abi_version = SCPEFE_ABI_VERSION;
    create.document.struct_size = sizeof(create.document);
    create.document.profile_name = "Ada";
    create.document.profile_name_size = 3;
    create.document.profile_email = "ada@example.org";
    create.document.profile_email_size = 15;
    create.document.device_name = "test";
    create.document.device_name_size = 4;
    create.document.content = "\"\"";
    create.document.content_size = 2;
    create.document.content_type = 1;
    create.document.timestamp_ms = 1;
    create.document.owner_password = password;
    create.document.owner_password_size = sizeof(password) - 1;
    CHECK(scpefe_context_create(&host, &context) == SCPEFE_STATUS_OK);
    create.document.content = "a,b\nc";
    create.document.content_size = 5;
    CHECK(scpefe_container_create(context, &create, &container)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    create.document.content = "\"\"";
    create.document.content_size = 2;
    CHECK(scpefe_container_create(context, &create, &container) == SCPEFE_STATUS_OK);
    uint8_t content_type = 255;
    CHECK(scpefe_container_content_type(container, &content_type) == SCPEFE_STATUS_OK);
    CHECK(content_type == 1);
    CHECK(scpefe_container_confirm_edit_lease(container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_submit_content(container, "a,b\nc", 5)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    const char valid[] = "\"\",name\n\"\",\"line\nbreak\"";
    CHECK(scpefe_container_submit_content(container, valid, sizeof(valid) - 1)
        == SCPEFE_STATUS_OK);
    scpefe_container_save_v1 save = {0};
    save.struct_size = sizeof(save);
    save.abi_version = SCPEFE_ABI_VERSION;
    save.operation_id = 1;
    save.kind = SCPEFE_SAVE_MANUAL;
    save.password = password;
    save.password_size = sizeof(password) - 1;
    save.profile_name = "Ada";
    save.profile_name_size = 3;
    save.profile_email = "ada@example.org";
    save.profile_email_size = 15;
    save.device_name = "test";
    save.device_name_size = 4;
    save.timestamp_ms = 2;
    scpefe_candidate_info_v1 candidate = {sizeof(candidate), SCPEFE_ABI_VERSION};
    CHECK(scpefe_container_prepare_save(container, &save, &candidate) == SCPEFE_STATUS_OK);
    uint32_t effects = 0;
    CHECK(scpefe_container_acknowledge_save(container, 1,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_OK);
    size_t size = 0;
    CHECK(scpefe_container_copy_bytes(container, NULL, 0, &size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *bytes = malloc(size);
    CHECK(bytes != NULL);
    CHECK(scpefe_container_copy_bytes(container, bytes, size, &size) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_container_open_v1 open = {sizeof(open), SCPEFE_ABI_VERSION, bytes, size};
    CHECK(scpefe_container_open(context, &open, &container) == SCPEFE_STATUS_OK);
    scpefe_password_input_v1 unlock = {sizeof(unlock), SCPEFE_ABI_VERSION,
        password, sizeof(password) - 1};
    CHECK(scpefe_container_unlock(container, &unlock) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_content_type(container, &content_type) == SCPEFE_STATUS_OK);
    CHECK(content_type == 1);
    scpefe_owned_snapshot *snapshot = NULL;
    scpefe_owned_snapshot_view_v1 view = {sizeof(view), SCPEFE_ABI_VERSION};
    CHECK(scpefe_container_read(container, &snapshot) == SCPEFE_STATUS_OK);
    CHECK(scpefe_owned_snapshot_view(snapshot, &view) == SCPEFE_STATUS_OK);
    CHECK(view.content_size == sizeof(valid) - 1);
    CHECK(memcmp(view.content, valid, sizeof(valid) - 1) == 0);
    scpefe_owned_snapshot_destroy(snapshot);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    create.struct_size = offsetof(scpefe_container_create_v1, document)
        + offsetof(scpefe_new_document_v1, content_type);
    create.document.struct_size = offsetof(scpefe_new_document_v1, content_type);
    create.document.content = "a,b\nc";
    create.document.content_size = 5;
    CHECK(scpefe_container_create(context, &create, &container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_content_type(container, &content_type) == SCPEFE_STATUS_OK);
    CHECK(content_type == 0);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    free(bytes);
    return 0;
}
