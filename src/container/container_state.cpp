#include "container/container_state.hpp"

namespace scpefe::container {
namespace {

void require(bool condition)
{
    if (!condition) throw StateError::invalid_transition;
}

void require_operation(const ContainerState &state, std::uint64_t operation_id)
{
    if (!state.operation_id || *state.operation_id != operation_id)
        throw StateError::stale_operation;
}

void clear_publication(ContainerState &state)
{
    state.publication = PublicationPhase::idle;
    state.operation_id.reset();
    state.publication_kind.reset();
}

void verified_publication(TransitionResult &result, std::uint64_t operation_id)
{
    const auto kind = *result.state.publication_kind;
    result.effects.push_back({EffectKind::adopt_candidate, operation_id});
    result.effects.push_back({EffectKind::clear_journal, operation_id});
    if (kind == PublicationKind::backup_attempt || kind == PublicationKind::export_attempt) {
        result.state.publication = PublicationPhase::awaiting_host_action;
        result.effects.push_back({kind == PublicationKind::backup_attempt
            ? EffectKind::perform_backup : EffectKind::perform_export, operation_id});
    } else {
        clear_publication(result.state);
    }
}

} // namespace

TransitionResult ContainerStateManagerService::apply(
    const ContainerState &current, const StateTransition &attempt) const
{
    TransitionResult result{current, {}};
    auto &next = result.state;
    if (std::holds_alternative<Open>(attempt)) {
        require(current.access == Access::closed);
        next.access = Access::open;
    } else if (const auto *unlock = std::get_if<Unlock>(&attempt)) {
        require(current.access == Access::open && current.screen == Screen::locked
            && current.publication == PublicationPhase::idle);
        require(!unlock->permissions.can_add_passwords || unlock->permissions.can_edit);
        require(!unlock->permissions.can_remove_passwords || unlock->permissions.can_edit);
        next.screen = Screen::unlocked;
        next.active_slot = unlock->slot_id;
        next.permissions = unlock->permissions;
        if (current.attention == Attention::reauthenticate)
            next.attention = Attention::none;
        if (unlock->may_attempt_edit && unlock->permissions.can_edit)
            result.effects.push_back({EffectKind::attempt_edit_lease});
    } else if (std::holds_alternative<Lock>(attempt)) {
        require(current.access == Access::open && current.screen == Screen::unlocked
            && current.publication == PublicationPhase::idle);
        if (current.edit == EditMode::editing)
            result.effects.push_back({EffectKind::stop_heartbeat});
        next.screen = Screen::locked;
        next.edit = EditMode::read_only;
        next.active_slot.reset();
        next.permissions = {};
        result.effects.push_back({EffectKind::clear_display});
    } else if (std::holds_alternative<Close>(attempt)) {
        require(current.access == Access::open
            && current.publication != PublicationPhase::publishing
            && current.publication != PublicationPhase::awaiting_host_action);
        if (current.publication != PublicationPhase::idle)
            result.effects.push_back({EffectKind::preserve_unsaved_work,
                current.operation_id.value_or(0)});
        if (current.edit == EditMode::editing)
            result.effects.push_back({EffectKind::stop_heartbeat});
        if (current.lease == Lease::held)
            result.effects.push_back({EffectKind::release_lease});
        if (current.screen == Screen::unlocked)
            result.effects.push_back({EffectKind::clear_display});
        next = ContainerState{};
        next.last_operation_id = current.last_operation_id;
    } else if (const auto *acquire = std::get_if<AcquireEdit>(&attempt)) {
        require(current.access == Access::open && current.screen == Screen::unlocked
            && current.permissions.can_edit && current.attention == Attention::none
            && current.publication == PublicationPhase::idle
            && acquire->lease == Lease::held);
        next.lease = Lease::held;
        next.edit = EditMode::editing;
        if (current.edit != EditMode::editing)
            result.effects.push_back({EffectKind::start_heartbeat});
    } else if (std::holds_alternative<ReleaseEdit>(attempt)) {
        require(current.access == Access::open && current.edit == EditMode::editing
            && current.publication == PublicationPhase::idle);
        next.edit = EditMode::read_only;
        next.lease = Lease::none;
        result.effects.push_back({EffectKind::stop_heartbeat});
        result.effects.push_back({EffectKind::release_lease});
    } else if (const auto *target = std::get_if<ApplyTargetPermissions>(&attempt)) {
        require(current.access == Access::open && current.screen == Screen::unlocked
            && current.publication == PublicationPhase::idle);
        require(!target->permissions.can_add_passwords || target->permissions.can_edit);
        require(!target->permissions.can_remove_passwords || target->permissions.can_edit);
        next.permissions = target->wrapper_changed ? Permissions{} : target->permissions;
        if (target->wrapper_changed) {
            next.attention = Attention::reauthenticate;
            next.screen = Screen::locked;
            next.active_slot.reset();
            result.effects.push_back({EffectKind::clear_display});
        }
        if (!next.permissions.can_edit && current.edit == EditMode::editing) {
            next.edit = EditMode::read_only;
            result.effects.push_back({EffectKind::stop_heartbeat});
            result.effects.push_back({EffectKind::preserve_unsaved_work});
        }
    } else if (const auto *attention = std::get_if<RaiseAttention>(&attempt)) {
        require(current.access == Access::open && attention->reason != Attention::none
            && attention->reason != Attention::reauthenticate
            && current.publication == PublicationPhase::idle);
        next.attention = attention->reason;
    } else if (std::holds_alternative<ClearAttention>(attempt)) {
        require(current.access == Access::open && current.attention != Attention::none
            && current.attention != Attention::reauthenticate
            && current.publication == PublicationPhase::idle);
        next.attention = Attention::none;
    } else if (const auto *begin = std::get_if<BeginPublication>(&attempt)) {
        require(current.access == Access::open && current.screen == Screen::unlocked
            && current.attention == Attention::none
            && begin->operation_id > current.last_operation_id);
        if (begin->kind == PublicationKind::activity_outcome) {
            require(current.publication == PublicationPhase::outcome_pending
                && current.operation_id != begin->operation_id);
        } else {
            require(current.publication == PublicationPhase::idle);
            if (begin->kind == PublicationKind::save)
                require(current.edit == EditMode::editing && current.permissions.can_edit
                    && current.lease == Lease::held);
        }
        next.publication = PublicationPhase::publishing;
        next.operation_id = begin->operation_id;
        next.last_operation_id = begin->operation_id;
        next.publication_kind = begin->kind;
        result.effects = {{EffectKind::reread_target, begin->operation_id},
            {EffectKind::journal_candidate, begin->operation_id},
            {EffectKind::publish_candidate, begin->operation_id}};
    } else if (const auto *ack = std::get_if<AcknowledgePublication>(&attempt)) {
        require_operation(current, ack->operation_id);
        require(current.publication == PublicationPhase::publishing);
        if (ack->outcome == PublicationOutcome::verified) {
            verified_publication(result, ack->operation_id);
        } else if (ack->outcome == PublicationOutcome::ambiguous) {
            next.publication = PublicationPhase::recovery_required;
            result.effects.push_back({EffectKind::recover_candidate, ack->operation_id});
        } else {
            if (current.publication_kind == PublicationKind::activity_outcome) {
                next.publication = PublicationPhase::outcome_pending;
                result.effects.push_back({EffectKind::preserve_unsaved_work,
                    ack->operation_id});
            } else {
                clear_publication(next);
                result.effects.push_back({EffectKind::clear_journal, ack->operation_id});
            }
        }
    } else if (const auto *complete = std::get_if<CompleteHostAction>(&attempt)) {
        require_operation(current, complete->operation_id);
        require(current.publication == PublicationPhase::awaiting_host_action);
        next.publication = PublicationPhase::outcome_pending;
        result.effects.push_back({complete->succeeded
            ? EffectKind::record_success_outcome : EffectKind::record_failure_outcome,
            complete->operation_id});
    } else if (const auto *resolve = std::get_if<ResolveAmbiguity>(&attempt)) {
        require_operation(current, resolve->operation_id);
        require(current.publication == PublicationPhase::recovery_required);
        if (resolve->published) verified_publication(result, resolve->operation_id);
        else {
            if (current.publication_kind == PublicationKind::activity_outcome) {
                next.publication = PublicationPhase::outcome_pending;
                result.effects.push_back({EffectKind::preserve_unsaved_work,
                    resolve->operation_id});
            } else {
                clear_publication(next);
                result.effects.push_back({EffectKind::clear_journal,
                    resolve->operation_id});
            }
        }
    }
    return result;
}

} // namespace scpefe::container
