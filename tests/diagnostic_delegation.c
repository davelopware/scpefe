#include "scpefe/scpefe.h"

#include <stdlib.h>
#include <string.h>

/* Interposes only the public ABI to prove the CLI owns no container parser. */
scpefe_status scpefe_container_diagnostic_json(
    const scpefe_container_diagnostic_v1 *request,
    char *output, size_t capacity, size_t *size)
{
    static const char bytes[] = "deliberately not a container";
    static const char password[] = "delegation password";
    const char *json;
    *size = 0;
    if (!request || request->struct_size != sizeof(*request)
        || request->abi_version != SCPEFE_ABI_VERSION || !request->limits
        || request->bytes_size != sizeof(bytes) - 1
        || memcmp(request->bytes, bytes, sizeof(bytes) - 1) != 0
        || request->password_size != sizeof(password) - 1
        || memcmp(request->password, password, sizeof(password) - 1) != 0)
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    if (getenv("SCPEFE_TEST_DIAGNOSTIC_FAILURE")) return SCPEFE_STATUS_AUTHENTICATION_FAILED;
    json = request->include_content
        ? "{\"delegated_to_common_core\":true,\"content_requested\":true}"
        : "{\"delegated_to_common_core\":true,\"content_requested\":false}";
    *size = strlen(json);
    if (!output || capacity <= *size) return SCPEFE_STATUS_BUFFER_TOO_SMALL;
    memcpy(output, json, *size + 1);
    return SCPEFE_STATUS_OK;
}
