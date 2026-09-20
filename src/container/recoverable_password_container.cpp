#include "container/recoverable_password_container.hpp"

#include "container/container_error.hpp"
#include "format/revision_error.hpp"
#include "format/snapshot_revision.hpp"
#include "security/password_strength.hpp"

#include <algorithm>
#include <array>
#include <cstring>
#include <limits>
#include <string_view>

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
constexpr std::array<char, 8> work_journal_context{'S','C','P','J','R','N','0','1'};
constexpr std::array<std::uint8_t, 8> lease_magic{'S','C','P','L','E','A','S','1'};
constexpr std::uint64_t default_lease_duration_ms = 600000;
constexpr std::size_t lease_fixed_size = 61;
constexpr std::size_t max_holder_field_size = 4096;
constexpr std::array<std::uint8_t, 8> invitation_magic{'S','C','P','I','N','V','0','1'};
constexpr std::size_t invitation_prefix_size = 44;
constexpr std::size_t max_ordinary_slots = 8;
constexpr std::uint8_t permission_mask = 7;
constexpr std::uint8_t must_change_flag = 1;

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

void append_u32(std::vector<std::uint8_t> &output, std::uint32_t value)
{
    const auto offset = output.size();
    output.resize(offset + 4);
    write_u32(output.data() + offset, value);
}

void append_u64(std::vector<std::uint8_t> &output, std::uint64_t value)
{
    const auto offset = output.size();
    output.resize(offset + 8);
    write_u64(output.data() + offset, value);
}

void append_text(std::vector<std::uint8_t> &output, std::string_view value)
{
    if (value.size() > max_holder_field_size)
        throw ContainerFailure{ContainerError::invalid_argument};
    append_u32(output, static_cast<std::uint32_t>(value.size()));
    output.insert(output.end(), value.begin(), value.end());
}

std::vector<std::uint8_t> encode_lease(const EditingLeaseData &lease)
{
    if (lease.duration_ms == 0)
        throw ContainerFailure{ContainerError::invalid_argument};
    std::vector<std::uint8_t> result;
    result.insert(result.end(), lease_magic.begin(), lease_magic.end());
    result.push_back(lease.active ? 1 : 0);
    result.insert(result.end(), lease.session_id.begin(), lease.session_id.end());
    append_u64(result, lease.heartbeat_counter);
    append_u64(result, lease.holder_utc_ms);
    append_u64(result, lease.duration_ms);
    append_text(result, lease.holder_name);
    append_text(result, lease.holder_email);
    append_text(result, lease.device_name);
    return result;
}

std::size_t decode_lease(const std::uint8_t *input, std::size_t size,
    EditingLeaseData &lease)
{
    lease.duration_ms = default_lease_duration_ms;
    if (size < lease_magic.size()
        || !std::equal(lease_magic.begin(), lease_magic.end(), input)) return 0;
    if (size < lease_fixed_size || input[8] > 1)
        throw ContainerFailure{ContainerError::malformed_container};
    lease.active = input[8] != 0;
    std::copy_n(input + 9, lease.session_id.size(), lease.session_id.begin());
    lease.heartbeat_counter = read_u64(input + 25);
    lease.holder_utc_ms = read_u64(input + 33);
    lease.duration_ms = read_u64(input + 41);
    if (lease.duration_ms == 0)
        throw ContainerFailure{ContainerError::malformed_container};
    std::size_t offset = 49;
    auto read_text = [&](std::string &output) {
        if (offset + 4 > size)
            throw ContainerFailure{ContainerError::malformed_container};
        const auto length = read_u32(input + offset);
        offset += 4;
        if (length > max_holder_field_size || length > size - offset)
            throw ContainerFailure{ContainerError::malformed_container};
        output.assign(reinterpret_cast<const char *>(input + offset), length);
        offset += length;
    };
    read_text(lease.holder_name);
    read_text(lease.holder_email);
    read_text(lease.device_name);
    return offset;
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

void derive_work_journal_key(std::array<std::uint8_t, key_size> &key,
    const std::uint8_t *document_key)
{
    if (crypto_kdf_derive_from_key(key.data(), key.size(), 2,
        work_journal_context.data(), document_key) != 0) {
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

struct InvitationRecord {
    std::size_t offset{};
    const std::uint8_t *salt{};
    const std::uint8_t *nonce{};
    const std::uint8_t *ciphertext{};
    std::size_t ciphertext_size{};
};

struct ContainerLayout {
    std::uint32_t base_slot_count{};
    std::vector<InvitationRecord> invitations;
    std::size_t snapshot_offset{};
};

ContainerLayout read_layout(const std::uint8_t *container, std::size_t size)
{
    ContainerLayout result;
    result.base_slot_count = read_u32(container + slot_count_offset);
    if (result.base_slot_count != 1 && result.base_slot_count != 2)
        throw ContainerFailure{ContainerError::malformed_container};
    std::size_t offset = header_size + result.base_slot_count * wrapped_slot_size;
    if (offset > size) throw ContainerFailure{ContainerError::malformed_container};
    if (size - offset >= 12
        && std::equal(invitation_magic.begin(), invitation_magic.end(), container + offset)) {
        const auto count = read_u32(container + offset + 8);
        if (count > max_ordinary_slots - 1)
            throw ContainerFailure{ContainerError::malformed_container};
        offset += 12;
        result.invitations.reserve(count);
        for (std::uint32_t index = 0; index < count; ++index) {
            if (size - offset < invitation_prefix_size)
                throw ContainerFailure{ContainerError::malformed_container};
            const auto cipher_size = read_u32(container + offset + 40);
            if (cipher_size < 66 || cipher_size > size - offset - invitation_prefix_size)
                throw ContainerFailure{ContainerError::malformed_container};
            result.invitations.push_back({offset, container + offset,
                container + offset + salt_size, container + offset + invitation_prefix_size,
                cipher_size});
            offset += invitation_prefix_size + cipher_size;
        }
    }
    result.snapshot_offset = offset;
    const auto encrypted_size = read_u64(container + encrypted_snapshot_size_offset);
    if (encrypted_size < document_id_size + tag_size
        || encrypted_size > size || offset > size
        || encrypted_size != size - offset)
        throw ContainerFailure{ContainerError::malformed_container};
    return result;
}

void append_u32_text(std::vector<std::uint8_t> &output, std::string_view value)
{
    if (value.size() > max_holder_field_size)
        throw ContainerFailure{ContainerError::invalid_argument};
    append_u32(output, static_cast<std::uint32_t>(value.size()));
    output.insert(output.end(), value.begin(), value.end());
}

std::vector<std::uint8_t> invitation_plaintext(
    const std::uint8_t *document_key, const std::array<std::uint8_t, 16> &slot_id,
    std::uint8_t permissions, std::uint8_t flags,
    std::string_view name, std::string_view email)
{
    std::vector<std::uint8_t> result;
    result.insert(result.end(), document_key, document_key + key_size);
    result.insert(result.end(), slot_id.begin(), slot_id.end());
    result.push_back(permissions);
    result.push_back(flags);
    append_u32_text(result, name);
    append_u32_text(result, email);
    return result;
}

void decode_invitation_plaintext(const std::vector<std::uint8_t> &plain,
    UnlockedContainerData &result)
{
    if (plain.size() < 58 || (plain[48] & ~permission_mask) != 0
        || (plain[49] & ~must_change_flag) != 0)
        throw ContainerFailure{ContainerError::malformed_container};
    std::size_t offset = 50;
    auto text = [&](std::string &value) {
        if (plain.size() - offset < 4)
            throw ContainerFailure{ContainerError::malformed_container};
        const auto length = read_u32(plain.data() + offset);
        offset += 4;
        if (length > max_holder_field_size || length > plain.size() - offset)
            throw ContainerFailure{ContainerError::malformed_container};
        value.assign(reinterpret_cast<const char *>(plain.data() + offset), length);
        offset += length;
    };
    std::copy_n(plain.data() + key_size, result.slot_id.size(), result.slot_id.begin());
    result.permissions = plain[48];
    result.must_be_changed = (plain[49] & must_change_flag) != 0;
    text(result.slot_identity_name);
    text(result.slot_identity_email);
    if (offset != plain.size()) throw ContainerFailure{ContainerError::malformed_container};
}

bool decrypt_invitation(const InvitationRecord &record,
    const std::uint8_t *password, std::size_t password_size,
    std::array<std::uint8_t, key_size> &wrapping_key,
    std::vector<std::uint8_t> &plain)
{
    derive_wrapping_key(wrapping_key, password, password_size, record.salt);
    plain.resize(record.ciphertext_size - tag_size);
    unsigned long long written = 0;
    if (crypto_aead_xchacha20poly1305_ietf_decrypt(plain.data(), &written, nullptr,
        record.ciphertext, record.ciphertext_size, nullptr, 0, record.nonce,
        wrapping_key.data()) != 0) {
        if (!plain.empty()) sodium_memzero(plain.data(), plain.size());
        plain.clear();
        return false;
    }
    if (written != plain.size()) throw ContainerFailure{ContainerError::malformed_container};
    return true;
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
    const EditingLeaseData empty_lease{};
    const auto lease_size = encode_lease(empty_lease).size();
    if (snapshot_size > std::numeric_limits<std::size_t>::max() - fixed - lease_size)
        throw ContainerFailure{ContainerError::invalid_argument};
    return fixed + lease_size + snapshot_size;
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
        const auto lease = encode_lease(EditingLeaseData{});
        write_u64(output.data() + encrypted_snapshot_size_offset,
            document_id_size + lease.size() + encoded_snapshot_revision_size + tag_size);
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
        snapshot.resize(document_id_size + lease.size() + encoded_snapshot_revision_size);
        randombytes_buf(snapshot.data(), document_id_size);
        std::copy(lease.begin(), lease.end(), snapshot.begin() + document_id_size);
        std::copy(encoded_snapshot_revision,
            encoded_snapshot_revision + encoded_snapshot_revision_size,
            snapshot.begin() + document_id_size + lease.size());
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
    const auto layout = read_layout(container, container_size);
    const std::uint64_t encrypted_size = read_u64(container + encrypted_snapshot_size_offset);
    const std::size_t snapshot_offset = layout.snapshot_offset;

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
        UnlockedContainerData result;
        std::vector<std::uint8_t> invitation;
        if (!authenticated) {
            for (const auto &record : layout.invitations) {
                if (decrypt_invitation(record, password, password_size,
                    wrapping_key, invitation)) {
                    authenticated = true;
                    decode_invitation_plaintext(invitation, result);
                    std::copy_n(invitation.data(), key_size, slot.begin());
                    break;
                }
            }
        }
        if (!authenticated) throw ContainerFailure{ContainerError::authentication_failed};
        if (invitation.empty()
            && (plain_size != slot.size() || slot.back() != full_permissions))
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
        const auto lease_size = decode_lease(snapshot.data() + document_id_size,
            snapshot.size() - document_id_size, result.editing_lease);
        const std::size_t revision_size = snapshot.size() - document_id_size - lease_size;
        if (revision_size > limits.max_input_bytes())
            throw ContainerFailure{ContainerError::limit_exceeded};
        validate_snapshot(snapshot.data() + document_id_size + lease_size, revision_size,
            limits, ContainerError::malformed_container);
        std::copy_n(snapshot.data(), document_id_size, result.document_id.begin());
        derive_work_journal_key(result.work_journal_key, slot.data());
        if (invitation.empty()) {
            std::copy_n(slot.data() + key_size, result.slot_id.size(), result.slot_id.begin());
            result.permissions = slot.back();
            result.recovery_slot = authenticated_index != 0;
        }
        result.encoded_snapshot_revision.assign(
            snapshot.begin() + document_id_size + lease_size, snapshot.end());
        clear(wrapping_key, snapshot_key, slot, snapshot);
        if (!invitation.empty()) sodium_memzero(invitation.data(), invitation.size());
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
    const auto layout = read_layout(container, container_size);
    const std::uint32_t slot_count = layout.base_slot_count;
    const auto current = unlock(container, container_size, password, password_size,
        format::RevisionLimits::defaults());
    if (current.must_be_changed || (current.permissions & 1u) == 0)
        throw ContainerFailure{ContainerError::invalid_argument};

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
        std::vector<std::uint8_t> invited;
        if (!authenticated) {
            for (const auto &record : layout.invitations) {
                if (decrypt_invitation(record, password, password_size,
                    wrapping_key, invited)) {
                    std::copy_n(invited.data(), key_size, slot.begin());
                    authenticated = true;
                    break;
                }
            }
        }
        if (!authenticated) throw ContainerFailure{ContainerError::authentication_failed};
        const auto encoded_lease = encode_lease(current.editing_lease);
        const std::size_t new_size = layout.snapshot_offset
            + document_id_size + encoded_lease.size()
            + encoded_snapshot_revision_size + tag_size;
        std::vector<std::uint8_t> output(new_size);
        std::copy_n(container, layout.snapshot_offset, output.begin());
        randombytes_buf(output.data() + snapshot_nonce_offset, nonce_size);
        write_u64(output.data() + encrypted_snapshot_size_offset,
            document_id_size + encoded_lease.size()
                + encoded_snapshot_revision_size + tag_size);

        const std::uint64_t old_encrypted_size = read_u64(
            container + encrypted_snapshot_size_offset);
        const std::size_t old_snapshot_offset = layout.snapshot_offset;
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
        plaintext.resize(document_id_size + encoded_lease.size()
            + encoded_snapshot_revision_size);
        std::copy(encoded_lease.begin(), encoded_lease.end(),
            plaintext.begin() + document_id_size);
        std::copy(encoded_snapshot_revision,
            encoded_snapshot_revision + encoded_snapshot_revision_size,
            plaintext.begin() + document_id_size + encoded_lease.size());
        const std::size_t new_snapshot_offset = layout.snapshot_offset;
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

std::vector<std::uint8_t> RecoverablePasswordContainer::change_password(
    const std::uint8_t *container,
    std::size_t container_size,
    const std::uint8_t *current_password,
    std::size_t current_password_size,
    const std::uint8_t *new_password,
    std::size_t new_password_size
)
{
    if (!security::password_is_strong(new_password, new_password_size))
        throw ContainerFailure{ContainerError::weak_password};
    if (!recognizes(container, container_size) || container_size < header_size)
        throw ContainerFailure{ContainerError::malformed_container};
    const std::uint32_t version = read_u32(container + 8);
    const bool current = std::equal(magic.begin(), magic.end(), container);
    if (!current || version != format_version)
        throw ContainerFailure{ContainerError::unsupported_format};
    if (read_u32(container + 12) != argon2id13_algorithm
        || read_u64(container + 16) != operations_limit
        || read_u64(container + 24) != memory_limit
        || read_u32(container + 36) != aead_algorithm) {
        throw ContainerFailure{ContainerError::unsupported_format};
    }
    const std::uint32_t slot_count = read_u32(container + slot_count_offset);
    if ((slot_count != 1 && slot_count != 2)
        || read_u32(container + 112) != wrapped_slot_size
        || (slot_count == 2 && read_u32(container + 156) != wrapped_slot_size)
        || (slot_count == 1
            && !std::all_of(container + recovery_salt_offset,
                container + header_size,
                [](std::uint8_t value) { return value == 0; }))) {
        throw ContainerFailure{ContainerError::malformed_container};
    }
    const auto layout = read_layout(container, container_size);
    const std::uint64_t encrypted_size = read_u64(container + encrypted_snapshot_size_offset);
    const std::size_t snapshot_offset = layout.snapshot_offset;

    try {
        (void)unlock(container, container_size, new_password, new_password_size,
            format::RevisionLimits::defaults());
        throw ContainerFailure{ContainerError::password_already_in_use};
    } catch (const ContainerFailure &failure) {
        if (failure.error != ContainerError::authentication_failed) throw;
    }

    require_sodium();
    std::array<std::uint8_t, key_size> wrapping_key{}, snapshot_key{};
    std::array<std::uint8_t, slot_plaintext_size> slot{}, candidate_slot{};
    std::vector<std::uint8_t> snapshot;
    try {
        const auto normalized_aad = slot_additional_data(container);
        const std::uint8_t *slot_aad = normalized_aad.data();
        bool authenticated = false;
        std::uint32_t authenticated_index = 0;
        unsigned long long plain_size = 0;
        for (std::uint32_t index = 0; index < slot_count; ++index) {
            const std::size_t salt = index == 0 ? owner_salt_offset : recovery_salt_offset;
            const std::size_t nonce = index == 0 ? owner_nonce_offset : recovery_nonce_offset;
            derive_wrapping_key(wrapping_key, current_password,
                current_password_size, container + salt);
            if (crypto_aead_xchacha20poly1305_ietf_decrypt(
                slot.data(), &plain_size, nullptr,
                container + header_size + index * wrapped_slot_size,
                wrapped_slot_size, slot_aad, header_size,
                container + nonce, wrapping_key.data()) == 0) {
                authenticated = true;
                authenticated_index = index;
                break;
            }
        }
        if (!authenticated) {
            std::vector<std::uint8_t> invited;
            for (const auto &record : layout.invitations) {
                if (!decrypt_invitation(record, current_password, current_password_size,
                    wrapping_key, invited)) continue;
                UnlockedContainerData access;
                decode_invitation_plaintext(invited, access);
                if (access.must_be_changed)
                    throw ContainerFailure{ContainerError::invalid_argument};
                derive_wrapping_key(wrapping_key, new_password, new_password_size,
                    record.salt);
                std::vector<std::uint8_t> cipher(invited.size() + tag_size);
                unsigned long long invited_written = 0;
                if (crypto_aead_xchacha20poly1305_ietf_encrypt(cipher.data(),
                    &invited_written, invited.data(), invited.size(), nullptr, 0,
                    nullptr, record.nonce, wrapping_key.data()) != 0
                    || invited_written != cipher.size())
                    throw ContainerFailure{ContainerError::crypto_error};
                std::vector<std::uint8_t> output;
                output.insert(output.end(), container, container + record.offset + 40);
                append_u32(output, static_cast<std::uint32_t>(cipher.size()));
                output.insert(output.end(), cipher.begin(), cipher.end());
                const auto old_end = record.offset + invitation_prefix_size
                    + record.ciphertext_size;
                output.insert(output.end(), container + old_end,
                    container + container_size);
                sodium_memzero(invited.data(), invited.size());
                sodium_memzero(wrapping_key.data(), wrapping_key.size());
                return output;
            }
        }
        for (const auto &record : layout.invitations) {
            std::vector<std::uint8_t> invited;
            if (decrypt_invitation(record, new_password, new_password_size,
                wrapping_key, invited)) {
                if (!invited.empty()) sodium_memzero(invited.data(), invited.size());
                throw ContainerFailure{ContainerError::password_already_in_use};
            }
        }
        if (!authenticated)
            throw ContainerFailure{ContainerError::authentication_failed};
        if (plain_size != slot.size() || slot.back() != full_permissions)
            throw ContainerFailure{ContainerError::malformed_container};

        derive_snapshot_key(snapshot_key, slot.data());
        snapshot.resize(static_cast<std::size_t>(encrypted_size) - tag_size);
        if (crypto_aead_xchacha20poly1305_ietf_decrypt(
            snapshot.data(), &plain_size, nullptr, container + snapshot_offset,
            encrypted_size, container, header_size,
            container + snapshot_nonce_offset, snapshot_key.data()) != 0) {
            throw ContainerFailure{ContainerError::authentication_failed};
        }
        if (plain_size != snapshot.size() || plain_size < document_id_size)
            throw ContainerFailure{ContainerError::malformed_container};
        EditingLeaseData lease;
        const auto lease_size = decode_lease(snapshot.data() + document_id_size,
            snapshot.size() - document_id_size, lease);
        validate_snapshot(snapshot.data() + document_id_size + lease_size,
            snapshot.size() - document_id_size - lease_size,
            format::RevisionLimits::defaults(),
            ContainerError::malformed_container);

        for (std::uint32_t index = 0; index < slot_count; ++index) {
            if (index == authenticated_index) continue;
            const std::size_t salt = index == 0 ? owner_salt_offset : recovery_salt_offset;
            const std::size_t nonce = index == 0 ? owner_nonce_offset : recovery_nonce_offset;
            derive_wrapping_key(wrapping_key, new_password, new_password_size,
                container + salt);
            if (crypto_aead_xchacha20poly1305_ietf_decrypt(
                candidate_slot.data(), &plain_size, nullptr,
                container + header_size + index * wrapped_slot_size,
                wrapped_slot_size, slot_aad, header_size,
                container + nonce, wrapping_key.data()) == 0) {
                throw ContainerFailure{ContainerError::password_already_in_use};
            }
            sodium_memzero(candidate_slot.data(), candidate_slot.size());
        }

        std::vector<std::uint8_t> output(container, container + container_size);
        const std::size_t salt = authenticated_index == 0
            ? owner_salt_offset : recovery_salt_offset;
        const std::size_t nonce = authenticated_index == 0
            ? owner_nonce_offset : recovery_nonce_offset;
        derive_wrapping_key(wrapping_key, new_password, new_password_size,
            container + salt);
        unsigned long long written = 0;
        if (crypto_aead_xchacha20poly1305_ietf_encrypt(
            output.data() + header_size + authenticated_index * wrapped_slot_size,
            &written, slot.data(), slot.size(), slot_aad, header_size, nullptr,
            container + nonce, wrapping_key.data()) != 0
            || written != wrapped_slot_size) {
            throw ContainerFailure{ContainerError::crypto_error};
        }
        clear(wrapping_key, snapshot_key, slot, snapshot);
        sodium_memzero(candidate_slot.data(), candidate_slot.size());
        return output;
    } catch (...) {
        clear(wrapping_key, snapshot_key, slot, snapshot);
        sodium_memzero(candidate_slot.data(), candidate_slot.size());
        throw;
    }
}

std::vector<std::uint8_t> RecoverablePasswordContainer::add_invitation(
    const std::uint8_t *container, std::size_t container_size,
    const std::uint8_t *creator_password, std::size_t creator_password_size,
    const std::uint8_t *temporary_password, std::size_t temporary_password_size,
    std::uint8_t permissions, const std::string &temporary_label)
{
    if (!security::password_is_strong(temporary_password, temporary_password_size))
        throw ContainerFailure{ContainerError::weak_password};
    if ((permissions & ~permission_mask) != 0
        || ((permissions & 6u) != 0 && (permissions & 1u) == 0)
        || temporary_label.empty() || temporary_label.size() > max_holder_field_size)
        throw ContainerFailure{ContainerError::invalid_argument};
    const auto creator = unlock(container, container_size, creator_password,
        creator_password_size, format::RevisionLimits::defaults());
    if ((creator.permissions & 2u) == 0 || (permissions & ~creator.permissions) != 0)
        throw ContainerFailure{ContainerError::invalid_argument};
    try {
        (void)unlock(container, container_size, temporary_password,
            temporary_password_size, format::RevisionLimits::defaults());
        throw ContainerFailure{ContainerError::password_already_in_use};
    } catch (const ContainerFailure &failure) {
        if (failure.error != ContainerError::authentication_failed) throw;
    }
    const auto layout = read_layout(container, container_size);
    if (layout.invitations.size() >= max_ordinary_slots - 1)
        throw ContainerFailure{ContainerError::limit_exceeded};

    require_sodium();
    std::array<std::uint8_t, key_size> wrapping_key{};
    std::array<std::uint8_t, slot_plaintext_size> base_slot{};
    std::vector<std::uint8_t> creator_plain;
    const auto aad = slot_additional_data(container);
    bool found = false;
    unsigned long long written = 0;
    for (std::uint32_t index = 0; index < layout.base_slot_count && !found; ++index) {
        const auto salt = index == 0 ? owner_salt_offset : recovery_salt_offset;
        const auto nonce = index == 0 ? owner_nonce_offset : recovery_nonce_offset;
        derive_wrapping_key(wrapping_key, creator_password, creator_password_size,
            container + salt);
        found = crypto_aead_xchacha20poly1305_ietf_decrypt(base_slot.data(), &written,
            nullptr, container + header_size + index * wrapped_slot_size,
            wrapped_slot_size, aad.data(), aad.size(), container + nonce,
            wrapping_key.data()) == 0;
    }
    if (!found) {
        for (const auto &record : layout.invitations) {
            if (decrypt_invitation(record, creator_password, creator_password_size,
                wrapping_key, creator_plain)) { found = true; break; }
        }
    }
    if (!found) throw ContainerFailure{ContainerError::authentication_failed};
    const std::uint8_t *document_key = creator_plain.empty()
        ? base_slot.data() : creator_plain.data();
    std::array<std::uint8_t, 16> slot_id{};
    randombytes_buf(slot_id.data(), slot_id.size());
    auto plain = invitation_plaintext(document_key, slot_id, permissions,
        must_change_flag, temporary_label, {});
    std::array<std::uint8_t, salt_size> salt{};
    std::array<std::uint8_t, nonce_size> nonce{};
    randombytes_buf(salt.data(), salt.size());
    randombytes_buf(nonce.data(), nonce.size());
    derive_wrapping_key(wrapping_key, temporary_password, temporary_password_size,
        salt.data());
    std::vector<std::uint8_t> cipher(plain.size() + tag_size);
    if (crypto_aead_xchacha20poly1305_ietf_encrypt(cipher.data(), &written,
        plain.data(), plain.size(), nullptr, 0, nullptr, nonce.data(),
        wrapping_key.data()) != 0 || written != cipher.size())
        throw ContainerFailure{ContainerError::crypto_error};

    const std::size_t base_end = header_size
        + layout.base_slot_count * wrapped_slot_size;
    std::vector<std::uint8_t> output;
    output.insert(output.end(), container, container + base_end);
    output.insert(output.end(), invitation_magic.begin(), invitation_magic.end());
    append_u32(output, static_cast<std::uint32_t>(layout.invitations.size() + 1));
    if (!layout.invitations.empty())
        output.insert(output.end(), container + base_end + 12,
            container + layout.snapshot_offset);
    output.insert(output.end(), salt.begin(), salt.end());
    output.insert(output.end(), nonce.begin(), nonce.end());
    append_u32(output, static_cast<std::uint32_t>(cipher.size()));
    output.insert(output.end(), cipher.begin(), cipher.end());
    output.insert(output.end(), container + layout.snapshot_offset,
        container + container_size);
    sodium_memzero(wrapping_key.data(), wrapping_key.size());
    sodium_memzero(base_slot.data(), base_slot.size());
    if (!creator_plain.empty()) sodium_memzero(creator_plain.data(), creator_plain.size());
    if (!plain.empty()) sodium_memzero(plain.data(), plain.size());
    return output;
}

std::vector<std::uint8_t> RecoverablePasswordContainer::claim_invitation(
    const std::uint8_t *container, std::size_t container_size,
    const std::uint8_t *temporary_password, std::size_t temporary_password_size,
    const std::uint8_t *new_password, std::size_t new_password_size,
    const std::string &profile_name, const std::string &profile_email)
{
    if (!security::password_is_strong(new_password, new_password_size))
        throw ContainerFailure{ContainerError::weak_password};
    if (profile_name.empty() || profile_email.empty()
        || profile_name.size() > max_holder_field_size
        || profile_email.size() > max_holder_field_size)
        throw ContainerFailure{ContainerError::invalid_argument};
    try {
        (void)unlock(container, container_size, new_password, new_password_size,
            format::RevisionLimits::defaults());
        throw ContainerFailure{ContainerError::password_already_in_use};
    } catch (const ContainerFailure &failure) {
        if (failure.error != ContainerError::authentication_failed) throw;
    }
    const auto layout = read_layout(container, container_size);
    require_sodium();
    std::array<std::uint8_t, key_size> wrapping_key{};
    std::vector<std::uint8_t> plain;
    const InvitationRecord *matched = nullptr;
    for (const auto &record : layout.invitations) {
        if (decrypt_invitation(record, temporary_password, temporary_password_size,
            wrapping_key, plain)) { matched = &record; break; }
    }
    if (matched == nullptr)
        throw ContainerFailure{ContainerError::authentication_failed};
    UnlockedContainerData access;
    decode_invitation_plaintext(plain, access);
    if (!access.must_be_changed)
        throw ContainerFailure{ContainerError::invalid_argument};
    auto replacement_plain = invitation_plaintext(plain.data(), access.slot_id,
        access.permissions, 0, profile_name, profile_email);
    derive_wrapping_key(wrapping_key, new_password, new_password_size, matched->salt);
    std::vector<std::uint8_t> cipher(replacement_plain.size() + tag_size);
    unsigned long long written = 0;
    if (crypto_aead_xchacha20poly1305_ietf_encrypt(cipher.data(), &written,
        replacement_plain.data(), replacement_plain.size(), nullptr, 0, nullptr,
        matched->nonce, wrapping_key.data()) != 0 || written != cipher.size())
        throw ContainerFailure{ContainerError::crypto_error};
    std::vector<std::uint8_t> output;
    output.insert(output.end(), container, container + matched->offset + 40);
    append_u32(output, static_cast<std::uint32_t>(cipher.size()));
    output.insert(output.end(), cipher.begin(), cipher.end());
    const auto old_end = matched->offset + invitation_prefix_size
        + matched->ciphertext_size;
    output.insert(output.end(), container + old_end, container + container_size);
    sodium_memzero(wrapping_key.data(), wrapping_key.size());
    sodium_memzero(plain.data(), plain.size());
    sodium_memzero(replacement_plain.data(), replacement_plain.size());
    return output;
}

std::vector<std::uint8_t> RecoverablePasswordContainer::replace_editing_lease(
    const std::uint8_t *container, std::size_t container_size,
    const std::uint8_t *password, std::size_t password_size,
    const EditingLeaseData &lease)
{
    const auto encoded_lease = encode_lease(lease);
    const auto current = unlock(container, container_size, password, password_size,
        format::RevisionLimits::defaults());
    if (current.must_be_changed || (current.permissions & 1u) == 0)
        throw ContainerFailure{ContainerError::invalid_argument};
    const std::uint32_t slot_count = read_u32(container + slot_count_offset);
    const auto layout = read_layout(container, container_size);
    if (!std::equal(magic.begin(), magic.end(), container)
        || read_u32(container + 8) != format_version
        || (slot_count != 1 && slot_count != 2)) {
        throw ContainerFailure{ContainerError::unsupported_format};
    }

    require_sodium();
    std::array<std::uint8_t, key_size> wrapping_key{}, snapshot_key{};
    std::array<std::uint8_t, slot_plaintext_size> slot{};
    std::vector<std::uint8_t> plaintext, replacement;
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
        std::vector<std::uint8_t> invited;
        if (!authenticated) {
            for (const auto &record : layout.invitations) {
                if (decrypt_invitation(record, password, password_size,
                    wrapping_key, invited)) {
                    std::copy_n(invited.data(), key_size, slot.begin());
                    authenticated = true;
                    break;
                }
            }
        }
        if (!authenticated) throw ContainerFailure{ContainerError::authentication_failed};

        const std::uint64_t old_encrypted_size = read_u64(
            container + encrypted_snapshot_size_offset);
        const std::size_t snapshot_offset = layout.snapshot_offset;
        if (old_encrypted_size < document_id_size + tag_size
            || snapshot_offset + old_encrypted_size != container_size)
            throw ContainerFailure{ContainerError::malformed_container};
        derive_snapshot_key(snapshot_key, slot.data());
        plaintext.resize(old_encrypted_size - tag_size);
        if (crypto_aead_xchacha20poly1305_ietf_decrypt(
            plaintext.data(), &written, nullptr, container + snapshot_offset,
            old_encrypted_size, container, header_size,
            container + snapshot_nonce_offset, snapshot_key.data()) != 0
            || written != plaintext.size()) {
            throw ContainerFailure{ContainerError::authentication_failed};
        }
        EditingLeaseData old_lease;
        const auto old_lease_size = decode_lease(plaintext.data() + document_id_size,
            plaintext.size() - document_id_size, old_lease);
        const auto revision_begin = plaintext.begin() + document_id_size + old_lease_size;
        replacement.insert(replacement.end(), plaintext.begin(),
            plaintext.begin() + document_id_size);
        replacement.insert(replacement.end(), encoded_lease.begin(), encoded_lease.end());
        replacement.insert(replacement.end(), revision_begin, plaintext.end());

        std::vector<std::uint8_t> output(snapshot_offset + replacement.size() + tag_size);
        std::copy_n(container, snapshot_offset, output.begin());
        randombytes_buf(output.data() + snapshot_nonce_offset, nonce_size);
        write_u64(output.data() + encrypted_snapshot_size_offset,
            replacement.size() + tag_size);
        if (crypto_aead_xchacha20poly1305_ietf_encrypt(
            output.data() + snapshot_offset, &written,
            replacement.data(), replacement.size(), output.data(), header_size,
            nullptr, output.data() + snapshot_nonce_offset, snapshot_key.data()) != 0
            || written != replacement.size() + tag_size) {
            throw ContainerFailure{ContainerError::crypto_error};
        }
        if (!replacement.empty()) sodium_memzero(replacement.data(), replacement.size());
        clear(wrapping_key, snapshot_key, slot, plaintext);
        return output;
    } catch (...) {
        if (!replacement.empty()) sodium_memzero(replacement.data(), replacement.size());
        clear(wrapping_key, snapshot_key, slot, plaintext);
        throw;
    }
}

} // namespace scpefe::container
