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
    const size_t mib = 1024u * 1024u;
    const size_t capacity = 33u * mib;
    const size_t content_size = 8u * mib - 500u;
    const uint8_t password[] = "0b4e79c5-7cfe-4b7c-b4f3-d89129cb7b5e";
    uint8_t *initial = malloc(capacity);
    uint8_t *saved = malloc(capacity);
    char *name = malloc(8u * mib);
    char *email = malloc(8u * mib);
    char *device = malloc(8u * mib);
    char *content = malloc(content_size);
    CHECK(initial && saved && name && email && device && content);
    memset(name, 'n', 8u * mib);
    memset(email, 'e', 8u * mib);
    memset(device, 'd', 8u * mib);
    memset(content, 'c', content_size);

    scpefe_new_document_v1 document = {0};
    document.struct_size = sizeof(document);
    document.profile_name = "Ada";
    document.profile_name_size = 3;
    document.profile_email = "ada@example.org";
    document.profile_email_size = 15;
    document.device_name = "desktop";
    document.device_name_size = 7;
    document.content = "text";
    document.content_size = 4;
    document.owner_password = password;
    document.owner_password_size = sizeof(password) - 1;
    size_t initial_size = 0;
    CHECK(scpefe_new_document_create(&document, initial, capacity, &initial_size)
        == SCPEFE_STATUS_OK);

    scpefe_manual_save_v1 save = {0};
    save.struct_size = sizeof(save);
    save.container = initial;
    save.container_size = initial_size;
    save.password = password;
    save.password_size = sizeof(password) - 1;
    save.profile_name = name;
    save.profile_name_size = 8u * mib;
    save.profile_email = email;
    save.profile_email_size = 8u * mib;
    save.device_name = device;
    save.device_name_size = 8u * mib;
    save.content = content;
    save.content_size = content_size;
    size_t saved_size = 0;
    CHECK(scpefe_manual_save(&save, saved, capacity, &saved_size) == SCPEFE_STATUS_OK);
    CHECK(saved_size > 32u * mib && saved_size <= capacity);

    uint64_t time = 42;
    scpefe_host_services_v1 host = {sizeof(host), SCPEFE_ABI_VERSION, &time, clock_read};
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    CHECK(scpefe_context_create(&host, &context) == SCPEFE_STATUS_OK);
    scpefe_container_open_v1 open = {sizeof(open), SCPEFE_ABI_VERSION, saved, saved_size};
    CHECK(scpefe_container_open(context, &open, &container) == SCPEFE_STATUS_OK);
    CHECK(container != NULL);
    scpefe_password_input_v1 authentication = {sizeof(authentication), SCPEFE_ABI_VERSION,
        password, sizeof(password) - 1};
    CHECK(scpefe_container_unlock(container, &authentication) == SCPEFE_STATUS_OK);
    scpefe_owned_snapshot *snapshot = NULL;
    CHECK(scpefe_container_read(container, &snapshot) == SCPEFE_STATUS_OK);
    scpefe_owned_snapshot_view_v1 view = {0};
    view.struct_size = sizeof(view);
    view.abi_version = SCPEFE_ABI_VERSION;
    CHECK(scpefe_owned_snapshot_view(snapshot, &view) == SCPEFE_STATUS_OK);
    CHECK(view.content_size == content_size);
    CHECK(memcmp(view.content, content, content_size) == 0);
    scpefe_owned_snapshot_destroy(snapshot);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    free(content);
    free(device);
    free(email);
    free(name);
    free(saved);
    free(initial);
    return 0;
}
