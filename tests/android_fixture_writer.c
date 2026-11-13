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

static uint8_t *read_file(const char *path, size_t *size)
{
    FILE *input = fopen(path, "rb");
    uint8_t *bytes = NULL;
    long length;
    if (!input || fseek(input, 0, SEEK_END) != 0
        || (length = ftell(input)) < 0 || length > 33 * 1024 * 1024
        || fseek(input, 0, SEEK_SET) != 0) goto done;
    bytes = malloc((size_t)length + 1);
    if (!bytes || fread(bytes, 1, (size_t)length, input) != (size_t)length) {
        free(bytes); bytes = NULL; goto done;
    }
    bytes[length] = 0;
    *size = (size_t)length;
done:
    if (input) fclose(input);
    return bytes;
}

static int verify_android_container(const char *path, const char *id_path,
    const char *text_path)
{
    const uint8_t password[] = "0b4e79c5-7cfe-4b7c-b4f3-d89129cb7b5e";
    uint64_t now = 123;
    scpefe_host_services_v1 host = {sizeof(host), SCPEFE_ABI_VERSION, &now, read_clock};
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    scpefe_owned_snapshot *snapshot = NULL;
    scpefe_owned_authenticated_state *state = NULL;
    scpefe_owned_snapshot_view_v1 view = {0};
    scpefe_owned_authenticated_state_view_v1 authenticated = {0};
    size_t image_size = 0, id_size = 0, text_size = 0;
    uint8_t *image = read_file(path, &image_size);
    uint8_t *id = read_file(id_path, &id_size);
    uint8_t *text = read_file(text_path, &text_size);
    int result = 1, head_nonzero = 0;
    if (!image || !id || !text || image_size == 0 || id_size < 32) goto done;
    view.struct_size = sizeof(view);
    view.abi_version = SCPEFE_ABI_VERSION;
    authenticated.struct_size = sizeof(authenticated);
    authenticated.abi_version = SCPEFE_ABI_VERSION;
    scpefe_container_open_v1 open = {sizeof(open), SCPEFE_ABI_VERSION,
        image, image_size};
    scpefe_password_input_v1 unlock = {sizeof(unlock), SCPEFE_ABI_VERSION,
        password, sizeof(password) - 1};
    if (scpefe_context_create(&host, &context) != SCPEFE_STATUS_OK
        || scpefe_container_open(context, &open, &container) != SCPEFE_STATUS_OK
        || scpefe_container_unlock(container, &unlock) != SCPEFE_STATUS_OK
        || scpefe_container_read(container, &snapshot) != SCPEFE_STATUS_OK
        || scpefe_owned_snapshot_view(snapshot, &view) != SCPEFE_STATUS_OK
        || view.content_size != text_size
        || memcmp(view.content, text, text_size) != 0) goto done;
    for (size_t i = 0; i < SCPEFE_DOCUMENT_ID_SIZE; ++i) {
        char pair[3];
        snprintf(pair, sizeof(pair), "%02x", view.document_id[i]);
        if (memcmp(pair, id + i * 2, 2) != 0) goto done;
    }
    if (scpefe_container_authenticated_state(container, &state)
            != SCPEFE_STATUS_OK
        || scpefe_owned_authenticated_state_view(state, &authenticated)
            != SCPEFE_STATUS_OK
        || !authenticated.manually_sealed || !authenticated.lease_active) goto done;
    for (size_t i = 0; i < SCPEFE_REVISION_ID_SIZE; ++i)
        head_nonzero |= authenticated.revision_head[i];
    if (!head_nonzero) goto done;
    result = 0;
done:
    scpefe_owned_authenticated_state_destroy(state);
    scpefe_owned_snapshot_destroy(snapshot);
    if (container) scpefe_container_close(container);
    scpefe_context_destroy(context);
    free(image); free(id); free(text);
    if (result) fprintf(stderr, "Windows core rejected Android save: %s\n", path);
    return result;
}

int main(int argc, char **argv)
{
    if (argc == 5 && strcmp(argv[1], "--verify") == 0)
        return verify_android_container(argv[2], argv[3], argv[4]);
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
