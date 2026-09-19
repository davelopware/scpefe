#include "container/password_container.hpp"

#include "container/container_error.hpp"
#include "format/revision_error.hpp"
#include "format/revision_limits.hpp"
#include "format/snapshot_revision.hpp"

#include <algorithm>
#include <array>
#include <cstring>
#include <limits>
#include <new>

extern "C" {
int sodium_init(void);
void randombytes_buf(void *buffer, std::size_t size);
void sodium_memzero(void *buffer, std::size_t size);
int crypto_pwhash(
    unsigned char *output,
    unsigned long long output_size,
    const char *password,
    unsigned long long password_size,
    const unsigned char *salt,
    unsigned long long operations_limit,
    std::size_t memory_limit,
    int algorithm
);
int crypto_kdf_derive_from_key(
    unsigned char *subkey,
    std::size_t subkey_size,
    std::uint64_t subkey_id,
    const char context[8],
    const unsigned char *key
);
int crypto_aead_xchacha20poly1305_ietf_encrypt(
    unsigned char *ciphertext,
    unsigned long long *ciphertext_size,
    const unsigned char *message,
    unsigned long long message_size,
    const unsigned char *additional_data,
    unsigned long long additional_data_size,
    const unsigned char *secret_nonce,
    const unsigned char *public_nonce,
    const unsigned char *key
);
int crypto_aead_xchacha20poly1305_ietf_decrypt(
    unsigned char *message,
    unsigned long long *message_size,
    unsigned char *secret_nonce,
    const unsigned char *ciphertext,
    unsigned long long ciphertext_size,
    const unsigned char *additional_data,
    unsigned long long additional_data_size,
    const unsigned char *public_nonce,
    const unsigned char *key
);
}

namespace scpefe::container {
namespace {

constexpr std::array<std::uint8_t, 8> magic{
    'S', 'C', 'P', 'E', 'F', 'E', 0, 1,
};
constexpr std::size_t header_size = 116;
constexpr std::size_t document_id_size = 16;
constexpr std::size_t slot_id_size = 16;
constexpr std::size_t key_size = 32;
constexpr std::size_t salt_size = 16;
constexpr std::size_t nonce_size = 24;
constexpr std::size_t tag_size = 16;
constexpr std::size_t slot_plaintext_size = key_size + slot_id_size + 1;
constexpr std::size_t wrapped_slot_size = slot_plaintext_size + tag_size;
constexpr std::uint32_t format_version = 1;
constexpr std::uint32_t argon2id13_algorithm = 2;
constexpr std::uint64_t operations_limit = 2;
constexpr std::uint64_t memory_limit = 64u * 1024u * 1024u;
constexpr std::uint32_t xchacha20_poly1305_algorithm = 1;
constexpr std::uint8_t owner_permissions = 0x07;
constexpr std::array<char, 8> snapshot_key_context{
    'S', 'C', 'P', 'S', 'N', 'A', 'P', '1',
};

constexpr std::size_t salt_offset = 32;
constexpr std::size_t wrap_nonce_offset = 52;
constexpr std::size_t snapshot_nonce_offset = 80;

/* Initializes Libsodium once and rejects an unavailable cryptographic backend. */
void require_sodium()
{
    static const int result = sodium_init();
    if (result < 0) throw ContainerFailure{ContainerError::crypto_error};
}

/* Writes a little-endian 32-bit envelope integer. */
void write_u32(std::uint8_t *output, std::uint32_t value)
{
    for (std::size_t index = 0; index < 4; ++index) {
        output[index] = static_cast<std::uint8_t>(value >> (index * 8));
    }
}

/* Writes a little-endian 64-bit envelope integer. */
void write_u64(std::uint8_t *output, std::uint64_t value)
{
    for (std::size_t index = 0; index < 8; ++index) {
        output[index] = static_cast<std::uint8_t>(value >> (index * 8));
    }
}

/* Reads a little-endian 32-bit envelope integer. */
std::uint32_t read_u32(const std::uint8_t *input)
{
    std::uint32_t value = 0;
    for (std::size_t index = 0; index < 4; ++index) {
        value |= static_cast<std::uint32_t>(input[index]) << (index * 8);
    }
    return value;
}

/* Reads a little-endian 64-bit envelope integer. */
std::uint64_t read_u64(const std::uint8_t *input)
{
    std::uint64_t value = 0;
    for (std::size_t index = 0; index < 8; ++index) {
        value |= static_cast<std::uint64_t>(input[index]) << (index * 8);
    }
    return value;
}

/* Derives the wrapping key using the fixed version-1 Argon2id parameters. */
void derive_wrapping_key(
    std::array<std::uint8_t, key_size> &key,
    const std::uint8_t *password,
    std::size_t password_size,
    const std::uint8_t *salt
)
{
    if (password_size > std::numeric_limits<unsigned long long>::max()
        || crypto_pwhash(
            key.data(), key.size(), reinterpret_cast<const char *>(password),
            password_size, salt, operations_limit, memory_limit,
            argon2id13_algorithm
        ) != 0) {
        throw ContainerFailure{ContainerError::out_of_memory};
    }
}

/* Derives the snapshot-encryption subkey from the random document key. */
void derive_snapshot_key(
    std::array<std::uint8_t, key_size> &subkey,
    const std::uint8_t *document_key
)
{
    if (crypto_kdf_derive_from_key(
        subkey.data(), subkey.size(), 1, snapshot_key_context.data(),
        document_key
    ) != 0) {
        throw ContainerFailure{ContainerError::crypto_error};
    }
}

/* Validates that bytes encode one canonical snapshot revision. */
void validate_snapshot(
    const std::uint8_t *encoded_snapshot_revision,
    std::size_t encoded_snapshot_revision_size,
    ContainerError invalid_error
)
{
    try {
        format::SnapshotRevision::decode(
            encoded_snapshot_revision,
            encoded_snapshot_revision_size,
            format::RevisionLimits::defaults()
        );
    } catch (const format::RevisionFailure &) {
        throw ContainerFailure{invalid_error};
    }
}

/* Clears all sensitive stack and vector storage used by container creation. */
void clear_creation_secrets(
    std::array<std::uint8_t, key_size> &document_key,
    std::array<std::uint8_t, key_size> &wrapping_key,
    std::array<std::uint8_t, key_size> &snapshot_key,
    std::array<std::uint8_t, slot_plaintext_size> &slot_plaintext,
    std::vector<std::uint8_t> &snapshot_plaintext
)
{
    sodium_memzero(document_key.data(), document_key.size());
    sodium_memzero(wrapping_key.data(), wrapping_key.size());
    sodium_memzero(snapshot_key.data(), snapshot_key.size());
    sodium_memzero(slot_plaintext.data(), slot_plaintext.size());
    if (!snapshot_plaintext.empty()) {
        sodium_memzero(snapshot_plaintext.data(), snapshot_plaintext.size());
    }
}

/* Clears all sensitive stack and vector storage used by container unlock. */
void clear_unlock_secrets(
    std::array<std::uint8_t, key_size> &wrapping_key,
    std::array<std::uint8_t, key_size> &snapshot_key,
    std::array<std::uint8_t, slot_plaintext_size> &slot_plaintext,
    std::vector<std::uint8_t> &snapshot_plaintext
)
{
    sodium_memzero(wrapping_key.data(), wrapping_key.size());
    sodium_memzero(snapshot_key.data(), snapshot_key.size());
    sodium_memzero(slot_plaintext.data(), slot_plaintext.size());
    if (!snapshot_plaintext.empty()) {
        sodium_memzero(snapshot_plaintext.data(), snapshot_plaintext.size());
    }
}

} // namespace

std::size_t PasswordContainer::encoded_size(std::size_t snapshot_size)
{
    constexpr std::size_t fixed_size = header_size + wrapped_slot_size
        + document_id_size + tag_size;
    if (snapshot_size > std::numeric_limits<std::size_t>::max() - fixed_size) {
        throw ContainerFailure{ContainerError::invalid_argument};
    }
    return fixed_size + snapshot_size;
}

std::vector<std::uint8_t> PasswordContainer::create(
    const std::uint8_t *password,
    std::size_t password_size,
    const std::uint8_t *encoded_snapshot_revision,
    std::size_t encoded_snapshot_revision_size
)
{
    validate_snapshot(encoded_snapshot_revision, encoded_snapshot_revision_size,
        ContainerError::invalid_argument);
    require_sodium();

    std::array<std::uint8_t, key_size> document_key{};
    std::array<std::uint8_t, key_size> wrapping_key{};
    std::array<std::uint8_t, key_size> snapshot_key{};
    std::array<std::uint8_t, slot_plaintext_size> slot_plaintext{};
    std::vector<std::uint8_t> snapshot_plaintext;
    try {
        std::vector<std::uint8_t> output(encoded_size(encoded_snapshot_revision_size));
        std::copy(magic.begin(), magic.end(), output.begin());
        write_u32(output.data() + 8, format_version);
        write_u32(output.data() + 12, argon2id13_algorithm);
        write_u64(output.data() + 16, operations_limit);
        write_u64(output.data() + 24, memory_limit);
        randombytes_buf(output.data() + salt_offset, salt_size);
        write_u32(output.data() + 48, xchacha20_poly1305_algorithm);
        randombytes_buf(output.data() + wrap_nonce_offset, nonce_size);
        write_u32(output.data() + 76, xchacha20_poly1305_algorithm);
        randombytes_buf(output.data() + snapshot_nonce_offset, nonce_size);
        write_u32(output.data() + 104, wrapped_slot_size);
        write_u64(output.data() + 108,
            document_id_size + encoded_snapshot_revision_size + tag_size);

        randombytes_buf(document_key.data(), document_key.size());
        std::copy(document_key.begin(), document_key.end(), slot_plaintext.begin());
        randombytes_buf(slot_plaintext.data() + key_size, slot_id_size);
        slot_plaintext.back() = owner_permissions;
        derive_wrapping_key(wrapping_key, password, password_size,
            output.data() + salt_offset);

        unsigned long long ciphertext_size = 0;
        if (crypto_aead_xchacha20poly1305_ietf_encrypt(
            output.data() + header_size, &ciphertext_size,
            slot_plaintext.data(), slot_plaintext.size(), output.data(), header_size,
            nullptr, output.data() + wrap_nonce_offset, wrapping_key.data()
        ) != 0 || ciphertext_size != wrapped_slot_size) {
            throw ContainerFailure{ContainerError::crypto_error};
        }

        snapshot_plaintext.resize(document_id_size + encoded_snapshot_revision_size);
        randombytes_buf(snapshot_plaintext.data(), document_id_size);
        std::copy(
            encoded_snapshot_revision,
            encoded_snapshot_revision + encoded_snapshot_revision_size,
            snapshot_plaintext.begin() + document_id_size
        );
        derive_snapshot_key(snapshot_key, document_key.data());
        if (crypto_aead_xchacha20poly1305_ietf_encrypt(
            output.data() + header_size + wrapped_slot_size, &ciphertext_size,
            snapshot_plaintext.data(), snapshot_plaintext.size(),
            output.data(), header_size, nullptr,
            output.data() + snapshot_nonce_offset, snapshot_key.data()
        ) != 0 || ciphertext_size != snapshot_plaintext.size() + tag_size) {
            throw ContainerFailure{ContainerError::crypto_error};
        }

        clear_creation_secrets(document_key, wrapping_key, snapshot_key,
            slot_plaintext, snapshot_plaintext);
        return output;
    } catch (...) {
        clear_creation_secrets(document_key, wrapping_key, snapshot_key,
            slot_plaintext, snapshot_plaintext);
        throw;
    }
}

UnlockedContainerData PasswordContainer::unlock(
    const std::uint8_t *container,
    std::size_t container_size,
    const std::uint8_t *password,
    std::size_t password_size
)
{
    constexpr std::size_t minimum_size = header_size + wrapped_slot_size
        + document_id_size + tag_size;
    if (container_size < minimum_size
        || container_size > encoded_size(
            format::RevisionLimits::defaults().max_input_bytes()
        )
        || !std::equal(magic.begin(), magic.end(), container)
        || read_u32(container + 8) != format_version
        || read_u32(container + 12) != argon2id13_algorithm
        || read_u64(container + 16) != operations_limit
        || read_u64(container + 24) != memory_limit
        || read_u32(container + 48) != xchacha20_poly1305_algorithm
        || read_u32(container + 76) != xchacha20_poly1305_algorithm
        || read_u32(container + 104) != wrapped_slot_size) {
        throw ContainerFailure{ContainerError::malformed_container};
    }
    const std::uint64_t encrypted_snapshot_size = read_u64(container + 108);
    if (encrypted_snapshot_size < document_id_size + tag_size
        || encrypted_snapshot_size > std::numeric_limits<std::size_t>::max()
        || static_cast<std::size_t>(encrypted_snapshot_size)
            != container_size - header_size - wrapped_slot_size) {
        throw ContainerFailure{ContainerError::malformed_container};
    }
    require_sodium();

    std::array<std::uint8_t, key_size> wrapping_key{};
    std::array<std::uint8_t, key_size> snapshot_key{};
    std::array<std::uint8_t, slot_plaintext_size> slot_plaintext{};
    std::vector<std::uint8_t> snapshot_plaintext;
    try {
        derive_wrapping_key(wrapping_key, password, password_size,
            container + salt_offset);
        unsigned long long plaintext_size = 0;
        if (crypto_aead_xchacha20poly1305_ietf_decrypt(
            slot_plaintext.data(), &plaintext_size, nullptr,
            container + header_size, wrapped_slot_size,
            container, header_size, container + wrap_nonce_offset,
            wrapping_key.data()
        ) != 0) {
            throw ContainerFailure{ContainerError::authentication_failed};
        }
        if (plaintext_size != slot_plaintext.size()
            || slot_plaintext.back() != owner_permissions) {
            throw ContainerFailure{ContainerError::malformed_container};
        }

        derive_snapshot_key(snapshot_key, slot_plaintext.data());
        snapshot_plaintext.resize(
            static_cast<std::size_t>(encrypted_snapshot_size) - tag_size
        );
        if (crypto_aead_xchacha20poly1305_ietf_decrypt(
            snapshot_plaintext.data(), &plaintext_size, nullptr,
            container + header_size + wrapped_slot_size,
            encrypted_snapshot_size, container, header_size,
            container + snapshot_nonce_offset, snapshot_key.data()
        ) != 0) {
            throw ContainerFailure{ContainerError::authentication_failed};
        }
        if (plaintext_size != snapshot_plaintext.size()
            || plaintext_size < document_id_size) {
            throw ContainerFailure{ContainerError::malformed_container};
        }

        const std::size_t revision_size = snapshot_plaintext.size() - document_id_size;
        validate_snapshot(snapshot_plaintext.data() + document_id_size,
            revision_size, ContainerError::malformed_container);
        UnlockedContainerData result;
        std::copy_n(snapshot_plaintext.data(), result.document_id.size(),
            result.document_id.begin());
        result.encoded_snapshot_revision.assign(
            snapshot_plaintext.begin() + document_id_size,
            snapshot_plaintext.end()
        );
        clear_unlock_secrets(wrapping_key, snapshot_key, slot_plaintext,
            snapshot_plaintext);
        return result;
    } catch (...) {
        clear_unlock_secrets(wrapping_key, snapshot_key, slot_plaintext,
            snapshot_plaintext);
        throw;
    }
}

} // namespace scpefe::container
