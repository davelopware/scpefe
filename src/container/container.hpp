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
    bool lease_change{};
    bool lease_held_after{};
    std::optional<bool> activity_backup;
    std::array<std::uint8_t, 16> lease_session_after{};
    std::string discarded_content;
};

/* Retains the published attempt until its host outcome is recorded. */
struct PendingActivity {
    std::uint64_t attempt_operation_id{};
    std::array<std::uint8_t, 32> attempt_head{};
    bool backup{};
    std::optional<bool> succeeded;
};

/* Names an authenticated lease operation and the evidence observed by the host. */
enum class LeaseAction { acquire, refresh, release, resume, takeover };

/* Carries a session's requested lease and a fresh expected prior lease witness. */
struct LeaseChange {
    LeaseAction action;
    std::array<std::uint8_t, 16> session_id{};
    bool expected_active{};
    std::array<std::uint8_t, 16> expected_session_id{};
    std::uint64_t expected_counter{}, expected_holder_utc_ms{}, expected_duration_ms{};
    std::uint64_t now_utc_ms{}, unchanged_monotonic_ms{}, duration_ms{};
    std::string_view holder_name, holder_email, device_name;
    bool explicit_takeover{};
};

/* Core decision for entering Edit mode from authenticated lease evidence. */
enum class LeaseEntry { acquire, resume, takeover, confirm_takeover,
    blocked, changed };

/* Owns one container's installed state and observer subscriptions. */
class Container {
public:
    /* Injects services used by stateful revised-v3 document operations. */
    Container(const ContainerStateManagerService &state_manager,
        const core::PasswordService &password, const core::EncryptionService &encryption,
        const core::PersistenceService &persistence, const core::HistoryService &history);
    /* Prepares an encrypted baseline with its immutable document content type. */
    std::vector<std::uint8_t> create_document(std::string_view profile_name,
        std::string_view profile_email, std::string_view device_name,
        std::string_view content, std::uint8_t content_type,
        std::uint64_t timestamp_ms,
        const std::uint8_t *owner_password, std::size_t owner_password_size,
        const std::uint8_t *recovery_password, std::size_t recovery_password_size) const;
    /* Opens a validated revised-v3 document envelope. */
    void open_document(const std::uint8_t *bytes, std::size_t size);
    /* Verifies the current envelope password before restoring clear access. */
    const UnlockedContainerData &unlock_document(
        const std::uint8_t *password, std::size_t password_size);
    /* Authenticates an observed target, checks lineage, and overlays its current rights. */
    TransitionResult apply_target_document(const std::uint8_t *target_bytes,
        std::size_t target_size, const std::uint8_t *password,
        std::size_t password_size);
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
    /* Retains an authenticated divergent-replica merge as one publication candidate. */
    TransitionResult prepare_merge(std::uint64_t operation_id,
        const std::uint8_t *local_bytes, std::size_t local_size,
        const std::uint8_t *target_password, std::size_t target_password_size,
        const std::uint8_t *local_password, std::size_t local_password_size,
        std::string_view profile_name, std::string_view profile_email,
        std::string_view device_name, std::string_view resolved_content,
        std::uint64_t timestamp_ms);
    /* Checks a proposed merge and target rights without retaining a candidate. */
    void assess_merge(const std::uint8_t *local_bytes, std::size_t local_size,
        const std::uint8_t *target_password, std::size_t target_password_size,
        const std::uint8_t *local_password, std::size_t local_password_size,
        std::string_view profile_name, std::string_view profile_email,
        std::string_view device_name, std::string_view resolved_content,
        std::uint64_t timestamp_ms) const;
    /* Prepares compaction from a clean sealed image and an authenticated exact backup,
     * including a backup-attempt replica followed by its source outcome. */
    TransitionResult prepare_compaction(std::uint64_t operation_id,
        const std::uint8_t *password, std::size_t password_size,
        const std::array<std::uint8_t, 16> &lease_session_id,
        std::uint64_t lease_heartbeat_counter, bool explicit_decision,
        bool clean_state_confirmed, const std::uint8_t *verified_backup,
        std::size_t verified_backup_size, std::size_t retain_deltas,
        std::string_view client_name, std::string_view client_email,
        std::string_view device, std::uint64_t timestamp_ms);
    /* Prepares one authenticated slot change and exact encrypted candidate. */
    TransitionResult prepare_slot_change(std::uint64_t operation_id,
        const SlotChange &change, const std::uint8_t *actor_password,
        std::size_t actor_password_size, std::string_view client_name,
        std::string_view client_email, std::string_view device,
        std::uint64_t timestamp_ms);
    /* Prepares a backup or export attempt against the exact observed target. */
    TransitionResult prepare_activity_attempt(std::uint64_t operation_id,
        bool backup, bool clean_state_confirmed,
        const std::uint8_t *observed_target, std::size_t observed_size,
        const std::uint8_t *password, std::size_t password_size,
        std::string_view client_name, std::string_view client_email,
        std::string_view device, std::uint64_t timestamp_ms);
    /* Records the host result after an attempt was published. */
    TransitionResult complete_activity(std::uint64_t attempt_operation_id,
        bool succeeded);
    /* Restores a journaled outcome only when the published attempt is head. */
    TransitionResult restore_activity_outcome(
        std::uint64_t attempt_operation_id,
        const std::array<std::uint8_t, 32> &attempt_head,
        bool backup, bool succeeded,
        const std::uint8_t *observed_target, std::size_t observed_size);
    /* Prepares the pending result event against the exact observed target. */
    TransitionResult prepare_activity_outcome(std::uint64_t operation_id,
        const std::uint8_t *observed_target, std::size_t observed_size,
        const std::uint8_t *password, std::size_t password_size,
        std::string_view client_name, std::string_view client_email,
        std::string_view device, std::uint64_t timestamp_ms);
    /* Borrows the pending host action or outcome for app-private journaling. */
    const PendingActivity *pending_activity() const
        { return pending_activity_ ? &*pending_activity_ : nullptr; }
    /* Prepares a lease-only candidate after authenticating the current slot. */
    TransitionResult prepare_lease_change(std::uint64_t operation_id,
        const LeaseChange &change, const std::uint8_t *password,
        std::size_t password_size);
    /* Decides lease entry from the authenticated image and host clock evidence. */
    LeaseEntry advise_lease_entry(const std::array<std::uint8_t, 16> &suspended_session,
        std::uint64_t suspended_counter, std::uint64_t now_utc_ms,
        std::uint64_t unchanged_monotonic_ms) const;
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
    std::optional<PendingActivity> pending_activity_;
    ContainerState state_{};
    std::vector<ContainerStateObserver *> observers_;
    bool transitioning_{};
    std::optional<std::array<std::uint8_t, 16>> local_lease_session_;
};

} // namespace scpefe::container
