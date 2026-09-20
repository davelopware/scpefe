#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)

static int contains(const uint8_t *bytes, size_t size, const char *text)
{
    const size_t text_size = strlen(text);
    for (size_t i = 0; i + text_size <= size; ++i)
        if (memcmp(bytes + i, text, text_size) == 0) return 1;
    return 0;
}

static int update_lease(const uint8_t *container, size_t container_size,
    const char *password, scpefe_editing_lease_v1 lease,
    uint8_t **result, size_t *result_size)
{
    const scpefe_editing_lease_update_v1 update = {
        sizeof(scpefe_editing_lease_update_v1), container, container_size,
        (const uint8_t *)password, strlen(password), lease,
    };
    CHECK(scpefe_editing_lease_update(&update, NULL, 0, result_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    *result = (uint8_t *)malloc(*result_size);
    CHECK(*result != NULL);
    CHECK(scpefe_editing_lease_update(&update, *result, *result_size, result_size)
        == SCPEFE_STATUS_OK);
    return 0;
}

int main(void)
{
    static const char password[] = "owner passphrase with independent words";
    const scpefe_new_document_v1 document = {
        sizeof(scpefe_new_document_v1),
        "Ada", 3, "ada@example.test", 16, "Desk", 4,
        "text", 4, 1000,
        (const uint8_t *)password, sizeof(password) - 1, NULL, 0,
    };
    size_t original_size = 0;
    CHECK(scpefe_new_document_create(&document, NULL, 0, &original_size)
        == SCPEFE_STATUS_BUFFER_TOO_SMALL);
    uint8_t *original = (uint8_t *)malloc(original_size);
    CHECK(original != NULL);
    CHECK(scpefe_new_document_create(&document, original, original_size,
        &original_size) == SCPEFE_STATUS_OK);

    uint8_t session[SCPEFE_LEASE_SESSION_ID_SIZE];
    memset(session, 0x5a, sizeof(session));
    scpefe_editing_lease_v1 lease = {
        sizeof(scpefe_editing_lease_v1), 1, session, sizeof(session),
        1, 2000, 600000,
        "Ada", 3, "ada@example.test", 16, "Desk", 4,
    };
    uint8_t *acquired = NULL;
    size_t acquired_size = 0;
    CHECK(update_lease(original, original_size, password, lease,
        &acquired, &acquired_size) == 0);
    CHECK(!contains(acquired, acquired_size, "ada@example.test"));

    scpefe_unlocked_container *unlocked = NULL;
    CHECK(scpefe_password_container_unlock(acquired, acquired_size,
        (const uint8_t *)password, strlen(password), &unlocked) == SCPEFE_STATUS_OK);
    scpefe_editing_lease_v1 view = {0};
    view.struct_size = sizeof(view);
    CHECK(scpefe_unlocked_container_editing_lease(unlocked, &view)
        == SCPEFE_STATUS_OK);
    CHECK(view.active == 1 && view.heartbeat_counter == 1);
    CHECK(view.duration_ms == 600000 && view.holder_utc_ms == 2000);
    CHECK(memcmp(view.session_id, session, sizeof(session)) == 0);
    CHECK(view.holder_name_size == 3 && memcmp(view.holder_name, "Ada", 3) == 0);
    scpefe_unlocked_container_destroy(unlocked);

    lease.heartbeat_counter = 2;
    lease.holder_utc_ms = 122000;
    uint8_t *refreshed = NULL;
    size_t refreshed_size = 0;
    CHECK(update_lease(acquired, acquired_size, password, lease,
        &refreshed, &refreshed_size) == 0);
    lease.active = 0;
    uint8_t *released = NULL;
    size_t released_size = 0;
    CHECK(update_lease(refreshed, refreshed_size, password, lease,
        &released, &released_size) == 0);
    CHECK(scpefe_password_container_unlock(released, released_size,
        (const uint8_t *)password, strlen(password), &unlocked) == SCPEFE_STATUS_OK);
    view.struct_size = sizeof(view);
    CHECK(scpefe_unlocked_container_editing_lease(unlocked, &view)
        == SCPEFE_STATUS_OK);
    CHECK(view.active == 0 && view.heartbeat_counter == 2);
    scpefe_unlocked_container_destroy(unlocked);

    free(released);
    free(refreshed);
    free(acquired);
    free(original);
    return 0;
}
