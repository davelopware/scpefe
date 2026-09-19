#include "container/recoverable_password_container.hpp"

#include "container/container_error.hpp"
#include "format/revision_error.hpp"
#include "format/snapshot_revision.hpp"

#include <algorithm>
#include <array>
#include <cstring>
#include <limits>

extern "C" {
int sodium_init(void);
void randombytes_buf(void *buffer, std::size_t size);
void sodium_memzero(void *buffer, std::size_t size);
int crypto_pwhash(unsigned char *, unsigned long long, const char *,
    unsigned long long, const unsigned char *, unsigned long long, std::size_t, int);
int crypto_kdf_derive_from_key(unsigned char *, std::size_t, std::uint64_t,
    const char[8], const unsigned char *);
int crypto_aead_xchacha20poly1305_ietf_encrypt(unsigned char *,
    unsigned long long *, const unsigned char *, unsigned long long,
    const unsigned char *, unsigned long long, const unsigned char *,
    const unsigned char *, const unsigned char *);
int crypto_aead_xchacha20poly1305_ietf_decrypt(unsigned char *,
    unsigned long long *, unsigned char *, const unsigned char *,
    unsigned long long, const unsigned char *, unsigned long long,
    const unsigned char *, const unsigned char *);
}

namespace scpefe::container {
namespace {

constexpr std::array<std::uint8_t, 8> legacy_magic{'S','C','P','E','F','E',0,2};
constexpr std::array<std::uint8_t, 8> magic{'S','C','P','E','F','E',0,3};
constexpr std::size_t header_size = 160;
constexpr std::size_t document_id_size = 16;
constexpr std::size_t key_size = 32;
constexpr std::size_t slot_id_size = 16;
constexpr std::size_t slot_plaintext_size = 49;
constexpr std::size_t wrapped_slot_size = 65;
constexpr std::size_t tag_size = 16;
constexpr std::size_t salt_size = 16;
constexpr std::size_t nonce_size = 24;
constexpr std::uint32_t legacy_format_version = 2;
constexpr std::uint32_t format_version = 3;
constexpr std::uint32_t argon2id13_algorithm = 2;
constexpr std::uint64_t operations_limit = 2;
constexpr std::uint64_t memory_limit = 64u * 1024u * 1024u;
constexpr std::uint32_t aead_algorithm = 1;
constexpr std::uint8_t full_permissions = 7;
constexpr std::array<char, 8> snapshot_context{'S','C','P','S','N','A','P','1'};

constexpr std::size_t slot_count_offset = 32;
constexpr std::size_t snapshot_nonce_offset = 40;
constexpr std::size_t encrypted_snapshot_size_offset = 64;
constexpr std::size_t owner_salt_offset = 72;
constexpr std::size_t owner_nonce_offset = 88;
constexpr std::size_t recovery_salt_offset = 116;
constexpr std::size_t recovery_nonce_offset = 132;

void write_u32(std::uint8_t *out, std::uint32_t value)
{
    for (std::size_t i = 0; i < 4; ++i) out[i] = value >> (8 * i);
}

void write_u64(std::uint8_t *out, std::uint64_t value)
{
    for (std::size_t i = 0; i < 8; ++i) out[i] = value >> (8 * i);
}

std::uint32_t read_u32(const std::uint8_t *in)
{
    std::uint32_t result = 0;
    for (std::size_t i = 0; i < 4; ++i) result |= std::uint32_t(in[i]) << (8 * i);
    return result;
}

std::uint64_t read_u64(const std::uint8_t *in)
{
    std::uint64_t result = 0;
    for (std::size_t i = 0; i < 8; ++i) result |= std::uint64_t(in[i]) << (8 * i);
    return result;
}

void require_sodium()
{
    static const int result = sodium_init();
    if (result < 0) throw ContainerFailure{ContainerError::crypto_error};
}

void derive_wrapping_key(std::array<std::uint8_t, key_size> &key,
    const std::uint8_t *password, std::size_t password_size,
    const std::uint8_t *salt)
{
    if (password_size > std::numeric_limits<unsigned long long>::max()
        || crypto_pwhash(key.data(), key.size(),
            reinterpret_cast<const char *>(password), password_size, salt,
            operations_limit, memory_limit, argon2id13_algorithm) != 0) {
        throw ContainerFailure{ContainerError::out_of_memory};
    }
}

void derive_snapshot_key(std::array<std::uint8_t, key_size> &key,
    const std::uint8_t *document_key)
{
    if (crypto_kdf_derive_from_key(key.data(), key.size(), 1,
        snapshot_context.data(), document_key) != 0) {
        throw ContainerFailure{ContainerError::crypto_error};
    }
}

void validate_snapshot(const std::uint8_t *bytes, std::size_t size,
    const format::RevisionLimits &limits, ContainerError invalid)
{
    try {
        format::SnapshotRevision::decode(bytes, size, limits);
    } catch (const format::RevisionFailure &failure) {
        if (invalid == ContainerError::malformed_container) {
            if (failure.error == format::RevisionError::unsupported_format)
                throw ContainerFailure{ContainerError::unsupported_format};
            if (failure.error == format::RevisionError::limit_exceeded)
                throw ContainerFailure{ContainerError::limit_exceeded};
        }
        throw ContainerFailure{invalid};
    }
}

void clear(std::array<std::uint8_t, key_size> &a,
    std::array<std::uint8_t, key_size> &b,
    std::array<std::uint8_t, slot_plaintext_size> &slot,
    std::vector<std::uint8_t> &snapshot)
{
    sodium_memzero(a.data(), a.size());
    sodium_memzero(b.data(), b.size());
    sodium_memzero(slot.data(), slot.size());
    if (!snapshot.empty()) sodium_memzero(snapshot.data(), snapshot.size());
}

std::array<std::uint8_t, header_size> slot_additional_data(
    const std::uint8_t *header
)
{
    std::array<std::uint8_t, header_size> result{};
    std::copy_n(header, result.size(), result.begin());
    std::fill(result.begin() + snapshot_nonce_offset,
        result.begin() + owner_salt_offset, 0);
    return result;
}

} // namespace

bool RecoverablePasswordContainer::recognizes(
    const std::uint8_t *container, std::size_t size)
{
    return size >= magic.size() && container != nullptr
        && (std::equal(magic.begin(), magic.end(), container)
            || std::equal(legacy_magic.begin(), legacy_magic.end(), container));
}

std::size_t RecoverablePasswordContainer::encoded_size(
    std::size_t snapshot_size, bool has_recovery)
{
    const std::size_t fixed = header_size
        + (has_recovery ? 2 : 1) * wrapped_slot_size
        + document_id_size + tag_size;
    if (snapshot_size > std::numeric_limits<std::size_t>::max() - fixed)
        throw ContainerFailure{ContainerError::invalid_argument};
    return fixed + snapshot_size;
}

std::vector<std::uint8_t> RecoverablePasswordContainer::create(
    const std::uint8_t *owner_password, std::size_t owner_password_size,
    const std::uint8_t *recovery_password, std::size_t recovery_password_size,
    const std::array<std::uint8_t, 16> &owner_slot_id,
    const std::uint8_t *encoded_snapshot_revision,
    std::size_t encoded_snapshot_revision_size)
{
    const bool has_recovery = recovery_password != nullptr;
    validate_snapshot(encoded_snapshot_revision, encoded_snapshot_revision_size,
        format::RevisionLimits::defaults(), ContainerError::invalid_argument);
    require_sodium();
    std::array<std::uint8_t, key_size> document_key{}, working_key{};
    std::array<std::uint8_t, slot_plaintext_size> slot{};
    std::vector<std::uint8_t> snapshot;
    try {
        const std::uint32_t slot_count = has_recovery ? 2 : 1;
        std::vector<std::uint8_t> output(encoded_size(
            encoded_snapshot_revision_size, has_recovery));
        std::copy(magic.begin(), magic.end(), output.begin());
        write_u32(output.data() + 8, format_version);
        write_u32(output.data() + 12, argon2id13_algorithm);
        write_u64(output.data() + 16, operations_limit);
        write_u64(output.data() + 24, memory_limit);
        write_u32(output.data() + slot_count_offset, slot_count);
        write_u32(output.data() + 36, aead_algorithm);
        randombytes_buf(output.data() + snapshot_nonce_offset, nonce_size);
        write_u64(output.data() + encrypted_snapshot_size_offset,
            document_id_size + encoded_snapshot_revision_size + tag_size);
        randombytes_buf(output.data() + owner_salt_offset, salt_size);
        randombytes_buf(output.data() + owner_nonce_offset, nonce_size);
        write_u32(output.data() + 112, wrapped_slot_size);
        if (has_recovery) {
            randombytes_buf(output.data() + recovery_salt_offset, salt_size);
            randombytes_buf(output.data() + recovery_nonce_offset, nonce_size);
            write_u32(output.data() + 156, wrapped_slot_size);
        }

        randombytes_buf(document_key.data(), document_key.size());
        std::copy(document_key.begin(), document_key.end(), slot.begin());
        std::copy(owner_slot_id.begin(), owner_slot_id.end(), slot.begin() + key_size);
        slot.back() = full_permissions;
        const auto slot_aad = slot_additional_data(output.data());
        derive_wrapping_key(working_key, owner_password, owner_password_size,
            output.data() + owner_salt_offset);
        unsigned long long written = 0;
        if (crypto_aead_xchacha20poly1305_ietf_encrypt(
            output.data() + header_size, &written, slot.data(), slot.size(),
            slot_aad.data(), slot_aad.size(), nullptr,
            output.data() + owner_nonce_offset, working_key.data()) != 0
            || written != wrapped_slot_size) {
            throw ContainerFailure{ContainerError::crypto_error};
        }
        if (has_recovery) {
            randombytes_buf(slot.data() + key_size, slot_id_size);
            derive_wrapping_key(working_key, recovery_password, recovery_password_size,
                output.data() + recovery_salt_offset);
            if (crypto_aead_xchacha20poly1305_ietf_encrypt(
                output.data() + header_size + wrapped_slot_size, &written,
                slot.data(), slot.size(), slot_aad.data(), slot_aad.size(), nullptr,
                output.data() + recovery_nonce_offset, working_key.data()) != 0
                || written != wrapped_slot_size) {
                throw ContainerFailure{ContainerError::crypto_error};
            }
        }
        snapshot.resize(document_id_size + encoded_snapshot_revision_size);
        randombytes_buf(snapshot.data(), document_id_size);
        std::copy(encoded_snapshot_revision,
            encoded_snapshot_revision + encoded_snapshot_revision_size,
            snapshot.begin() + document_id_size);
        derive_snapshot_key(working_key, document_key.data());
        const std::size_t snapshot_offset = header_size + slot_count * wrapped_slot_size;
        if (crypto_aead_xchacha20poly1305_ietf_encrypt(
            output.data() + snapshot_offset, &written, snapshot.data(), snapshot.size(),
            output.data(), header_size, nullptr,
            output.data() + snapshot_nonce_offset, working_key.data()) != 0
            || written != snapshot.size() + tag_size) {
            throw ContainerFailure{ContainerError::crypto_error};
        }
        clear(document_key, working_key, slot, snapshot);
        return output;
    } catch (...) {
        clear(document_key, working_key, slot, snapshot);
        throw;
    }
}

UnlockedContainerData RecoverablePasswordContainer::unlock(
    const std::uint8_t *container, std::size_t container_size,
    const std::uint8_t *password, std::size_t password_size,
    const format::RevisionLimits &limits)
{
    if (!recognizes(container, container_size) || container_size < header_size)
        throw ContainerFailure{ContainerError::malformed_container};
    const std::uint32_t version = read_u32(container + 8);
    const bool has_legacy_magic = std::equal(
        legacy_magic.begin(), legacy_magic.end(), container);
    const bool has_current_magic = std::equal(
        magic.begin(), magic.end(), container);
    if ((has_legacy_magic && version != legacy_format_version)
        || (has_current_magic && version != format_version)) {
        throw ContainerFailure{ContainerError::malformed_container};
    }
    if ((version != legacy_format_version && version != format_version)
        || read_u32(container + 12) != argon2id13_algorithm
        || read_u64(container + 16) != operations_limit
        || read_u64(container + 24) != memory_limit
        || read_u32(container + 36) != aead_algorithm)
        throw ContainerFailure{ContainerError::unsupported_format};
    const std::uint32_t slot_count = read_u32(container + slot_count_offset);
    if ((slot_count != 1 && slot_count != 2)
        || read_u32(container + 112) != wrapped_slot_size
        || (slot_count == 2 && read_u32(container + 156) != wrapped_slot_size))
        throw ContainerFailure{ContainerError::malformed_container};
    if (slot_count == 1
        && !std::all_of(container + recovery_salt_offset,
            container + header_size, [](std::uint8_t value) { return value == 0; }))
        throw ContainerFailure{ContainerError::malformed_container};
    const std::uint64_t encrypted_size = read_u64(
        container + encrypted_snapshot_size_offset);
    const std::size_t snapshot_offset = header_size + slot_count * wrapped_slot_size;
    if (encrypted_size < document_id_size + tag_size
        || encrypted_size > std::numeric_limits<std::size_t>::max()
        || snapshot_offset > container_size
        || encrypted_size != container_size - snapshot_offset)
        throw ContainerFailure{ContainerError::malformed_container};
    const std::size_t revision_size = encrypted_size - document_id_size - tag_size;
    if (revision_size > limits.max_input_bytes())
        throw ContainerFailure{ContainerError::limit_exceeded};
    require_sodium();

    std::array<std::uint8_t, key_size> wrapping_key{}, snapshot_key{};
    std::array<std::uint8_t, slot_plaintext_size> slot{};
    std::vector<std::uint8_t> snapshot;
    try {
        const auto slot_aad = slot_additional_data(container);
        bool authenticated = false;
        std::uint32_t authenticated_index = 0;
        unsigned long long plain_size = 0;
        for (std::uint32_t index = 0; index < slot_count; ++index) {
            const std::size_t salt = index == 0 ? owner_salt_offset : recovery_salt_offset;
            const std::size_t nonce = index == 0 ? owner_nonce_offset : recovery_nonce_offset;
            derive_wrapping_key(wrapping_key, password, password_size, container + salt);
            if (crypto_aead_xchacha20poly1305_ietf_decrypt(
                slot.data(), &plain_size, nullptr,
                container + header_size + index * wrapped_slot_size,
                wrapped_slot_size,
                version == format_version ? slot_aad.data() : container,
                header_size, container + nonce,
                wrapping_key.data()) == 0) {
                authenticated = true;
                authenticated_index = index;
                break;
            }
        }
        if (!authenticated)
            throw ContainerFailure{ContainerError::authentication_failed};
        if (plain_size != slot.size() || slot.back() != full_permissions)
            throw ContainerFailure{ContainerError::malformed_container};
        derive_snapshot_key(snapshot_key, slot.data());
        snapshot.resize(encrypted_size - tag_size);
        if (crypto_aead_xchacha20poly1305_ietf_decrypt(
            snapshot.data(), &plain_size, nullptr, container + snapshot_offset,
            encrypted_size, container, header_size,
            container + snapshot_nonce_offset, snapshot_key.data()) != 0)
            throw ContainerFailure{ContainerError::authentication_failed};
        if (plain_size != snapshot.size() || plain_size < document_id_size)
            throw ContainerFailure{ContainerError::malformed_container};
        validate_snapshot(snapshot.data() + document_id_size, revision_size,
            limits, ContainerError::malformed_container);
        UnlockedContainerData result;
        std::copy_n(snapshot.data(), document_id_size, result.document_id.begin());
        std::copy_n(slot.data() + key_size, result.slot_id.size(),
            result.slot_id.begin());
        result.permissions = slot.back();
        result.recovery_slot = authenticated_index != 0;
        result.encoded_snapshot_revision.assign(
            snapshot.begin() + document_id_size, snapshot.end());
        clear(wrapping_key, snapshot_key, slot, snapshot);
        return result;
    } catch (...) {
        clear(wrapping_key, snapshot_key, slot, snapshot);
        throw;
    }
}

std::vector<std::uint8_t> RecoverablePasswordContainer::replace_snapshot(
    const std::uint8_t *container,
    std::size_t container_size,
    const std::uint8_t *password,
    std::size_t password_size,
    const std::uint8_t *encoded_snapshot_revision,
    std::size_t encoded_snapshot_revision_size
)
{
    validate_snapshot(encoded_snapshot_revision, encoded_snapshot_revision_size,
        format::RevisionLimits::defaults(), ContainerError::invalid_argument);
    if (!recognizes(container, container_size) || container_size < header_size) {
        throw ContainerFailure{ContainerError::unsupported_format};
    }
    if (!std::equal(magic.begin(), magic.end(), container)
        || read_u32(container + 8) != format_version) {
        throw ContainerFailure{ContainerError::unsupported_format};
    }
    const std::uint32_t slot_count = read_u32(container + slot_count_offset);
    if (slot_count != 1 && slot_count != 2)
        throw ContainerFailure{ContainerError::malformed_container};

    require_sodium();
    std::array<std::uint8_t, key_size> wrapping_key{}, snapshot_key{};
    std::array<std::uint8_t, slot_plaintext_size> slot{};
    std::vector<std::uint8_t> plaintext;
    try {
        const auto old_aad = slot_additional_data(container);
        bool authenticated = false;
        unsigned long long written = 0;
        for (std::uint32_t index = 0; index < slot_count; ++index) {
            const std::size_t salt = index == 0 ? owner_salt_offset : recovery_salt_offset;
            const std::size_t nonce = index == 0 ? owner_nonce_offset : recovery_nonce_offset;
            derive_wrapping_key(wrapping_key, password, password_size, container + salt);
            if (crypto_aead_xchacha20poly1305_ietf_decrypt(
                slot.data(), &written, nullptr,
                container + header_size + index * wrapped_slot_size,
                wrapped_slot_size, old_aad.data(), old_aad.size(),
                container + nonce, wrapping_key.data()) == 0) {
                authenticated = true;
                break;
            }
        }
        if (!authenticated)
            throw ContainerFailure{ContainerError::authentication_failed};
        if (written != slot.size() || (slot.back() & 1u) == 0)
            throw ContainerFailure{ContainerError::invalid_argument};

        const std::size_t new_size = encoded_size(
            encoded_snapshot_revision_size, slot_count == 2);
        std::vector<std::uint8_t> output(new_size);
        std::copy_n(container, header_size + slot_count * wrapped_slot_size,
            output.begin());
        randombytes_buf(output.data() + snapshot_nonce_offset, nonce_size);
        write_u64(output.data() + encrypted_snapshot_size_offset,
            document_id_size + encoded_snapshot_revision_size + tag_size);

        const std::uint64_t old_encrypted_size = read_u64(
            container + encrypted_snapshot_size_offset);
        const std::size_t old_snapshot_offset =
            header_size + slot_count * wrapped_slot_size;
        if (old_encrypted_size < document_id_size + tag_size
            || old_snapshot_offset + old_encrypted_size != container_size) {
            throw ContainerFailure{ContainerError::malformed_container};
        }
        derive_snapshot_key(snapshot_key, slot.data());
        plaintext.resize(old_encrypted_size - tag_size);
        if (crypto_aead_xchacha20poly1305_ietf_decrypt(
            plaintext.data(), &written, nullptr, container + old_snapshot_offset,
            old_encrypted_size, container, header_size,
            container + snapshot_nonce_offset, snapshot_key.data()) != 0
            || written != plaintext.size()) {
            throw ContainerFailure{ContainerError::authentication_failed};
        }
        plaintext.resize(document_id_size + encoded_snapshot_revision_size);
        std::copy(encoded_snapshot_revision,
            encoded_snapshot_revision + encoded_snapshot_revision_size,
            plaintext.begin() + document_id_size);
        const std::size_t new_snapshot_offset =
            header_size + slot_count * wrapped_slot_size;
        if (crypto_aead_xchacha20poly1305_ietf_encrypt(
            output.data() + new_snapshot_offset, &written,
            plaintext.data(), plaintext.size(), output.data(), header_size, nullptr,
            output.data() + snapshot_nonce_offset, snapshot_key.data()) != 0
            || written != plaintext.size() + tag_size) {
            throw ContainerFailure{ContainerError::crypto_error};
        }
        clear(wrapping_key, snapshot_key, slot, plaintext);
        return output;
    } catch (...) {
        clear(wrapping_key, snapshot_key, slot, plaintext);
        throw;
    }
}

} // namespace scpefe::container
