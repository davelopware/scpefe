#include "scpefe/scpefe.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "slot ABI failed at %d: %s\n", __LINE__, #x); return 1; } } while (0)

static scpefe_status clock_read(void *opaque, uint64_t *value)
{
    *value = *(uint64_t *)opaque;
    return SCPEFE_STATUS_OK;
}

static void request_defaults(scpefe_container_slot_change_v1 *request,
    uint64_t id, scpefe_slot_change_kind kind, const uint8_t *password,
    size_t password_size)
{
    memset(request, 0, sizeof(*request));
    request->struct_size = sizeof(*request);
    request->abi_version = SCPEFE_ABI_VERSION;
    request->operation_id = id;
    request->kind = kind;
    request->actor_password = password;
    request->actor_password_size = password_size;
    request->client_name = "Ada";
    request->client_name_size = 3;
    request->client_email = "ada@example.org";
    request->client_email_size = 15;
    request->device = "test";
    request->device_size = 4;
    request->timestamp_ms = id + 100;
}

static int publish(scpefe_container *container,
    scpefe_container_slot_change_v1 *request)
{
    scpefe_candidate_info_v1 info = {0};
    uint32_t effects = 0;
    info.struct_size = sizeof(info);
    info.abi_version = SCPEFE_ABI_VERSION;
    CHECK(scpefe_container_prepare_slot_change(container, request, &info)
        == SCPEFE_STATUS_OK);
    CHECK(info.operation_id == request->operation_id && info.byte_size > 100);
    CHECK(info.effect_mask == (SCPEFE_EFFECT_REREAD_TARGET
        | SCPEFE_EFFECT_JOURNAL_CANDIDATE | SCPEFE_EFFECT_PUBLISH_CANDIDATE));
    CHECK(scpefe_container_acknowledge_save(container, request->operation_id,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_OK);
    CHECK((effects & SCPEFE_EFFECT_ADOPT_CANDIDATE) != 0);
    return 0;
}

static int unlock(scpefe_container *container, const uint8_t *password, size_t size)
{
    scpefe_password_input_v1 input = {sizeof(input), SCPEFE_ABI_VERSION,
        password, size};
    CHECK(scpefe_container_unlock(container, &input) == SCPEFE_STATUS_OK);
    return 0;
}

int main(void)
{
    uint64_t time = 42;
    const uint8_t owner[] = "0b4e79c5-7cfe-4b7c-b4f3-d89129cb7b5e";
    const uint8_t recovery[] = "f5ee6791-97ad-44bc-8a72-b79b7b26316a";
    const uint8_t temporary[] = "7f12c2e1-f92d-49c7-9e89-e9076b8d5be8";
    const uint8_t lasting[] = "288850e7-186a-4a80-8c9c-629318577055";
    const uint8_t rotated[] = "c53c1e49-f0a3-4545-89bf-1ff3c5d3a222";
    const uint8_t admin_temp[] = "f2bb9689-514e-4e6d-8cd8-bf7bd96345ce";
    const uint8_t admin_lasting[] = "6d04b4fd-e76c-4c63-a11c-c83bb58e9406";
    scpefe_host_services_v1 host = {sizeof(host), SCPEFE_ABI_VERSION,
        &time, clock_read};
    scpefe_context *context = NULL;
    scpefe_container *container = NULL;
    scpefe_container_create_v1 create = {0};
    scpefe_container_slot_change_v1 change;
    scpefe_candidate_info_v1 info = {sizeof(info), SCPEFE_ABI_VERSION};
    scpefe_owned_slots *retained = NULL, *slots = NULL;
    scpefe_owned_slot_view_v1 view = {sizeof(view)};
    size_t count = 0;
    uint8_t guest_id[16];
    scpefe_password_policy_assessment assessment = SCPEFE_PASSWORD_POLICY_INVALID;
    create.struct_size = sizeof(create);
    create.abi_version = SCPEFE_ABI_VERSION;
    create.document.struct_size = sizeof(create.document);
    create.document.profile_name = "Ada";
    create.document.profile_name_size = 3;
    create.document.profile_email = "ada@example.org";
    create.document.profile_email_size = 15;
    create.document.device_name = "test";
    create.document.device_name_size = 4;
    create.document.content = "alpha\n";
    create.document.content_size = 6;
    create.document.timestamp_ms = 1;
    create.document.owner_password = owner;
    create.document.owner_password_size = sizeof(owner) - 1;
    create.document.recovery_password = recovery;
    create.document.recovery_password_size = sizeof(recovery) - 1;
    CHECK(scpefe_context_create(&host, &context) == SCPEFE_STATUS_OK);
    CHECK(scpefe_context_assess_password(context, (const uint8_t *)"short", 5,
        &assessment) == SCPEFE_STATUS_OK
        && assessment == SCPEFE_PASSWORD_POLICY_MINIMUM_LENGTH);
    CHECK(scpefe_context_assess_password(context, owner, sizeof(owner) - 1,
        &assessment) == SCPEFE_STATUS_OK
        && assessment == SCPEFE_PASSWORD_POLICY_ACCEPTED);
    CHECK(scpefe_container_create(context, &create, &container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_slots(container, &slots) == SCPEFE_STATUS_OK);
    CHECK(scpefe_owned_slots_count(slots, &count) == SCPEFE_STATUS_OK && count == 2);
    scpefe_owned_slots_destroy(slots);

    request_defaults(&change, 1, SCPEFE_SLOT_CHANGE_PASSWORD,
        owner, sizeof(owner) - 1);
    change.new_password = recovery;
    change.new_password_size = sizeof(recovery) - 1;
    CHECK(scpefe_container_prepare_slot_change(container, &change, &info)
        == SCPEFE_STATUS_PASSWORD_ALREADY_IN_USE);
    change.new_password = rotated;
    change.new_password_size = sizeof(rotated) - 1;
    info.abi_version = SCPEFE_ABI_VERSION + 1;
    CHECK(scpefe_container_prepare_slot_change(container, &change, &info)
        == SCPEFE_STATUS_UNSUPPORTED_ABI);
    {
        size_t ignored_size = 0;
        CHECK(scpefe_container_copy_candidate(container, change.operation_id,
            NULL, 0, &ignored_size) == SCPEFE_STATUS_STALE_OPERATION);
    }
    info.abi_version = SCPEFE_ABI_VERSION;
    CHECK(publish(container, &change) == 0);
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    {
        scpefe_password_input_v1 old = {sizeof(old), SCPEFE_ABI_VERSION,
            owner, sizeof(owner) - 1};
        CHECK(scpefe_container_unlock(container, &old)
            == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    }
    CHECK(unlock(container, recovery, sizeof(recovery) - 1) == 0);
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    CHECK(unlock(container, rotated, sizeof(rotated) - 1) == 0);

    request_defaults(&change, 2, SCPEFE_SLOT_ADD_INVITATION,
        rotated, sizeof(rotated) - 1);
    change.new_password = temporary;
    change.new_password_size = sizeof(temporary) - 1;
    change.name = "Guest";
    change.name_size = 5;
    change.new_password = (const uint8_t *)"short";
    change.new_password_size = 5;
    CHECK(scpefe_container_prepare_slot_change(container, &change, &info)
        == SCPEFE_STATUS_WEAK_PASSWORD);
    change.new_password = temporary;
    change.new_password_size = sizeof(temporary) - 1;
    CHECK(publish(container, &change) == 0);
    CHECK(scpefe_container_slots(container, &slots) == SCPEFE_STATUS_OK);
    CHECK(scpefe_owned_slots_count(slots, &count) == SCPEFE_STATUS_OK && count == 3);
    CHECK(scpefe_owned_slots_view(slots, 1, &view) == SCPEFE_STATUS_OK);
    CHECK(view.role == 1 && view.must_change_password && !view.can_edit);
    memcpy(guest_id, view.slot_id, sizeof(guest_id));
    retained = slots;
    slots = NULL;
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_slots(container, &slots) == SCPEFE_STATUS_LOCKED);
    CHECK(scpefe_owned_slots_view(retained, 1, &view) == SCPEFE_STATUS_OK);
    CHECK(view.name_size == 5 && memcmp(view.name, "Guest", 5) == 0);
    CHECK(unlock(container, temporary, sizeof(temporary) - 1) == 0);
    {
        scpefe_container_status_v1 status = {sizeof(status), SCPEFE_ABI_VERSION};
        scpefe_owned_snapshot *content = NULL;
        scpefe_revision_graph *history = NULL;
        CHECK(scpefe_container_status(container, &status) == SCPEFE_STATUS_OK);
        CHECK(!status.is_locked && status.must_change_password);
        CHECK(scpefe_container_read(container, &content)
            == SCPEFE_STATUS_PASSWORD_CHANGE_REQUIRED && content == NULL);
        CHECK(scpefe_container_revision_graph(container, &history)
            == SCPEFE_STATUS_PASSWORD_CHANGE_REQUIRED && history == NULL);
        CHECK(scpefe_container_slots(container, &slots)
            == SCPEFE_STATUS_PASSWORD_CHANGE_REQUIRED && slots == NULL);
        CHECK(scpefe_container_confirm_edit_lease(container)
            == SCPEFE_STATUS_INVALID_STATE);
    }

    request_defaults(&change, 3, SCPEFE_SLOT_CLAIM_INVITATION,
        temporary, sizeof(temporary) - 1);
    change.new_password = lasting;
    change.new_password_size = sizeof(lasting) - 1;
    change.name = "Guest";
    change.name_size = 5;
    change.email = "guest@example.org";
    change.email_size = 17;
    CHECK(publish(container, &change) == 0);
    {
        scpefe_owned_snapshot *content = NULL;
        CHECK(scpefe_container_read(container, &content) == SCPEFE_STATUS_OK);
        scpefe_owned_snapshot_destroy(content);
    }
    CHECK(scpefe_container_slots(container, &slots) == SCPEFE_STATUS_OK);
    CHECK(scpefe_owned_slots_count(slots, &count) == SCPEFE_STATUS_OK && count == 1);
    CHECK(scpefe_owned_slots_view(slots, 0, &view) == SCPEFE_STATUS_OK);
    CHECK(!view.must_change_password && view.role == 1);
    scpefe_owned_slots_destroy(slots);
    slots = NULL;

    request_defaults(&change, 4, SCPEFE_SLOT_RECONCILE_IDENTITY,
        lasting, sizeof(lasting) - 1);
    change.name = "Grace";
    change.name_size = 5;
    change.email = "grace@example.org";
    change.email_size = 17;
    CHECK(publish(container, &change) == 0);
    request_defaults(&change, 5, SCPEFE_SLOT_ADD_INVITATION,
        lasting, sizeof(lasting) - 1);
    change.new_password = owner;
    change.new_password_size = sizeof(owner) - 1;
    change.name = "No";
    change.name_size = 2;
    CHECK(scpefe_container_prepare_slot_change(container, &change, &info)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    change.new_password = recovery;
    change.new_password_size = sizeof(recovery) - 1;
    CHECK(scpefe_container_prepare_slot_change(container, &change, &info)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    CHECK(unlock(container, rotated, sizeof(rotated) - 1) == 0);

    request_defaults(&change, 5, SCPEFE_SLOT_UPDATE_PERMISSIONS,
        rotated, sizeof(rotated) - 1);
    change.target_slot_id = guest_id;
    change.target_slot_id_size = sizeof(guest_id);
    change.can_edit = 1;
    CHECK(publish(container, &change) == 0);
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    CHECK(unlock(container, lasting, sizeof(lasting) - 1) == 0);
    {
        scpefe_container_status_v1 status = {sizeof(status), SCPEFE_ABI_VERSION};
        CHECK(scpefe_container_status(container, &status) == SCPEFE_STATUS_OK);
        CHECK(status.can_edit && !status.can_add_passwords
            && !status.can_remove_passwords);
    }
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    CHECK(unlock(container, rotated, sizeof(rotated) - 1) == 0);
    request_defaults(&change, 6, SCPEFE_SLOT_REMOVE,
        rotated, sizeof(rotated) - 1);
    change.target_slot_id = guest_id;
    change.target_slot_id_size = sizeof(guest_id);
    CHECK(publish(container, &change) == 0);
    CHECK(scpefe_container_prepare_slot_change(container, &change, &info)
        == SCPEFE_STATUS_STALE_OPERATION);
    CHECK(scpefe_container_slots(container, &slots) == SCPEFE_STATUS_OK);
    CHECK(scpefe_owned_slots_count(slots, &count) == SCPEFE_STATUS_OK && count == 2);
    scpefe_owned_slots_destroy(slots);

    {
        scpefe_revision_graph *graph = NULL;
        scpefe_revision_page *page = NULL;
        scpefe_revision_metadata_v1 metadata = {sizeof(metadata)};
        CHECK(scpefe_container_revision_graph(container, &graph) == SCPEFE_STATUS_OK);
        CHECK(scpefe_revision_graph_list(graph, 0, 1, &page) == SCPEFE_STATUS_OK);
        CHECK(scpefe_revision_page_metadata(page, 0, &metadata) == SCPEFE_STATUS_OK);
        CHECK(metadata.original_kind == 2 && metadata.storage_kind == 0);
        CHECK(metadata.event_details_cbor_size < 128);
        {
            size_t json_size = 0;
            char *json;
            CHECK(scpefe_revision_graph_diagnostic_json(graph, 0, NULL, 0,
                &json_size) == SCPEFE_STATUS_BUFFER_TOO_SMALL);
            json = malloc(json_size + 1);
            CHECK(json != NULL);
            CHECK(scpefe_revision_graph_diagnostic_json(graph, 0, json,
                json_size + 1, &json_size) == SCPEFE_STATUS_OK);
            CHECK(strstr(json, (const char *)temporary) == NULL);
            CHECK(strstr(json, (const char *)lasting) == NULL);
            CHECK(strstr(json, (const char *)rotated) == NULL);
            free(json);
        }
        scpefe_revision_page_destroy(page);
        scpefe_revision_graph_destroy(graph);
    }
    request_defaults(&change, 7, SCPEFE_SLOT_ADD_INVITATION,
        rotated, sizeof(rotated) - 1);
    change.new_password = admin_temp;
    change.new_password_size = sizeof(admin_temp) - 1;
    change.name = "Admin";
    change.name_size = 5;
    change.can_edit = change.can_add_passwords = change.can_remove_passwords = 1;
    CHECK(publish(container, &change) == 0);
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    CHECK(unlock(container, admin_temp, sizeof(admin_temp) - 1) == 0);
    request_defaults(&change, 8, SCPEFE_SLOT_CLAIM_INVITATION,
        admin_temp, sizeof(admin_temp) - 1);
    change.new_password = admin_lasting;
    change.new_password_size = sizeof(admin_lasting) - 1;
    change.name = "Admin";
    change.name_size = 5;
    change.email = "admin@example.org";
    change.email_size = 17;
    CHECK(publish(container, &change) == 0);
    CHECK(scpefe_container_slots(container, &slots) == SCPEFE_STATUS_OK);
    CHECK(scpefe_owned_slots_view(slots, 1, &view) == SCPEFE_STATUS_OK);
    memcpy(guest_id, view.slot_id, sizeof(guest_id));
    scpefe_owned_slots_destroy(slots);
    slots = NULL;
    request_defaults(&change, 9, SCPEFE_SLOT_REMOVE,
        admin_lasting, sizeof(admin_lasting) - 1);
    change.target_slot_id = guest_id;
    change.target_slot_id_size = sizeof(guest_id);
    CHECK(publish(container, &change) == 0);
    CHECK(scpefe_container_slots(container, &slots) == SCPEFE_STATUS_LOCKED);
    {
        scpefe_password_input_v1 removed = {sizeof(removed), SCPEFE_ABI_VERSION,
            admin_lasting, sizeof(admin_lasting) - 1};
        CHECK(scpefe_container_unlock(container, &removed)
            == SCPEFE_STATUS_AUTHENTICATION_FAILED);
    }
    CHECK(unlock(container, recovery, sizeof(recovery) - 1) == 0);
    CHECK(scpefe_container_slots(container, &slots) == SCPEFE_STATUS_OK);
    CHECK(scpefe_owned_slots_count(slots, &count) == SCPEFE_STATUS_OK && count == 2);
    scpefe_owned_slots_destroy(slots);
    {
        static const char *invites[] = {
            "95f82493-f3b4-4bf8-9115-c5ea117bb879",
            "ce534a45-a69a-40d3-9a33-7f8d18f19e07",
            "af92cabf-1b4e-4821-bc2d-48c282604454",
            "86583cd4-0f3c-4dab-ad9c-10aa87dd8135",
            "a2e2fd7d-f890-488e-959f-254660774c2b",
            "32c00cc5-84b6-44cb-a513-6db48bb52c26",
            "c3e59fd8-40ae-4020-a53d-9e7d0f551fce",
            "f6760a54-cc7d-4722-83de-730dcd03386b"
        };
        size_t i;
        for (i = 0; i < 7; ++i) {
            request_defaults(&change, 10 + i, SCPEFE_SLOT_ADD_INVITATION,
                recovery, sizeof(recovery) - 1);
            change.new_password = (const uint8_t *)invites[i];
            change.new_password_size = strlen(invites[i]);
            change.name = "Pending";
            change.name_size = 7;
            CHECK(publish(container, &change) == 0);
        }
        request_defaults(&change, 17, SCPEFE_SLOT_ADD_INVITATION,
            recovery, sizeof(recovery) - 1);
        change.new_password = (const uint8_t *)invites[7];
        change.new_password_size = strlen(invites[7]);
        change.name = "Pending";
        change.name_size = 7;
        CHECK(scpefe_container_prepare_slot_change(container, &change, &info)
            == SCPEFE_STATUS_LIMIT_EXCEEDED);
        CHECK(scpefe_container_slots(container, &slots) == SCPEFE_STATUS_OK);
        CHECK(scpefe_owned_slots_count(slots, &count) == SCPEFE_STATUS_OK
            && count == 9);
        scpefe_owned_slots_destroy(slots);
        slots = NULL;
    }

    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_owned_slots_view(retained, 1, &view) == SCPEFE_STATUS_OK);
    scpefe_owned_slots_destroy(retained);
    scpefe_context_destroy(context);
    return 0;
}
