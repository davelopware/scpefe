#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <variant>
#include <vector>

namespace scpefe::container {

/* Distinguishes an absent container from one whose envelope is open. */
enum class Access { closed, open };
/* Distinguishes screen privacy from authenticated clear access. */
enum class Screen { locked, unlocked };
/* Records whether content mutation is authorized by the editing lease. */
enum class EditMode { read_only, editing };
/* Records the authenticated advisory editing lease status. */
enum class Lease { none, held, other_holder, uncertain };
/* Identifies an unresolved decision that blocks publication. */
enum class Attention { none, conflict, target_replaced, reauthenticate };
/* Distinguishes the stages of one serialized publication or external action. */
enum class PublicationPhase { idle, publishing, awaiting_host_action, outcome_pending, recovery_required };
/* Identifies the candidate's authorized purpose. */
enum class PublicationKind { save, slot_change, lease_change, backup_attempt, export_attempt, activity_outcome };
/* Distinguishes verified publication from definite and ambiguous failures. */
enum class PublicationOutcome { verified, definite_failure, ambiguous };

/* Carries the effective rights of the currently authenticated slot. */
struct Permissions {
    bool can_edit{};
    bool can_add_passwords{};
    bool can_remove_passwords{};
    /* Compares all effective permission bits. */
    bool operator==(const Permissions &) const = default;
};

/* Identifies one immutable password slot in the authenticated document. */
using SlotId = std::array<std::uint8_t, 16>;

/* Retains authenticated target access until the target image is adopted or closed. */
struct TargetAccess {
    SlotId slot_id;
    Permissions permissions;
    bool wrapper_changed{};
    /* Compares the authenticated target overlay. */
    bool operator==(const TargetAccess &) const = default;
};

/* Captures one immutable access, lease, attention, and publication snapshot. */
struct ContainerState {
    Access access{Access::closed};
    Screen screen{Screen::locked};
    std::optional<SlotId> active_slot;
    Permissions permissions{};
    std::optional<TargetAccess> target_access;
    EditMode edit{EditMode::read_only};
    Lease lease{Lease::none};
    Attention attention{Attention::none};
    PublicationPhase publication{PublicationPhase::idle};
    std::optional<std::uint64_t> operation_id;
    std::uint64_t last_operation_id{};
    std::optional<PublicationKind> publication_kind;
    /* Compares complete state snapshots before observer notification. */
    bool operator==(const ContainerState &) const = default;
};

/* Opens a validated envelope without exposing clear content. */
struct Open {};
/* Carries slot facts verified by Container before its state changes. */
struct Unlock {
    SlotId slot_id;
    Permissions permissions;
    bool may_attempt_edit;
    bool authenticated_target_wrapper{};
    Lease authenticated_lease{Lease::none};
};
/* Hides clear content and stops this session's lease heartbeat. */
struct Lock {};
/* Refreshes effective rights after an authenticated slot candidate is adopted. */
struct AuthenticatedSlotPermissions { Permissions permissions; bool may_attempt_edit; };
/* Releases the open container and any retained lease. */
struct Close {};
/* Records a confirmed lease acquisition for an eligible editor. */
struct AcquireEdit { Lease lease; };
/* Returns the document session to read-only mode. */
struct ReleaseEdit {};
/* Installs authenticated lease facts only after verified candidate publication. */
struct PublishedLease { bool held; };
/* Carries active-slot rights derived from an authenticated target. */
struct ApplyTargetPermissions { Permissions permissions; bool wrapper_changed; };
/* Requires a user decision before the next publication. */
struct RaiseAttention { Attention reason; };
/* Clears attention after the required decision or reauthentication. */
struct ClearAttention {};
/* Starts exactly one candidate publication with a fresh operation ID. */
struct BeginPublication { std::uint64_t operation_id; PublicationKind kind; };
/* Carries a host-verified result for the matching publication. */
struct AcknowledgePublication { std::uint64_t operation_id; PublicationOutcome outcome; };
/* Reports completion of a backup or export following its published attempt. */
struct CompleteHostAction { std::uint64_t operation_id; bool succeeded; };
/* Resumes a journaled ambiguous publication after host reconciliation. */
struct ResolveAmbiguity { std::uint64_t operation_id; bool published; };

/* Carries exactly one typed state transition request. */
using StateTransition = std::variant<Open, Unlock, Lock, AuthenticatedSlotPermissions,
    Close, AcquireEdit,
    ReleaseEdit, PublishedLease, ApplyTargetPermissions, RaiseAttention, ClearAttention,
    BeginPublication, AcknowledgePublication, CompleteHostAction, ResolveAmbiguity>;

/* Names an action that the host must perform outside the state manager. */
enum class EffectKind {
    attempt_edit_lease, start_heartbeat, stop_heartbeat, clear_display,
    release_lease, reread_target, journal_candidate, publish_candidate,
    adopt_candidate, clear_journal, recover_candidate, perform_backup,
    perform_export, record_success_outcome, record_failure_outcome,
    preserve_unsaved_work
};

/* Associates a required external action with its operation when applicable. */
struct RequiredEffect { EffectKind kind; std::uint64_t operation_id{}; };
/* Returns a proposed state and required effects without performing I/O. */
struct TransitionResult {
    ContainerState state;
    std::vector<RequiredEffect> effects;
};

/* Identifies a rejected or stale transition without altering installed state. */
enum class StateError { invalid_transition, stale_operation };

/* Computes transitions from supplied facts without authenticating those facts. */
class ContainerStateManagerService {
public:
    /* Allows a context to own a concrete manager or a deterministic fake. */
    virtual ~ContainerStateManagerService() = default;
    /* Computes the new state without mutating the current one. */
    virtual TransitionResult apply(const ContainerState &current,
        const StateTransition &attempt) const;
};

} // namespace scpefe::container
