#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "stateful invitation test line %d: %s\n", __LINE__, #x); return 1; } } while (0)

static scpefe_status clock_read(void *opaque, uint64_t *value)
{
    *value = *(uint64_t *)opaque;
    return SCPEFE_STATUS_OK;
}

static scpefe_container_slot_change_v1 request(uint64_t operation,
    scpefe_slot_change_kind kind, const char *password)
{
    scpefe_container_slot_change_v1 value = {0};
    value.struct_size = sizeof(value);
    value.abi_version = SCPEFE_ABI_VERSION;
    value.operation_id = operation;
    value.kind = kind;
    value.actor_password = (const uint8_t *)password;
    value.actor_password_size = strlen(password);
    value.client_name = "Ada";
    value.client_name_size = 3;
    value.client_email = "ada@example.test";
    value.client_email_size = 16;
    value.device = "test";
    value.device_size = 4;
    value.timestamp_ms = operation + 100;
    return value;
}

static int publish(scpefe_container *container,
    scpefe_container_slot_change_v1 *change)
{
    scpefe_candidate_info_v1 info = {sizeof(info), SCPEFE_ABI_VERSION};
    uint32_t effects = 0;
    CHECK(scpefe_container_prepare_slot_change(container, change, &info)
        == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_acknowledge_save(container, change->operation_id,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_OK);
    CHECK((effects & SCPEFE_EFFECT_ADOPT_CANDIDATE) != 0);
    return 0;
}

static int unlock(scpefe_container *container, const char *password,
    scpefe_status expected)
{
    scpefe_password_input_v1 input = {sizeof(input), SCPEFE_ABI_VERSION,
        (const uint8_t *)password, strlen(password)};
    CHECK(scpefe_container_unlock(container, &input) == expected);
    return 0;
}

int main(void)
{
    static const char owner[] = "c347416f-e467-4c0f-b56a-554ed7ba20b0";
    static const char recovery[] = "72aec31f-3abe-4fe7-aa90-ce43e4bc1b55";
    static const char temporary[] = "7291c2a9-9de9-441e-b0bf-f4736150aeec";
    static const char replacement[] = "64b7945b-a73b-4a13-9dbf-af716b54b97a";
    static const char rotated[] = "5adea1cf-37da-4f4d-b33b-0c3735eb1e6f";
    uint64_t time = 42;
    scpefe_host_services_v1 host = {sizeof(host), SCPEFE_ABI_VERSION,
        &time, clock_read};
    scpefe_container_create_v1 create = {0};
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    scpefe_container_slot_change_v1 change;
    scpefe_candidate_info_v1 info = {sizeof(info), SCPEFE_ABI_VERSION};
    scpefe_owned_slots *slots = NULL;
    scpefe_owned_slot_view_v1 view = {sizeof(view)};
    scpefe_container_status_v1 status = {sizeof(status), SCPEFE_ABI_VERSION};
    scpefe_owned_snapshot *snapshot = NULL;
    scpefe_revision_graph *history = NULL;
    uint8_t guest_id[16];
    size_t count = 0;
    create.struct_size = sizeof(create);
    create.abi_version = SCPEFE_ABI_VERSION;
    create.document.struct_size = sizeof(create.document);
    create.document.profile_name = "Ada";
    create.document.profile_name_size = 3;
    create.document.profile_email = "ada@example.test";
    create.document.profile_email_size = 16;
    create.document.device_name = "test";
    create.document.device_name_size = 4;
    create.document.content = "invitation content\n";
    create.document.content_size = strlen(create.document.content);
    create.document.timestamp_ms = 1;
    create.document.owner_password = (const uint8_t *)owner;
    create.document.owner_password_size = strlen(owner);
    create.document.recovery_password = (const uint8_t *)recovery;
    create.document.recovery_password_size = strlen(recovery);
    CHECK(scpefe_context_create(&host, &context) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_create(context, &create, &container) == SCPEFE_STATUS_OK);

    change = request(1, SCPEFE_SLOT_ADD_INVITATION, owner);
    change.name = "New colleague";
    change.name_size = strlen(change.name);
    change.new_password = (const uint8_t *)temporary;
    change.new_password_size = strlen(temporary);
    change.can_edit = 0;
    change.can_add_passwords = 1;
    CHECK(scpefe_container_prepare_slot_change(container, &change, &info)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    change.can_add_passwords = 0;
    CHECK(publish(container, &change) == 0);
    CHECK(scpefe_container_slots(container, &slots) == SCPEFE_STATUS_OK);
    CHECK(scpefe_owned_slots_count(slots, &count) == SCPEFE_STATUS_OK && count == 3);
    CHECK(scpefe_owned_slots_view(slots, 1, &view) == SCPEFE_STATUS_OK);
    CHECK(view.must_change_password && !view.can_edit && view.role == 1);
    CHECK(view.name_size == strlen("New colleague")
        && memcmp(view.name, "New colleague", view.name_size) == 0);
    memcpy(guest_id, view.slot_id, sizeof(guest_id));
    scpefe_owned_slots_destroy(slots); slots = NULL;

    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    CHECK(unlock(container, temporary, SCPEFE_STATUS_OK) == 0);
    CHECK(scpefe_container_status(container, &status) == SCPEFE_STATUS_OK);
    CHECK(status.must_change_password && !status.is_locked);
    CHECK(scpefe_container_read(container, &snapshot)
        == SCPEFE_STATUS_PASSWORD_CHANGE_REQUIRED && snapshot == NULL);
    CHECK(scpefe_container_revision_graph(container, &history)
        == SCPEFE_STATUS_PASSWORD_CHANGE_REQUIRED && history == NULL);
    CHECK(scpefe_container_slots(container, &slots)
        == SCPEFE_STATUS_PASSWORD_CHANGE_REQUIRED && slots == NULL);
    CHECK(scpefe_container_confirm_edit_lease(container)
        == SCPEFE_STATUS_INVALID_STATE);
    change = request(2, SCPEFE_SLOT_RECONCILE_IDENTITY, temporary);
    change.name = "Grace"; change.name_size = 5;
    change.email = "grace@example.test";
    change.email_size = strlen(change.email);
    CHECK(scpefe_container_prepare_slot_change(container, &change, &info)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    change = request(2, SCPEFE_SLOT_CLAIM_INVITATION, temporary);
    change.name = "Grace"; change.name_size = 5;
    change.email = "grace@example.test";
    change.email_size = strlen(change.email);
    change.new_password = (const uint8_t *)temporary;
    change.new_password_size = strlen(temporary);
    CHECK(scpefe_container_prepare_slot_change(container, &change, &info)
        == SCPEFE_STATUS_PASSWORD_ALREADY_IN_USE);
    change.new_password = (const uint8_t *)replacement;
    change.new_password_size = strlen(replacement);
    CHECK(publish(container, &change) == 0);
    CHECK(scpefe_container_read(container, &snapshot) == SCPEFE_STATUS_OK);
    scpefe_owned_snapshot_destroy(snapshot); snapshot = NULL;
    CHECK(scpefe_container_status(container, &status) == SCPEFE_STATUS_OK);
    CHECK(!status.must_change_password && !status.can_edit);
    CHECK(scpefe_container_slots(container, &slots) == SCPEFE_STATUS_OK);
    CHECK(scpefe_owned_slots_count(slots, &count) == SCPEFE_STATUS_OK && count == 1);
    CHECK(scpefe_owned_slots_view(slots, 0, &view) == SCPEFE_STATUS_OK);
    CHECK(memcmp(view.slot_id, guest_id, sizeof(guest_id)) == 0);
    CHECK(view.name_size == 5 && memcmp(view.name, "Grace", 5) == 0);
    scpefe_owned_slots_destroy(slots); slots = NULL;

    change = request(3, SCPEFE_SLOT_ADD_INVITATION, replacement);
    change.new_password = (const uint8_t *)rotated;
    change.new_password_size = strlen(rotated);
    change.name = "Nested"; change.name_size = 6;
    CHECK(scpefe_container_prepare_slot_change(container, &change, &info)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    change = request(3, SCPEFE_SLOT_CHANGE_PASSWORD, replacement);
    change.new_password = (const uint8_t *)rotated;
    change.new_password_size = strlen(rotated);
    CHECK(publish(container, &change) == 0);
    change = request(4, SCPEFE_SLOT_RECONCILE_IDENTITY, rotated);
    change.name = "Grace Hopper";
    change.name_size = strlen(change.name);
    change.email = "grace@example.test";
    change.email_size = strlen(change.email);
    CHECK(publish(container, &change) == 0);
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    CHECK(unlock(container, replacement, SCPEFE_STATUS_AUTHENTICATION_FAILED) == 0);
    CHECK(unlock(container, owner, SCPEFE_STATUS_OK) == 0);

    change = request(5, SCPEFE_SLOT_UPDATE_PERMISSIONS, owner);
    change.target_slot_id = guest_id;
    change.target_slot_id_size = sizeof(guest_id);
    change.can_edit = 1;
    CHECK(publish(container, &change) == 0);
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    CHECK(unlock(container, rotated, SCPEFE_STATUS_OK) == 0);
    CHECK(scpefe_container_status(container, &status) == SCPEFE_STATUS_OK);
    CHECK(status.can_edit && !status.can_remove_passwords);
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    CHECK(unlock(container, recovery, SCPEFE_STATUS_OK) == 0);
    change = request(6, SCPEFE_SLOT_REMOVE, recovery);
    change.target_slot_id = guest_id;
    change.target_slot_id_size = sizeof(guest_id);
    CHECK(publish(container, &change) == 0);
    CHECK(scpefe_container_slots(container, &slots) == SCPEFE_STATUS_OK);
    CHECK(scpefe_owned_slots_count(slots, &count) == SCPEFE_STATUS_OK && count == 2);
    scpefe_owned_slots_destroy(slots);
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    CHECK(unlock(container, rotated, SCPEFE_STATUS_AUTHENTICATION_FAILED) == 0);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    return 0;
}
