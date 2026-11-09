#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static scpefe_status read_clock(void *instance, uint64_t *value)
{
    *value = *(uint64_t *)instance;
    return SCPEFE_STATUS_OK;
}

int main(int argc, char **argv)
{
    uint64_t now = 123;
    const uint8_t password[] = "0b4e79c5-7cfe-4b7c-b4f3-d89129cb7b5e";
    scpefe_host_services_v1 host = {sizeof(host), SCPEFE_ABI_VERSION, &now, read_clock};
    scpefe_container_create_v1 create = {0};
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    scpefe_owned_snapshot *snapshot = NULL;
    scpefe_owned_snapshot_view_v1 view = {0};
    uint8_t *encrypted = NULL;
    size_t size = 0;
    FILE *output = NULL;
    FILE *id_file = NULL;
    int result = 1;
    if (argc != 3) {
        fprintf(stderr, "usage: %s CONTAINER_FILE DOCUMENT_ID_FILE\n", argv[0]);
        return 2;
    }
    if (scpefe_context_create(&host, &context) != SCPEFE_STATUS_OK) goto done;
    create.struct_size = sizeof(create);
    create.abi_version = SCPEFE_ABI_VERSION;
    create.document.struct_size = sizeof(create.document);
    create.document.profile_name = "Ada";
    create.document.profile_name_size = 3;
    create.document.profile_email = "ada@example.org";
    create.document.profile_email_size = 15;
    create.document.device_name = "Windows fixture";
    create.document.device_name_size = 15;
    create.document.content = "alpha\n";
    create.document.content_size = 6;
    create.document.timestamp_ms = 123;
    create.document.owner_password = password;
    create.document.owner_password_size = sizeof(password) - 1;
    if (scpefe_container_create(context, &create, &container) != SCPEFE_STATUS_OK) goto done;
    if (scpefe_container_copy_bytes(container, NULL, 0, &size)
        != SCPEFE_STATUS_BUFFER_TOO_SMALL || size == 0) goto done;
    encrypted = (uint8_t *)malloc(size);
    if (!encrypted) goto done;
    if (scpefe_container_copy_bytes(container, encrypted, size, &size)
        != SCPEFE_STATUS_OK) goto done;
    if (scpefe_container_read(container, &snapshot) != SCPEFE_STATUS_OK) goto done;
    view.struct_size = sizeof(view);
    view.abi_version = SCPEFE_ABI_VERSION;
    if (scpefe_owned_snapshot_view(snapshot, &view) != SCPEFE_STATUS_OK) goto done;
    if (view.content_size != 6 || memcmp(view.content, "alpha\n", 6) != 0) goto done;
    output = fopen(argv[1], "wb");
    id_file = fopen(argv[2], "wb");
    if (!output || !id_file) goto done;
    if (fwrite(encrypted, 1, size, output) != size) goto done;
    for (size_t i = 0; i < SCPEFE_DOCUMENT_ID_SIZE; ++i) {
        if (fprintf(id_file, "%02x", view.document_id[i]) != 2) goto done;
    }
    if (fputc('\n', id_file) == EOF) goto done;
    result = 0;
done:
    if (output && fclose(output) != 0) result = 1;
    if (id_file && fclose(id_file) != 0) result = 1;
    scpefe_owned_snapshot_destroy(snapshot);
    if (container) scpefe_container_close(container);
    scpefe_context_destroy(context);
    free(encrypted);
    if (result) fprintf(stderr, "failed to create Android smoke fixture\n");
    return result;
}
