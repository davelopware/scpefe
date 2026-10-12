#include "container/container.hpp"
#include "container/container_error.hpp"
#include "container/revised_v3_container.hpp"
#include "container/recoverable_password_container.hpp"
#include "document/manual_save.hpp"
#include "document/provisional_save.hpp"
#include "format/revision_limits.hpp"
#include "format/snapshot_revision.hpp"
#include "format/text_validation.hpp"
#include "security/password_strength.hpp"

#include <algorithm>
#include <cstring>
#include <utility>

namespace scpefe::container {
namespace {

extern "C" int crypto_generichash(unsigned char *, std::size_t,
    const unsigned char *, unsigned long long, const unsigned char *, std::size_t);

std::array<std::uint8_t, 32> legacy_head(const UnlockedContainerData &data)
{
    if (data.encoded_snapshot_revision.empty())
        throw ContainerFailure{ContainerError::unsupported_format};
    std::array<std::uint8_t, 32> head{};
    if (crypto_generichash(head.data(), head.size(),
        data.encoded_snapshot_revision.data(), data.encoded_snapshot_revision.size(),
        nullptr, 0) != 0)
        throw ContainerFailure{ContainerError::crypto_error};
    return head;
}

std::string legacy_content(const UnlockedContainerData &data)
{
    if (data.encoded_snapshot_revision.empty()) return {};
    auto revision = format::SnapshotRevision::decode(
        data.encoded_snapshot_revision.data(), data.encoded_snapshot_revision.size(),
        format::RevisionLimits::defaults());
    return revision.data().content;
}

std::uint8_t permission_bits(const Permissions &permissions)
{
    return static_cast<std::uint8_t>((permissions.can_edit ? 1u : 0u)
        | (permissions.can_add_passwords ? 2u : 0u)
        | (permissions.can_remove_passwords ? 4u : 0u));
}

} // namespace

Container::Container(const ContainerStateManagerService &state_manager,
    const core::PasswordService &password, const core::EncryptionService &encryption,
    const core::PersistenceService &persistence, const core::HistoryService &history)
    : state_manager_(state_manager), password_(password), encryption_(encryption),
      persistence_(persistence), history_(history) {}

std::vector<std::uint8_t> Container::create_document(std::string_view profile_name,
    std::string_view profile_email, std::string_view device_name,
    std::string_view content, std::uint64_t timestamp_ms,
    const std::uint8_t *owner_password, std::size_t owner_password_size,
    const std::uint8_t *recovery_password, std::size_t recovery_password_size) const
{
    if (state_.access != Access::closed) throw StateError::invalid_transition;
    if (owner_password == nullptr || owner_password_size == 0
        || (recovery_password == nullptr && recovery_password_size != 0)
        || (recovery_password != nullptr && recovery_password_size == 0)
        || (recovery_password != nullptr && owner_password_size == recovery_password_size
            && std::memcmp(owner_password, recovery_password, owner_password_size) == 0))
        throw ContainerFailure{ContainerError::invalid_argument};
    if (password_.assess(owner_password, owner_password_size)
            != security::PasswordPolicyAssessment::accepted
        || (recovery_password && password_.assess(recovery_password,
            recovery_password_size) != security::PasswordPolicyAssessment::accepted))
        throw ContainerFailure{ContainerError::weak_password};
    return persistence_.create_revised_document(profile_name, profile_email,
        device_name, content, timestamp_ms, owner_password, owner_password_size,
        recovery_password, recovery_password_size, encryption_);
}

void Container::open_document(const std::uint8_t *bytes, std::size_t size)
{
    constexpr std::uint8_t obsolete_v2_magic[8]{'S', 'C', 'P', 'E', 'F', 'E', 0, 2};
    if (bytes && size >= sizeof(obsolete_v2_magic)
        && std::memcmp(bytes, obsolete_v2_magic, sizeof(obsolete_v2_magic)) == 0)
        throw ContainerFailure{ContainerError::unsupported_format};
    if (!persistence_.recognizes_revised_envelope(bytes, size)) {
        open_legacy_document(bytes, size);
        return;
    }
    if (state_.access != Access::closed) throw StateError::invalid_transition;
    persistence_.validate_revised_envelope(bytes, size);
    std::vector<std::uint8_t> incoming(bytes, bytes + size);
    committed_bytes_.swap(incoming);
    revised_v3_ = true;
    try {
        install_transition(Open{});
    } catch (...) {
        committed_bytes_.swap(incoming);
        revised_v3_ = false;
        throw;
    }
}

void Container::open_legacy_document(const std::uint8_t *bytes, std::size_t size)
{
    if (state_.access != Access::closed) throw StateError::invalid_transition;
    persistence_.validate_legacy_envelope(bytes, size);
    std::vector<std::uint8_t> incoming(bytes, bytes + size);
    committed_bytes_.swap(incoming);
    try {
        install_transition(Open{});
    } catch (...) {
        committed_bytes_.swap(incoming);
        throw;
    }
}

const UnlockedContainerData &Container::unlock_legacy_document(
    const std::uint8_t *password, std::size_t password_size)
{
    if (state_.access != Access::open || state_.screen != Screen::locked
        || committed_bytes_.empty()) throw StateError::invalid_transition;
    if (state_.attention == Attention::reauthenticate && target_bytes_.empty())
        throw StateError::invalid_transition;
    if (password == nullptr || password_size == 0)
        throw ContainerFailure{ContainerError::invalid_argument};
    const bool authenticating_target = !target_bytes_.empty();
    const auto &source = authenticating_target ? target_bytes_ : committed_bytes_;
    auto decoded = revised_v3_
        ? persistence_.unlock_revised_envelope(source.data(), source.size(),
            password, password_size, format::RevisionLimits::defaults())
        : persistence_.unlock_legacy_envelope(source.data(), source.size(),
            password, password_size, format::RevisionLimits::defaults());
    if (document_id_ && decoded.document_id != *document_id_)
        throw ContainerFailure{ContainerError::malformed_container};
    if (authenticating_target && state_.target_access
        && (decoded.slot_id != state_.target_access->slot_id
            || decoded.permissions != permission_bits(state_.target_access->permissions)))
        throw ContainerFailure{ContainerError::malformed_container};
    const Permissions rights{(decoded.permissions & 1u) != 0,
        (decoded.permissions & 2u) != 0, (decoded.permissions & 4u) != 0};
    const Unlock request{decoded.slot_id, rights, !decoded.must_be_changed,
        authenticating_target};
    // Reauthentication of the same slot restores access without replacing
    // submitted clear text with the older confirmed image.
    const bool retain_local_data = unlocked_.has_value()
        && decoded.slot_id == unlocked_->slot_id;
    if (!retain_local_data) {
        if (decoded.revision_graph) {
            const auto content = decoded.revision_graph->reconstruct(
                decoded.revision_graph->content_head());
            if (!content) throw ContainerFailure{ContainerError::malformed_container};
            content_clear_ = *content;
        } else {
            content_clear_ = legacy_content(decoded);
        }
        unlocked_.emplace(std::move(decoded));
    }
    try {
        install_transition(request);
    } catch (...) {
        if (!retain_local_data) { unlocked_.reset(); content_clear_.reset(); }
        throw;
    }
    document_id_ = unlocked_->document_id;
    return *unlocked_;
}

TransitionResult Container::apply_target_legacy_document(
    const std::uint8_t *target_bytes, std::size_t target_size,
    const std::uint8_t *password, std::size_t password_size)
{
    if (state_.access != Access::open || state_.screen != Screen::unlocked
        || state_.publication != PublicationPhase::idle || !state_.active_slot
        || !document_id_ || committed_bytes_.empty() || state_.target_access
        || !target_bytes_.empty())
        throw StateError::invalid_transition;
    if (password == nullptr || password_size == 0)
        throw ContainerFailure{ContainerError::invalid_argument};
    persistence_.validate_legacy_envelope(target_bytes, target_size);
    auto decoded = persistence_.unlock_legacy_envelope(target_bytes, target_size,
        password, password_size, format::RevisionLimits::defaults());
    if (decoded.document_id != *document_id_)
        throw ContainerFailure{ContainerError::malformed_container};
    const bool active_slot_matched = decoded.slot_id == *state_.active_slot;
    bool wrapper_changed = !active_slot_matched;
    if (active_slot_matched) {
        try {
            const auto current = persistence_.unlock_legacy_envelope(committed_bytes_.data(),
                committed_bytes_.size(), password, password_size,
                format::RevisionLimits::defaults());
            wrapper_changed = current.slot_id != decoded.slot_id;
        } catch (const ContainerFailure &failure) {
            if (failure.error != ContainerError::authentication_failed) throw;
            wrapper_changed = true;
        }
    }
    const Permissions rights{active_slot_matched && (decoded.permissions & 1u) != 0,
        active_slot_matched && (decoded.permissions & 2u) != 0,
        active_slot_matched && (decoded.permissions & 4u) != 0};
    std::vector<std::uint8_t> incoming(target_bytes, target_bytes + target_size);
    target_bytes_.swap(incoming);
    try {
        return install_transition(ApplyTargetPermissions{rights, wrapper_changed});
    } catch (...) {
        target_bytes_.swap(incoming);
        throw;
    }
}

std::vector<std::uint8_t> Container::compact_legacy_document(
    const std::uint8_t *password, std::size_t password_size,
    const std::array<std::uint8_t, 16> &lease_session_id,
    std::uint64_t heartbeat_counter) const
{
    if (state_.access != Access::open || state_.screen != Screen::unlocked
        || state_.edit != EditMode::editing || state_.lease != Lease::held
        || !state_.permissions.can_edit || !state_.permissions.can_add_passwords
        || !state_.permissions.can_remove_passwords
        || state_.attention != Attention::none
        || state_.publication != PublicationPhase::idle
        || committed_bytes_.empty()) throw StateError::invalid_transition;
    if (password == nullptr || password_size == 0)
        throw ContainerFailure{ContainerError::invalid_argument};
    return history_.compact_legacy_document(committed_bytes_.data(),
        committed_bytes_.size(), password, password_size,
        lease_session_id, heartbeat_counter);
}

bool Container::can_read_clear() const
{
    return state_.access == Access::open && state_.screen == Screen::unlocked
        && !requires_password_change();
}

bool Container::requires_password_change() const
{
    return state_.access == Access::open && state_.screen == Screen::unlocked
        && unlocked_ && unlocked_->must_be_changed;
}

const UnlockedContainerData *Container::read_unlocked() const
{
    return can_read_clear() && unlocked_ ? &*unlocked_ : nullptr;
}

const UnlockedContainerData *Container::read_authenticated_state() const
{
    return state_.access == Access::open && state_.screen == Screen::unlocked
        && unlocked_ ? &*unlocked_ : nullptr;
}

const std::string *Container::read_content_clear() const
{
    return can_read_clear() && content_clear_ ? &*content_clear_ : nullptr;
}

void Container::submit_content(std::string_view content)
{
    if (transitioning_ || state_.access != Access::open
        || state_.screen != Screen::unlocked || state_.edit != EditMode::editing
        || !state_.permissions.can_edit || state_.attention != Attention::none)
        throw StateError::invalid_transition;
    if (content.size() > format::RevisionLimits::defaults().max_text_bytes())
        throw ContainerFailure{ContainerError::limit_exceeded};
    if (!format::valid_canonical_document_text(content.data(), content.size()))
        throw ContainerFailure{ContainerError::invalid_argument};
    content_clear_ = std::string(content);
    ++content_generation_;
}

TransitionResult Container::confirm_edit_lease()
{
    if (requires_password_change()) throw StateError::invalid_transition;
    return install_transition(AcquireEdit{Lease::held});
}

TransitionResult Container::prepare_save(std::uint64_t operation_id, bool regular,
    bool discard, const std::uint8_t *password, std::size_t password_size,
    std::string_view profile_name, std::string_view profile_email,
    std::string_view device_name, std::uint64_t timestamp_ms)
{
    if (transitioning_ || candidate_ || !unlocked_ || !content_clear_
        || state_.access != Access::open || state_.screen != Screen::unlocked
        || state_.publication != PublicationPhase::idle
        || state_.edit != EditMode::editing || state_.lease != Lease::held
        || !state_.permissions.can_edit || state_.attention != Attention::none
        || state_.target_access)
        throw StateError::invalid_transition;
    if (operation_id <= state_.last_operation_id)
        throw StateError::stale_operation;
    if (unlocked_->must_be_changed)
        throw ContainerFailure{ContainerError::invalid_argument};
    if (!password || password_size == 0)
        throw ContainerFailure{ContainerError::invalid_argument};
    ContainerCandidate proposed;
    proposed.operation_id = operation_id;
    proposed.submitted_generation = content_generation_;
    proposed.discard = discard;
    if (revised_v3_) {
        const auto &graph = *unlocked_->revision_graph;
        const auto actor = std::find_if(graph.slots().begin(), graph.slots().end(),
            [&](const auto &slot) { return slot.id == unlocked_->slot_id; });
        if (actor == graph.slots().end() || actor->must_be_changed)
            throw ContainerFailure{ContainerError::invalid_argument};
        proposed.source_head = graph.head();
        auto encoded = graph.save_content(*content_clear_, profile_name,
            profile_email, device_name, *actor, timestamp_ms, regular, discard);
        proposed.bytes = persistence_.replace_revised_graph(committed_bytes_.data(),
            committed_bytes_.size(), password, password_size,
            encoded.data(), encoded.size());
        proposed.adopted_data = persistence_.unlock_revised_envelope(
            proposed.bytes.data(), proposed.bytes.size(), password, password_size,
            format::RevisionLimits::defaults());
        if (discard) {
            const auto content = proposed.adopted_data.revision_graph->reconstruct(
                proposed.adopted_data.revision_graph->content_head());
            if (!content) throw ContainerFailure{ContainerError::malformed_container};
            proposed.discarded_content = *content;
        }
    } else {
        proposed.source_head = legacy_head(*unlocked_);
        if (discard) {
            proposed.bytes = document::ProvisionalSave::discard(committed_bytes_.data(),
                committed_bytes_.size(), password, password_size);
        } else if (regular) {
            proposed.bytes = document::ProvisionalSave::create(committed_bytes_.data(),
                committed_bytes_.size(), password, password_size, profile_name,
                profile_email, device_name, *content_clear_, timestamp_ms);
        } else {
            proposed.bytes = document::ManualSave::create(committed_bytes_.data(),
                committed_bytes_.size(), password, password_size, profile_name,
                profile_email, device_name, *content_clear_, timestamp_ms);
        }
        proposed.adopted_data = persistence_.unlock_legacy_envelope(proposed.bytes.data(),
            proposed.bytes.size(), password, password_size,
            format::RevisionLimits::defaults());
        if (discard) proposed.discarded_content = legacy_content(proposed.adopted_data);
    }
    if (proposed.adopted_data.document_id != unlocked_->document_id
        || proposed.adopted_data.slot_id != unlocked_->slot_id)
        throw ContainerFailure{ContainerError::authentication_failed};
    candidate_.emplace(std::move(proposed));
    try {
        return install_transition(BeginPublication{operation_id, PublicationKind::save});
    } catch (...) {
        candidate_.reset();
        throw;
    }
}

TransitionResult Container::prepare_slot_change(std::uint64_t operation_id,
    const SlotChange &change, const std::uint8_t *actor_password,
    std::size_t actor_password_size, std::string_view client_name,
    std::string_view client_email, std::string_view device,
    std::uint64_t timestamp_ms)
{
    if (transitioning_ || candidate_ || !unlocked_
        || state_.access != Access::open || state_.screen != Screen::unlocked
        || state_.publication != PublicationPhase::idle
        || state_.attention != Attention::none || state_.target_access)
        throw StateError::invalid_transition;
    if (operation_id <= state_.last_operation_id)
        throw StateError::stale_operation;
    if (!actor_password || actor_password_size == 0)
        throw ContainerFailure{ContainerError::invalid_argument};
    const auto authenticated = revised_v3_
        ? persistence_.unlock_revised_envelope(committed_bytes_.data(),
            committed_bytes_.size(), actor_password, actor_password_size,
            format::RevisionLimits::defaults())
        : persistence_.unlock_legacy_envelope(committed_bytes_.data(),
            committed_bytes_.size(), actor_password, actor_password_size,
            format::RevisionLimits::defaults());
    if (authenticated.slot_id != unlocked_->slot_id)
        throw ContainerFailure{ContainerError::authentication_failed};
    if (!revised_v3_) {
        ContainerCandidate proposed;
        proposed.operation_id = operation_id;
        proposed.source_head = legacy_head(*unlocked_);
        proposed.submitted_generation = content_generation_;
        proposed.slot_change = true;
        const auto *bytes = committed_bytes_.data();
        const auto size = committed_bytes_.size();
        const auto permissions = change.permissions;
        switch (change.kind) {
        case SlotChangeKind::change_password:
            proposed.bytes = RecoverablePasswordContainer::change_password(bytes, size,
                actor_password, actor_password_size, change.new_password,
                change.new_password_size);
            break;
        case SlotChangeKind::add_invitation:
            proposed.bytes = RecoverablePasswordContainer::add_invitation(bytes, size,
                actor_password, actor_password_size, change.new_password,
                change.new_password_size, permissions, std::string(change.name));
            break;
        case SlotChangeKind::claim_invitation:
            proposed.bytes = RecoverablePasswordContainer::claim_invitation(bytes, size,
                actor_password, actor_password_size, change.new_password,
                change.new_password_size, std::string(change.name),
                std::string(change.email));
            break;
        case SlotChangeKind::reconcile_identity:
            proposed.bytes = RecoverablePasswordContainer::reconcile_identity(bytes, size,
                actor_password, actor_password_size, std::string(change.name),
                std::string(change.email));
            if (!content_clear_) throw StateError::invalid_transition;
            proposed.bytes = document::ManualSave::create(
                proposed.bytes.data(), proposed.bytes.size(), actor_password,
                actor_password_size, client_name, client_email, device,
                *content_clear_, timestamp_ms);
            break;
        case SlotChangeKind::update_permissions:
            proposed.bytes = RecoverablePasswordContainer::update_slot_permissions(
                bytes, size, actor_password, actor_password_size,
                change.target_id, permissions);
            break;
        case SlotChangeKind::remove_slot:
            proposed.bytes = RecoverablePasswordContainer::remove_slot(bytes, size,
                actor_password, actor_password_size, change.target_id);
            proposed.removes_active_slot = change.target_id == unlocked_->slot_id;
            break;
        }
        if (!proposed.removes_active_slot) {
            const bool changed_password = change.kind == SlotChangeKind::change_password
                || change.kind == SlotChangeKind::claim_invitation;
            proposed.adopted_data = persistence_.unlock_legacy_envelope(
                proposed.bytes.data(), proposed.bytes.size(),
                changed_password ? change.new_password : actor_password,
                changed_password ? change.new_password_size : actor_password_size,
                format::RevisionLimits::defaults());
            if (proposed.adopted_data.document_id != unlocked_->document_id
                || proposed.adopted_data.slot_id != unlocked_->slot_id)
                throw ContainerFailure{ContainerError::crypto_error};
        }
        candidate_.emplace(std::move(proposed));
        try {
            return install_transition(BeginPublication{operation_id,
                PublicationKind::slot_change});
        } catch (...) {
            candidate_.reset();
            throw;
        }
    }
    const auto &graph = *unlocked_->revision_graph;
    if (graph.records().back().provisional)
        throw StateError::invalid_transition;
    PasswordSlots slots(graph, *unlocked_, password_, encryption_,
        committed_bytes_.data(), committed_bytes_.size());
    const auto mutation = slots.apply(change);
    if (mutation.remove_active && content_clear_) {
        const auto committed_content = graph.reconstruct(graph.content_head());
        if (!committed_content || *content_clear_ != *committed_content)
            throw StateError::invalid_transition;
    }
    const auto actor = std::find_if(graph.slots().begin(), graph.slots().end(),
        [&](const auto &slot) { return slot.id == unlocked_->slot_id; });
    if (actor == graph.slots().end())
        throw ContainerFailure{ContainerError::malformed_container};
    auto event_actor = *actor;
    if (change.kind == SlotChangeKind::claim_invitation
        || change.kind == SlotChangeKind::reconcile_identity) {
        event_actor.name = change.name;
        event_actor.email = change.email;
    }
    ContainerCandidate proposed;
    proposed.operation_id = operation_id;
    proposed.source_head = graph.head();
    proposed.submitted_generation = content_generation_;
    proposed.removes_active_slot = mutation.remove_active;
    proposed.slot_change = true;
    const auto encoded = graph.append_slot_event(mutation.slots, event_actor,
        mutation.affected_id, mutation.event_type, mutation.event_detail,
        client_name, client_email, device, timestamp_ms);
    const auto &wrapper_slot = mutation.wrapper_mode == 3
        ? *actor : mutation.slots[mutation.wrapper_index];
    proposed.bytes = RevisedV3Container::replace_slots(
        committed_bytes_.data(), committed_bytes_.size(), actor_password,
        actor_password_size, encoded.data(), encoded.size(),
        mutation.wrapper_mode, mutation.wrapper_index, change.new_password,
        change.new_password_size, wrapper_slot.id, wrapper_slot.permissions,
        wrapper_slot.must_be_changed);
    if (!mutation.remove_active) {
        const bool changed_password = mutation.wrapper_mode == 2;
        const auto *candidate_password = changed_password
            ? change.new_password : actor_password;
        const auto candidate_password_size = changed_password
            ? change.new_password_size : actor_password_size;
        proposed.adopted_data = persistence_.unlock_revised_envelope(
            proposed.bytes.data(), proposed.bytes.size(), candidate_password,
            candidate_password_size, format::RevisionLimits::defaults());
        if (proposed.adopted_data.document_id != unlocked_->document_id
            || proposed.adopted_data.slot_id != unlocked_->slot_id)
            throw ContainerFailure{ContainerError::crypto_error};
    }
    candidate_.emplace(std::move(proposed));
    try {
        return install_transition(BeginPublication{operation_id,
            PublicationKind::slot_change});
    } catch (...) {
        candidate_.reset();
        throw;
    }
}

TransitionResult Container::acknowledge_save(std::uint64_t operation_id,
    PublicationOutcome outcome)
{
    if (!candidate_ || candidate_->operation_id != operation_id)
        throw StateError::stale_operation;
    return install_transition(AcknowledgePublication{operation_id, outcome});
}

TransitionResult Container::resolve_save(std::uint64_t operation_id, bool published)
{
    if (!candidate_ || candidate_->operation_id != operation_id)
        throw StateError::stale_operation;
    return install_transition(ResolveAmbiguity{operation_id, published});
}

TransitionResult Container::transition(const StateTransition &attempt)
{
    if (!std::holds_alternative<Lock>(attempt)
        && !std::holds_alternative<Close>(attempt)
        && !std::holds_alternative<ReleaseEdit>(attempt)
        && !std::holds_alternative<RaiseAttention>(attempt))
        throw StateError::invalid_transition;
    return install_transition(attempt);
}

TransitionResult Container::install_transition(const StateTransition &attempt)
{
    if (transitioning_) throw StateError::invalid_transition;
    auto result = state_manager_.apply(state_, attempt);
    if (result.state == state_) return result;
    const auto before = state_;
    transitioning_ = true;
    state_ = result.state;
    const auto *ack = std::get_if<AcknowledgePublication>(&attempt);
    const auto *resolution = std::get_if<ResolveAmbiguity>(&attempt);
    const bool verified = (ack && ack->outcome == PublicationOutcome::verified)
        || (resolution && resolution->published);
    const bool rejected = (ack && ack->outcome == PublicationOutcome::definite_failure)
        || (resolution && !resolution->published);
    if (candidate_ && verified) {
        const bool remove_active = candidate_->removes_active_slot;
        const bool slot_change = candidate_->slot_change;
        committed_bytes_.swap(candidate_->bytes);
        if (remove_active) unlocked_.reset();
        else unlocked_ = std::move(candidate_->adopted_data);
        if (candidate_->discard && content_generation_ == candidate_->submitted_generation)
            content_clear_ = std::move(candidate_->discarded_content);
        candidate_.reset();
        if (remove_active) {
            auto locked = state_manager_.apply(state_, Lock{});
            state_ = locked.state;
            result.state = state_;
            result.effects.insert(result.effects.end(), locked.effects.begin(),
                locked.effects.end());
        } else if (slot_change) {
            const Permissions rights{(unlocked_->permissions & 1u) != 0,
                (unlocked_->permissions & 2u) != 0,
                (unlocked_->permissions & 4u) != 0};
            auto refreshed = state_manager_.apply(state_,
                AuthenticatedSlotPermissions{rights, !unlocked_->must_be_changed});
            state_ = refreshed.state;
            result.state = state_;
            result.effects.insert(result.effects.end(), refreshed.effects.begin(),
                refreshed.effects.end());
        }
    } else if (candidate_ && rejected) {
        candidate_.reset();
    }
    if (unlocked_ && (std::holds_alternative<Unlock>(attempt)
        || std::holds_alternative<ApplyTargetPermissions>(attempt)))
        unlocked_->permissions = permission_bits(state_.permissions);
    if (std::holds_alternative<Close>(attempt)) {
        unlocked_.reset();
        content_clear_.reset();
        candidate_.reset();
        committed_bytes_.clear();
        target_bytes_.clear();
        document_id_.reset();
        revised_v3_ = false;
    }
    const auto operation_id = state_.operation_id.value_or(before.operation_id.value_or(0));
    for (auto *observer : observers_)
        observer->on_state_changed(before, state_, operation_id);
    transitioning_ = false;
    return result;
}

bool Container::try_transition(const StateTransition &attempt)
{
    try {
        transition(attempt);
        return true;
    } catch (StateError) {
        return false;
    }
}

void Container::subscribe(ContainerStateObserver &observer)
{
    if (std::find(observers_.begin(), observers_.end(), &observer) == observers_.end())
        observers_.push_back(&observer);
}

void Container::unsubscribe(ContainerStateObserver &observer)
{
    observers_.erase(std::remove(observers_.begin(), observers_.end(), &observer),
        observers_.end());
}

} // namespace scpefe::container
