#pragma once

#include "container/container_state.hpp"
#include "container/container_state_observer.hpp"
#include "container/unlocked_container_data.hpp"
#include "core/password_service.hpp"
#include "core/encryption_service.hpp"
#include "core/persistence_service.hpp"
#include "core/history_service.hpp"

#include <cstdint>
#include <vector>
#include <optional>
#include <string_view>

namespace scpefe::container {

/* Owns one container's installed state and observer subscriptions. */
class Container {
public:
    /* Injects the services used by state and prerefactor document operations. */
    Container(const ContainerStateManagerService &state_manager,
        const core::PasswordService &password, const core::EncryptionService &encryption,
        const core::PersistenceService &persistence, const core::HistoryService &history);
    /* Prepares an encrypted initial candidate using this context's services. */
    std::vector<std::uint8_t> create_document(std::string_view profile_name,
        std::string_view profile_email, std::string_view device_name,
        std::string_view content, std::uint64_t timestamp_ms,
        const std::uint8_t *owner_password, std::size_t owner_password_size,
        const std::uint8_t *recovery_password, std::size_t recovery_password_size) const;
    /* Validates and stores a transitional 160-byte-header envelope without a password. */
    void open_legacy_document(const std::uint8_t *bytes, std::size_t size);
    /* Authenticates the open document and installs its effective permissions. */
    const UnlockedContainerData &unlock_legacy_document(
        const std::uint8_t *password, std::size_t password_size);
    /* Reauthenticates a changed target wrapper while retaining local committed bytes. */
    const UnlockedContainerData &unlock_target_legacy_document(
        const std::uint8_t *target_bytes, std::size_t target_size,
        const std::uint8_t *password, std::size_t password_size);
    /* Prepares a compaction candidate from the current committed envelope. */
    std::vector<std::uint8_t> compact_legacy_document(
        const std::uint8_t *password, std::size_t password_size,
        const std::array<std::uint8_t, 16> &lease_session_id,
        std::uint64_t heartbeat_counter) const;
    /* Returns the currently installed immutable state snapshot. */
    const ContainerState &state() const { return state_; }
    /* Reports whether this session may expose currently available clear data. */
    bool can_read_clear() const;
    /* Computes, installs, and announces a valid state transition. */
    TransitionResult transition(const StateTransition &attempt);
    /* Attempts a transition while retaining state on a rejected request. */
    bool try_transition(const StateTransition &attempt);
    /* Subscribes an observer for the lifetime of this container or until removal. */
    void subscribe(ContainerStateObserver &observer);
    /* Removes a previously registered observer. */
    void unsubscribe(ContainerStateObserver &observer);

private:
    const ContainerStateManagerService &state_manager_;
    const core::PasswordService &password_;
    const core::EncryptionService &encryption_;
    const core::PersistenceService &persistence_;
    const core::HistoryService &history_;
    std::vector<std::uint8_t> committed_bytes_;
    std::vector<std::uint8_t> target_bytes_;
    std::optional<std::array<std::uint8_t, 16>> document_id_;
    std::optional<UnlockedContainerData> unlocked_;
    ContainerState state_{};
    std::vector<ContainerStateObserver *> observers_;
    bool transitioning_{};
};

} // namespace scpefe::container
