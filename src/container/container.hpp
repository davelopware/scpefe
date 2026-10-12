#pragma once

#include "container/container_state.hpp"
#include "container/container_state_observer.hpp"
#include "container/unlocked_container_data.hpp"
#include "container/password_slots.hpp"
#include "core/password_service.hpp"
#include "core/encryption_service.hpp"
#include "core/persistence_service.hpp"
#include "core/history_service.hpp"

#include <cstdint>
#include <vector>
#include <optional>
#include <string>
#include <string_view>

namespace scpefe::container {

/* Owns one exact serialized proposal until its publication is resolved. */
struct ContainerCandidate {
    std::uint64_t operation_id{};
    std::array<std::uint8_t, 32> source_head{};
    std::vector<std::uint8_t> bytes;
    UnlockedContainerData adopted_data;
    std::uint64_t submitted_generation{};
    bool discard{};
    bool removes_active_slot{};
    bool slot_change{};
    std::string discarded_content;
};

/* Owns one container's installed state and observer subscriptions. */
class Container {
public:
    /* Injects the services used by state and prerefactor document operations. */
    Container(const ContainerStateManagerService &state_manager,
        const core::PasswordService &password, const core::EncryptionService &encryption,
        const core::PersistenceService &persistence, const core::HistoryService &history);
    /* Prepares an encrypted revised-v3 baseline using this context's services. */
    std::vector<std::uint8_t> create_document(std::string_view profile_name,
        std::string_view profile_email, std::string_view device_name,
        std::string_view content, std::uint64_t timestamp_ms,
        const std::uint8_t *owner_password, std::size_t owner_password_size,
        const std::uint8_t *recovery_password, std::size_t recovery_password_size) const;
    /* Opens a revised-v3 history or transitional v3 snapshot envelope. */
    void open_document(const std::uint8_t *bytes, std::size_t size);
    /* Validates and stores a transitional 160-byte-header envelope without a password. */
    void open_legacy_document(const std::uint8_t *bytes, std::size_t size);
    /* Verifies the current envelope password before restoring clear access. */
    const UnlockedContainerData &unlock_legacy_document(
        const std::uint8_t *password, std::size_t password_size);
    /* Verifies one same-document target, pins its bytes, and applies active-slot rights. */
    TransitionResult apply_target_legacy_document(const std::uint8_t *target_bytes,
        std::size_t target_size, const std::uint8_t *password,
        std::size_t password_size);
    /* Prepares a compaction candidate from the current committed envelope. */
    std::vector<std::uint8_t> compact_legacy_document(
        const std::uint8_t *password, std::size_t password_size,
        const std::array<std::uint8_t, 16> &lease_session_id,
        std::uint64_t heartbeat_counter) const;
    /* Returns the currently installed immutable state snapshot. */
    const ContainerState &state() const { return state_; }
    /* Reports whether this session may expose currently available clear data. */
    bool can_read_clear() const;
    /* Reports an authenticated temporary invitation still awaiting a committed claim. */
    bool requires_password_change() const;
    /* Borrows authenticated values only while clear reads are permitted. */
    const UnlockedContainerData *read_unlocked() const;
    /* Borrows authenticated slot and journal state even during invitation claim. */
    const UnlockedContainerData *read_authenticated_state() const;
    /* Returns submitted clear text, which may be newer than the confirmed image. */
    const std::string *read_content_clear() const;
    /* Submits canonical text without changing the confirmed image or head. */
    void submit_content(std::string_view content);
    /* Accepts the host's confirmed editing lease before a save publication. */
    TransitionResult confirm_edit_lease();
    /* Serializes one manual, regular, or discard proposal exactly once. */
    TransitionResult prepare_save(std::uint64_t operation_id, bool regular,
        bool discard, const std::uint8_t *password, std::size_t password_size,
        std::string_view profile_name, std::string_view profile_email,
        std::string_view device_name, std::uint64_t timestamp_ms);
    /* Prepares one authenticated slot change and exact encrypted candidate. */
    TransitionResult prepare_slot_change(std::uint64_t operation_id,
        const SlotChange &change, const std::uint8_t *actor_password,
        std::size_t actor_password_size, std::string_view client_name,
        std::string_view client_email, std::string_view device,
        std::uint64_t timestamp_ms);
    /* Returns the unresolved proposal for immediate caller copies. */
    const ContainerCandidate *candidate() const { return candidate_ ? &*candidate_ : nullptr; }
    /* Applies a host result for the matching proposal; only verified success adopts it. */
    TransitionResult acknowledge_save(std::uint64_t operation_id, PublicationOutcome outcome);
    /* Resolves an ambiguous host result against the exact retained proposal. */
    TransitionResult resolve_save(std::uint64_t operation_id, bool published);
    /* Borrows the encrypted committed image for an immediate caller copy. */
    const std::vector<std::uint8_t> &committed_bytes() const { return committed_bytes_; }
    /* Installs Lock, Close, ReleaseEdit, or RaiseAttention only. */
    TransitionResult transition(const StateTransition &attempt);
    /* Tries a safe public transition while retaining state on rejection. */
    bool try_transition(const StateTransition &attempt);
    /* Subscribes an observer for the lifetime of this container or until removal. */
    void subscribe(ContainerStateObserver &observer);
    /* Removes a previously registered observer. */
    void unsubscribe(ContainerStateObserver &observer);

private:
    /* Installs a transition after its caller has verified any required facts. */
    TransitionResult install_transition(const StateTransition &attempt);
    const ContainerStateManagerService &state_manager_;
    const core::PasswordService &password_;
    const core::EncryptionService &encryption_;
    const core::PersistenceService &persistence_;
    const core::HistoryService &history_;
    std::vector<std::uint8_t> committed_bytes_;
    std::vector<std::uint8_t> target_bytes_;
    std::optional<std::array<std::uint8_t, 16>> document_id_;
    std::optional<UnlockedContainerData> unlocked_;
    std::optional<std::string> content_clear_;
    std::uint64_t content_generation_{};
    std::optional<ContainerCandidate> candidate_;
    ContainerState state_{};
    std::vector<ContainerStateObserver *> observers_;
    bool transitioning_{};
    bool revised_v3_{};
};

} // namespace scpefe::container
