#include "document/new_document.hpp"

#include "container/container_error.hpp"
#include "container/recoverable_password_container.hpp"
#include "format/revision_limits.hpp"
#include "format/snapshot_revision.hpp"
#include "format/snapshot_revision_data.hpp"

#include <array>

extern "C" {
int sodium_init(void);
void randombytes_buf(void *buffer, std::size_t size);
int crypto_generichash(
    unsigned char *output,
    std::size_t output_size,
    const unsigned char *input,
    unsigned long long input_size,
    const unsigned char *key,
    std::size_t key_size
);
}

namespace scpefe::document {
namespace {

format::SnapshotRevision make_revision(
    std::string_view profile_name,
    std::string_view profile_email,
    std::string_view device_name,
    std::string_view content,
    std::uint64_t timestamp_ms,
    const std::array<std::uint8_t, format::slot_id_size> &owner_slot_id,
    const std::array<std::uint8_t, format::content_hash_size> &content_hash
)
{
    format::SnapshotRevisionData data;
    data.timestamp_ms = timestamp_ms;
    data.slot_id.assign(owner_slot_id.begin(), owner_slot_id.end());
    data.slot_identity_name.assign(profile_name);
    data.slot_identity_email.assign(profile_email);
    data.client_profile_name.assign(profile_name);
    data.client_profile_email.assign(profile_email);
    data.device_name.assign(device_name);
    data.content_hash.assign(content_hash.begin(), content_hash.end());
    data.content.assign(content);
    return format::SnapshotRevision::create(
        std::move(data), format::RevisionLimits::defaults());
}

void require_sodium()
{
    static const int result = sodium_init();
    if (result < 0)
        throw container::ContainerFailure{container::ContainerError::crypto_error};
}

} // namespace

std::size_t NewDocument::encoded_size(
    std::string_view profile_name,
    std::string_view profile_email,
    std::string_view device_name,
    std::string_view content,
    std::uint64_t timestamp_ms,
    bool has_recovery
)
{
    const std::array<std::uint8_t, format::slot_id_size> slot{};
    const std::array<std::uint8_t, format::content_hash_size> hash{};
    return container::RecoverablePasswordContainer::encoded_size(
        make_revision(profile_name, profile_email, device_name, content, timestamp_ms,
            slot, hash).encode().size(), has_recovery);
}

std::vector<std::uint8_t> NewDocument::create(
    std::string_view profile_name,
    std::string_view profile_email,
    std::string_view device_name,
    std::string_view content,
    std::uint64_t timestamp_ms,
    const std::uint8_t *owner_password,
    std::size_t owner_password_size,
    const std::uint8_t *recovery_password,
    std::size_t recovery_password_size
)
{
    require_sodium();
    std::array<std::uint8_t, format::slot_id_size> owner_slot_id{};
    std::array<std::uint8_t, format::content_hash_size> content_hash{};
    randombytes_buf(owner_slot_id.data(), owner_slot_id.size());
    if (crypto_generichash(
        content_hash.data(), content_hash.size(),
        reinterpret_cast<const unsigned char *>(content.data()), content.size(),
        nullptr, 0
    ) != 0) {
        throw container::ContainerFailure{container::ContainerError::crypto_error};
    }

    const auto encoded = make_revision(profile_name, profile_email, device_name,
        content, timestamp_ms, owner_slot_id, content_hash).encode();
    return container::RecoverablePasswordContainer::create(
        owner_password, owner_password_size,
        recovery_password, recovery_password_size, owner_slot_id,
        encoded.data(), encoded.size()
    );
}

} // namespace scpefe::document
