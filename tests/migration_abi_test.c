#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdio.h>

#define CHECK(expression) do { \
    if (!(expression)) { \
        fprintf(stderr, "check failed at line %d: %s\n", __LINE__, #expression); \
        return 1; \
    } \
} while (0)

/* Verifies migration rejects malformed lease identity spans before reading them. */
int main(void)
{
    const uint8_t container[] = {0};
    const uint8_t password[] = {'p'};
    const uint8_t session[SCPEFE_LEASE_SESSION_ID_SIZE] = {0};
    const char invalid_utf8[] = {(char)0xff};
    const char text[] = "Ada";
    size_t output_size = 0;
    scpefe_migration_v1 migration = {
        sizeof(migration), container, sizeof(container), password, sizeof(password),
        text, 3, text, 3, text, 3, 1,
        {sizeof(scpefe_editing_lease_v1), 1, session, sizeof(session), 1, 1,
            600000, text, 3, text, 3, text, 3}
    };

    migration.lease.holder_name = NULL;
    CHECK(scpefe_migrate_document(&migration, NULL, 0, &output_size)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    migration.lease.holder_name = text;

    migration.lease.holder_email = invalid_utf8;
    migration.lease.holder_email_size = sizeof(invalid_utf8);
    CHECK(scpefe_migrate_document(&migration, NULL, 0, &output_size)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    migration.lease.holder_email = text;
    migration.lease.holder_email_size = 3;

    migration.lease.device_name_size = 4097;
    CHECK(scpefe_migrate_document(&migration, NULL, 0, &output_size)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    return 0;
}
