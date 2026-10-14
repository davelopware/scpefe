#pragma once

#include <cstddef>
#include <cstdint>
#include <string_view>
#include <vector>
#include "container/unlocked_container_data.hpp"
#include "format/revision_limits.hpp"

namespace scpefe::core {

/* Supplies cryptographic operations for revised-v3 creation. */
class EncryptionService;

/* Screens and authenticates revised-v3 encrypted document envelopes. */
class PersistenceService {
public:
    /* Permits bounded parsing substitution in context tests. */
    virtual ~PersistenceService() = default;
    /* Serializes a revised-v3 New baseline and encrypts its initial envelope. */
    virtual std::vector<std::uint8_t> create_revised_document(
        std::string_view profile_name, std::string_view profile_email,
        std::string_view device_name, std::string_view content,
        std::uint64_t timestamp_ms, const std::uint8_t *owner_password,
        std::size_t owner_password_size, const std::uint8_t *recovery_password,
        std::size_t recovery_password_size,
        const EncryptionService &encryption) const;
    /* Validates revised v3 public framing before password derivation. */
    virtual void validate_revised_envelope(const std::uint8_t *bytes,
        std::size_t size) const;
    /* Authenticates and decodes the revised v3 graph and slot metadata. */
    virtual container::UnlockedContainerData unlock_revised_envelope(
        const std::uint8_t *bytes, std::size_t size,
        const std::uint8_t *password, std::size_t password_size,
        const format::RevisionLimits &limits) const;
    /* Serializes one revised-v3 payload exactly once with a fresh payload nonce. */
    virtual std::vector<std::uint8_t> replace_revised_graph(
        const std::uint8_t *bytes, std::size_t size,
        const std::uint8_t *password, std::size_t password_size,
        const std::uint8_t *graph, std::size_t graph_size) const;
};

} // namespace scpefe::core
