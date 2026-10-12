#include "container/revised_v3_container.hpp"

#include "container/container_error.hpp"
#include "format/revision_error.hpp"

#include <algorithm>
#include <array>
#include <cstring>
#include <limits>
#include <utility>
#include <vector>

extern "C" {
int sodium_init(void);
void sodium_memzero(void *, std::size_t);
int crypto_pwhash(unsigned char *, unsigned long long, const char *,
    unsigned long long, const unsigned char *, unsigned long long, std::size_t, int);
int crypto_kdf_derive_from_key(unsigned char *, std::size_t, std::uint64_t,
    const char[8], const unsigned char *);
int crypto_aead_xchacha20poly1305_ietf_decrypt(unsigned char *,
    unsigned long long *, unsigned char *, const unsigned char *,
    unsigned long long, const unsigned char *, unsigned long long,
    const unsigned char *, const unsigned char *);
int crypto_aead_xchacha20poly1305_ietf_encrypt(unsigned char *,
    unsigned long long *, const unsigned char *, unsigned long long,
    const unsigned char *, unsigned long long, const unsigned char *,
    const unsigned char *, const unsigned char *);
void randombytes_buf(void *, std::size_t);
}

namespace scpefe::container {
namespace {

constexpr std::size_t header_size = 72, record_size = 110, tag_size = 16;
constexpr std::size_t wrapper_plain_size = 50;
constexpr std::array<std::uint8_t, 8> magic{'S','C','P','E','F','E',0,3};
constexpr std::array<char, 8> payload_context{'S','C','P','S','N','A','P','1'};
constexpr std::array<char, 8> journal_context{'S','C','P','J','R','N','0','1'};
constexpr char slot_aad_prefix[] = "SCPEFE-slot-v3";

std::uint64_t read_le(const std::uint8_t *bytes, std::size_t count)
{
    std::uint64_t value = 0;
    for (std::size_t i = 0; i < count; ++i) value |= std::uint64_t(bytes[i]) << (8 * i);
    return value;
}

void write_le(std::uint8_t *bytes, std::uint64_t value, std::size_t count)
{
    for (std::size_t i = 0; i < count; ++i)
        bytes[i] = static_cast<std::uint8_t>(value >> (8 * i));
}

struct Secrets {
    std::array<std::uint8_t, 32> wrapping{}, document{}, payload{};
    std::array<std::uint8_t, wrapper_plain_size> slot{};
    std::vector<std::uint8_t> plaintext;
    ~Secrets()
    {
        sodium_memzero(wrapping.data(), wrapping.size());
        sodium_memzero(document.data(), document.size());
        sodium_memzero(payload.data(), payload.size());
        sodium_memzero(slot.data(), slot.size());
        if (!plaintext.empty()) sodium_memzero(plaintext.data(), plaintext.size());
    }
};

ContainerError graph_error(format::RevisionError error)
{
    switch (error) {
    case format::RevisionError::limit_exceeded: return ContainerError::limit_exceeded;
    case format::RevisionError::unsupported_format: return ContainerError::unsupported_format;
    case format::RevisionError::invalid_argument:
    case format::RevisionError::malformed_cbor: return ContainerError::malformed_container;
    }
    return ContainerError::malformed_container;
}

} // namespace

bool RevisedV3Container::recognizes(const std::uint8_t *bytes, std::size_t size)
{
    if (!bytes || size < header_size + record_size + 33
        || !std::equal(magic.begin(), magic.end(), bytes)) return false;
    const auto slots = read_le(bytes + 32, 4);
    const auto payload = read_le(bytes + 64, 8);
    if (slots < 1 || slots > 9) return false;
    const auto offset = header_size + record_size * slots;
    return size >= offset && payload == size - offset;
}

void RevisedV3Container::validate_structure(const std::uint8_t *bytes, std::size_t size)
{
    if (!bytes || size < header_size || !std::equal(magic.begin(), magic.end(), bytes))
        throw ContainerFailure{ContainerError::malformed_container};
    if (size > 33u * 1024u * 1024u)
        throw ContainerFailure{ContainerError::limit_exceeded};
    if (read_le(bytes + 8, 4) != 3 || read_le(bytes + 12, 4) != 2
        || read_le(bytes + 16, 8) != 2 || read_le(bytes + 24, 8) != 67108864
        || read_le(bytes + 36, 4) != 1)
        throw ContainerFailure{ContainerError::unsupported_format};
    const auto slots = read_le(bytes + 32, 4);
    if (slots < 1 || slots > 9) throw ContainerFailure{ContainerError::malformed_container};
    const auto records_end = header_size + record_size * slots;
    const auto payload = read_le(bytes + 64, 8);
    if (size < records_end || payload < 33 || payload > size - records_end
        || payload != size - records_end)
        throw ContainerFailure{ContainerError::malformed_container};
    for (std::size_t i = 0; i < slots; ++i) {
        const auto *record = bytes + header_size + i * record_size;
        if (read_le(record + 40, 4) != 66)
            throw ContainerFailure{ContainerError::unsupported_format};
        for (std::size_t j = 0; j < i; ++j) {
            const auto *earlier = bytes + header_size + j * record_size;
            if (std::memcmp(record, earlier, 40) == 0)
                throw ContainerFailure{ContainerError::malformed_container};
        }
    }
}

UnlockedContainerData RevisedV3Container::unlock(const std::uint8_t *bytes,
    std::size_t size, const std::uint8_t *password, std::size_t password_size,
    const format::RevisionLimits &limits)
{
    validate_structure(bytes, size);
    if (!password || password_size == 0 || password_size > 4096)
        throw ContainerFailure{ContainerError::invalid_argument};
    if (sodium_init() < 0) throw ContainerFailure{ContainerError::crypto_error};
    Secrets secrets;
    const auto count = static_cast<std::size_t>(read_le(bytes + 32, 4));
    const auto aad_size = header_size + record_size * count;
    const auto encrypted_size = size - aad_size;
    std::size_t selected = count;
    unsigned long long written = 0;
    for (std::size_t i = 0; i < count; ++i) {
        const auto *record = bytes + header_size + i * record_size;
        if (crypto_pwhash(secrets.wrapping.data(), secrets.wrapping.size(),
            reinterpret_cast<const char *>(password), password_size, record,
            2, 67108864, 2) != 0)
            throw ContainerFailure{ContainerError::out_of_memory};
        std::array<std::uint8_t, sizeof(slot_aad_prefix) - 1 + 32 + 4 + 16 + 24> aad{};
        std::size_t offset = 0;
        std::memcpy(aad.data() + offset, slot_aad_prefix, sizeof(slot_aad_prefix) - 1);
        offset += sizeof(slot_aad_prefix) - 1;
        std::memcpy(aad.data() + offset, bytes, 32); offset += 32;
        std::memcpy(aad.data() + offset, bytes + 36, 4); offset += 4;
        std::memcpy(aad.data() + offset, record, 40);
        if (crypto_aead_xchacha20poly1305_ietf_decrypt(secrets.slot.data(),
            &written, nullptr, record + 44, 66, aad.data(), aad.size(),
            record + 16, secrets.wrapping.data()) == 0) {
            if (written != wrapper_plain_size || (secrets.slot[48] & ~7u) != 0
                || secrets.slot[49] > 1)
                throw ContainerFailure{ContainerError::malformed_container};
            std::copy_n(secrets.slot.data(), secrets.document.size(),
                secrets.document.begin());
            selected = i;
            break;
        }
    }
    if (selected == count) throw ContainerFailure{ContainerError::authentication_failed};
    if (crypto_kdf_derive_from_key(secrets.payload.data(), secrets.payload.size(),
        1, payload_context.data(), secrets.document.data()) != 0)
        throw ContainerFailure{ContainerError::crypto_error};
    secrets.plaintext.resize(encrypted_size - tag_size);
    if (crypto_aead_xchacha20poly1305_ietf_decrypt(secrets.plaintext.data(),
        &written, nullptr, bytes + aad_size, encrypted_size, bytes, aad_size,
        bytes + 40, secrets.payload.data()) != 0)
        throw ContainerFailure{ContainerError::authentication_failed};
    if (written != secrets.plaintext.size() || written < 17)
        throw ContainerFailure{ContainerError::malformed_container};
    format::RevisionGraph graph;
    try {
        graph = format::RevisionGraph::decode(secrets.plaintext.data() + 16,
            secrets.plaintext.size() - 16, limits);
    } catch (const format::RevisionFailure &failure) {
        throw ContainerFailure{graph_error(failure.error)};
    }
    if (graph.slots().size() != count)
        throw ContainerFailure{ContainerError::malformed_container};
    const auto &active = graph.slots()[selected];
    if (!std::equal(active.id.begin(), active.id.end(), secrets.slot.begin() + 32)
        || ((active.role == 0 || active.role == 2)
            && (secrets.slot[48] != 7 || secrets.slot[49] != 0)))
        throw ContainerFailure{ContainerError::malformed_container};
    UnlockedContainerData result;
    std::copy_n(secrets.plaintext.data(), result.document_id.size(), result.document_id.begin());
    result.slot_id = active.id;
    result.permissions = active.permissions;
    result.must_be_changed = secrets.slot[49] != 0 || active.must_be_changed;
    result.owner_slot = active.role == 0;
    result.recovery_slot = active.role == 2;
    result.slot_identity_name = active.name;
    result.slot_identity_email = active.email;
    const auto &lease = graph.lease();
    result.editing_lease.session_id = lease.session_id;
    result.editing_lease.heartbeat_counter = lease.heartbeat_counter;
    result.editing_lease.holder_utc_ms = lease.holder_utc_ms;
    result.editing_lease.duration_ms = lease.duration_ms;
    result.editing_lease.holder_name = lease.holder_name;
    result.editing_lease.holder_email = lease.holder_email;
    result.editing_lease.device_name = lease.device;
    result.editing_lease.active = lease.active;
    for (const auto &slot : graph.slots()) {
        if (slot.role != 1) continue;
        ManagedSlotData managed;
        managed.slot_id = slot.id;
        managed.actual_slot_id = slot.id;
        managed.permissions = slot.permissions;
        managed.must_be_changed = slot.must_be_changed;
        managed.identity_name = slot.name;
        managed.identity_email = slot.email;
        result.managed_slots.push_back(std::move(managed));
    }
    if (crypto_kdf_derive_from_key(result.work_journal_key.data(),
        result.work_journal_key.size(), 2, journal_context.data(),
        secrets.document.data()) != 0)
        throw ContainerFailure{ContainerError::crypto_error};
    result.revision_graph.emplace(std::move(graph));
    return result;
}

std::vector<std::uint8_t> RevisedV3Container::replace_graph(
    const std::uint8_t *bytes, std::size_t size, const std::uint8_t *password,
    std::size_t password_size, const std::uint8_t *graph, std::size_t graph_size)
{
    const auto authenticated = unlock(bytes, size, password, password_size,
        format::RevisionLimits::defaults());
    (void)format::RevisionGraph::decode(graph, graph_size,
        format::RevisionLimits::defaults());
    if (graph_size > 33u * 1024u * 1024u - header_size - record_size - 33)
        throw ContainerFailure{ContainerError::limit_exceeded};
    Secrets secrets;
    const auto count = static_cast<std::size_t>(read_le(bytes + 32, 4));
    const auto aad_size = header_size + count * record_size;
    unsigned long long written = 0;
    bool matched = false;
    for (std::size_t i = 0; i < count; ++i) {
        const auto *record = bytes + header_size + i * record_size;
        if (crypto_pwhash(secrets.wrapping.data(), secrets.wrapping.size(),
            reinterpret_cast<const char *>(password), password_size, record,
            2, 67108864, 2) != 0)
            throw ContainerFailure{ContainerError::out_of_memory};
        std::array<std::uint8_t, sizeof(slot_aad_prefix) - 1 + 32 + 4 + 16 + 24> aad{};
        std::size_t offset = 0;
        std::memcpy(aad.data() + offset, slot_aad_prefix, sizeof(slot_aad_prefix) - 1);
        offset += sizeof(slot_aad_prefix) - 1;
        std::memcpy(aad.data() + offset, bytes, 32); offset += 32;
        std::memcpy(aad.data() + offset, bytes + 36, 4); offset += 4;
        std::memcpy(aad.data() + offset, record, 40);
        if (crypto_aead_xchacha20poly1305_ietf_decrypt(secrets.slot.data(),
            &written, nullptr, record + 44, 66, aad.data(), aad.size(),
            record + 16, secrets.wrapping.data()) == 0) {
            if (written != wrapper_plain_size
                || !std::equal(authenticated.slot_id.begin(),
                    authenticated.slot_id.end(), secrets.slot.begin() + 32))
                throw ContainerFailure{ContainerError::malformed_container};
            std::copy_n(secrets.slot.data(), secrets.document.size(),
                secrets.document.begin());
            matched = true;
            break;
        }
    }
    if (!matched) throw ContainerFailure{ContainerError::authentication_failed};
    if (crypto_kdf_derive_from_key(secrets.payload.data(), secrets.payload.size(),
        1, payload_context.data(), secrets.document.data()) != 0)
        throw ContainerFailure{ContainerError::crypto_error};
    secrets.plaintext.resize(authenticated.document_id.size() + graph_size);
    std::copy(authenticated.document_id.begin(), authenticated.document_id.end(),
        secrets.plaintext.begin());
    std::copy_n(graph, graph_size, secrets.plaintext.begin() + 16);
    const auto encrypted_size = secrets.plaintext.size() + tag_size;
    if (aad_size + encrypted_size > 33u * 1024u * 1024u)
        throw ContainerFailure{ContainerError::limit_exceeded};
    std::vector<std::uint8_t> result(aad_size + encrypted_size);
    std::copy_n(bytes, aad_size, result.begin());
    randombytes_buf(result.data() + 40, 24);
    write_le(result.data() + 64, encrypted_size, 8);
    if (crypto_aead_xchacha20poly1305_ietf_encrypt(result.data() + aad_size,
        &written, secrets.plaintext.data(), secrets.plaintext.size(),
        result.data(), aad_size, nullptr, result.data() + 40,
        secrets.payload.data()) != 0 || written != encrypted_size)
        throw ContainerFailure{ContainerError::crypto_error};
    return result;
}

} // namespace scpefe::container
