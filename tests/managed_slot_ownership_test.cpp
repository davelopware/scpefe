#include "scpefe/scpefe.h"

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#define CHECK(condition) do { if (!(condition)) { \
    std::fprintf(stderr, "owned slot snapshot failed at %d: %s\n", \
        __LINE__, #condition); std::abort(); \
} } while (false)

static scpefe_status clock_read(void *opaque, std::uint64_t *value)
{
    *value = *static_cast<std::uint64_t *>(opaque);
    return SCPEFE_STATUS_OK;
}

int main()
{
    constexpr char owner[] = "c347416f-e467-4c0f-b56a-554ed7ba20b0";
    constexpr char temporary[] = "7291c2a9-9de9-441e-b0bf-f4736150aeec";
    std::uint64_t time = 42;
    scpefe_host_services_v1 host{sizeof(host), SCPEFE_ABI_VERSION,
        &time, clock_read};
    scpefe_container_create_v1 create{};
    create.struct_size = sizeof(create);
    create.abi_version = SCPEFE_ABI_VERSION;
    create.document.struct_size = sizeof(create.document);
    create.document.profile_name = "Ada";
    create.document.profile_name_size = 3;
    create.document.profile_email = "ada@example.test";
    create.document.profile_email_size = 16;
    create.document.device_name = "test";
    create.document.device_name_size = 4;
    create.document.content = "content\n";
    create.document.content_size = 8;
    create.document.timestamp_ms = 1;
    create.document.owner_password = reinterpret_cast<const std::uint8_t *>(owner);
    create.document.owner_password_size = sizeof(owner) - 1;
    scpefe_context *context = nullptr;
    scpefe_container *container = nullptr;
    scpefe_owned_slots *before = nullptr, *after = nullptr;
    CHECK(scpefe_context_create(&host, &context) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_create(context, &create, &container) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_slots(container, &before) == SCPEFE_STATUS_OK);
    std::size_t count = 0;
    CHECK(scpefe_owned_slots_count(before, &count) == SCPEFE_STATUS_OK && count == 1);
    scpefe_owned_slot_view_v1 owner_view{};
    owner_view.struct_size = sizeof(owner_view);
    CHECK(scpefe_owned_slots_view(before, 0, &owner_view) == SCPEFE_STATUS_OK);
    CHECK(owner_view.role == 0 && owner_view.can_edit
        && owner_view.can_add_passwords && owner_view.can_remove_passwords);
    const std::array<std::uint8_t, SCPEFE_SLOT_ID_SIZE> owner_id = [&] {
        std::array<std::uint8_t, SCPEFE_SLOT_ID_SIZE> id{};
        std::memcpy(id.data(), owner_view.slot_id, id.size());
        return id;
    }();

    scpefe_container_slot_change_v1 change{};
    change.struct_size = sizeof(change);
    change.abi_version = SCPEFE_ABI_VERSION;
    change.operation_id = 1;
    change.kind = SCPEFE_SLOT_ADD_INVITATION;
    change.actor_password = reinterpret_cast<const std::uint8_t *>(owner);
    change.actor_password_size = sizeof(owner) - 1;
    change.new_password = reinterpret_cast<const std::uint8_t *>(temporary);
    change.new_password_size = sizeof(temporary) - 1;
    change.name = "New colleague";
    change.name_size = std::strlen(change.name);
    change.client_name = "Ada";
    change.client_name_size = 3;
    change.client_email = "ada@example.test";
    change.client_email_size = 16;
    change.device = "test";
    change.device_size = 4;
    change.timestamp_ms = 2;
    scpefe_candidate_info_v1 candidate{sizeof(candidate), SCPEFE_ABI_VERSION};
    CHECK(scpefe_container_prepare_slot_change(container, &change, &candidate)
        == SCPEFE_STATUS_OK);
    std::uint32_t effects = 0;
    CHECK(scpefe_container_acknowledge_save(container, 1,
        SCPEFE_PUBLICATION_VERIFIED, &effects) == SCPEFE_STATUS_OK);
    CHECK(scpefe_container_slots(container, &after) == SCPEFE_STATUS_OK);
    CHECK(scpefe_owned_slots_count(after, &count) == SCPEFE_STATUS_OK && count == 2);
    CHECK(scpefe_owned_slots_count(before, &count) == SCPEFE_STATUS_OK && count == 1);
    scpefe_owned_slot_view_v1 invitation{};
    invitation.struct_size = sizeof(invitation);
    CHECK(scpefe_owned_slots_view(after, 1, &invitation) == SCPEFE_STATUS_OK);
    CHECK(invitation.role == 1 && invitation.must_change_password
        && invitation.name_size == std::strlen("New colleague")
        && std::memcmp(invitation.name, "New colleague", invitation.name_size) == 0);
    CHECK(std::memcmp(invitation.slot_id, owner_id.data(), owner_id.size()) != 0);
    CHECK(std::memcmp(invitation.management_id, owner_view.management_id,
        owner_id.size()) != 0);
    CHECK(scpefe_owned_slots_view(after, 2, &invitation)
        == SCPEFE_STATUS_INVALID_ARGUMENT);
    CHECK(scpefe_container_lock(container) == SCPEFE_STATUS_OK);
    scpefe_owned_slots *locked = nullptr;
    CHECK(scpefe_container_slots(container, &locked) == SCPEFE_STATUS_LOCKED);
    CHECK(locked == nullptr);
    CHECK(scpefe_container_close(container) == SCPEFE_STATUS_OK);
    scpefe_context_destroy(context);
    CHECK(scpefe_owned_slots_count(after, &count) == SCPEFE_STATUS_OK && count == 2);
    invitation.struct_size = sizeof(invitation);
    CHECK(scpefe_owned_slots_view(after, 1, &invitation) == SCPEFE_STATUS_OK);
    CHECK(std::memcmp(invitation.name, "New colleague", invitation.name_size) == 0);
    owner_view.struct_size = sizeof(owner_view);
    CHECK(scpefe_owned_slots_view(before, 0, &owner_view) == SCPEFE_STATUS_OK);
    CHECK(std::memcmp(owner_view.slot_id, owner_id.data(), owner_id.size()) == 0);
    scpefe_owned_slots_destroy(after);
    scpefe_owned_slots_destroy(before);
    return 0;
}
