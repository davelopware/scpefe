#include "container/container.hpp"
#include "container/container_error.hpp"
#include "container/revised_v3_container.hpp"
#include "document/merge_save.hpp"
#include "format/revision_limits.hpp"
#include "format/text_validation.hpp"
#include "security/password_strength.hpp"

#include <algorithm>
#include <cstring>
#include <utility>

namespace scpefe::container {
namespace {

std::uint8_t permission_bits(const Permissions &permissions)
{
    return static_cast<std::uint8_t>((permissions.can_edit ? 1u : 0u)
        | (permissions.can_add_passwords ? 2u : 0u)
        | (permissions.can_remove_passwords ? 4u : 0u));
}

std::string revision_hex(const std::array<std::uint8_t, 32> &id)
{
    constexpr char digits[] = "0123456789abcdef";
    std::string result;
    result.reserve(id.size() * 2);
    for (const auto byte : id) {
        result.push_back(digits[byte >> 4]);
        result.push_back(digits[byte & 15]);
    }
    return result;
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
    if (state_.access != Access::closed) throw StateError::invalid_transition;
    persistence_.validate_revised_envelope(bytes, size);
    std::vector<std::uint8_t> incoming(bytes, bytes + size);
    committed_bytes_.swap(incoming);
    try {
        install_transition(Open{});
    } catch (...) {
        committed_bytes_.swap(incoming);
        throw;
    }
}

const UnlockedContainerData &Container::unlock_document(
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
    auto decoded = persistence_.unlock_revised_envelope(source.data(), source.size(),
        password, password_size, format::RevisionLimits::defaults());
    if (document_id_ && decoded.document_id != *document_id_)
        throw ContainerFailure{ContainerError::malformed_container};
    if (authenticating_target && state_.target_access
        && (decoded.slot_id != state_.target_access->slot_id
            || decoded.permissions != permission_bits(state_.target_access->permissions)))
        throw ContainerFailure{ContainerError::malformed_container};
    const Permissions rights{(decoded.permissions & 1u) != 0,
        (decoded.permissions & 2u) != 0, (decoded.permissions & 4u) != 0};
    const auto authenticated_lease = !decoded.editing_lease.active ? Lease::none
        : local_lease_session_ && decoded.editing_lease.session_id == *local_lease_session_
            ? Lease::held : Lease::other_holder;
    const Unlock request{decoded.slot_id, rights, !decoded.must_be_changed,
        authenticating_target, authenticated_lease};
    // Reauthentication of the same slot restores access without replacing
    // submitted clear text with the older confirmed image.
    const bool retain_local_data = unlocked_.has_value()
        && decoded.slot_id == unlocked_->slot_id;
    if (!retain_local_data) {
        const auto content = decoded.revision_graph->reconstruct(
            decoded.revision_graph->content_head());
        if (!content) throw ContainerFailure{ContainerError::malformed_container};
        content_clear_ = *content;
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

TransitionResult Container::apply_target_document(
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
    persistence_.validate_revised_envelope(target_bytes, target_size);
    auto decoded = persistence_.unlock_revised_envelope(target_bytes, target_size,
        password, password_size, format::RevisionLimits::defaults());
    if (decoded.document_id != *document_id_) {
        throw format::MergeFailure{format::MergeProblem::unrelated_target};
    }
    if (unlocked_ && decoded.work_journal_key != unlocked_->work_journal_key)
        throw format::MergeFailure{format::MergeProblem::unrelated_target};
    if (unlocked_)
        (void)unlocked_->revision_graph->assess_target(*decoded.revision_graph);
    const bool active_slot_matched = decoded.slot_id == *state_.active_slot;
    bool wrapper_changed = !active_slot_matched;
    if (active_slot_matched) {
        try {
            const auto current = persistence_.unlock_revised_envelope(
                committed_bytes_.data(), committed_bytes_.size(), password,
                password_size, format::RevisionLimits::defaults());
            wrapper_changed = current.slot_id != decoded.slot_id;
        } catch (const ContainerFailure &failure) {
            if (failure.error != ContainerError::authentication_failed) throw;
            wrapper_changed = true;
        }
    }
    if (active_slot_matched && unlocked_) {
        const auto slot_index = [&](const format::RevisionGraph &graph) {
            const auto &slots = graph.slots();
            const auto found = std::find_if(slots.begin(), slots.end(),
                [&](const auto &slot) { return slot.id == *state_.active_slot; });
            return static_cast<std::size_t>(found - slots.begin());
        };
        const auto local_index = slot_index(*unlocked_->revision_graph);
        const auto target_index = slot_index(*decoded.revision_graph);
        if (local_index >= unlocked_->revision_graph->slots().size()
            || target_index >= decoded.revision_graph->slots().size())
            wrapper_changed = true;
        else if (std::memcmp(committed_bytes_.data() + 72 + 110 * local_index,
            target_bytes + 72 + 110 * target_index, 110) != 0)
            wrapper_changed = true;
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
        || !state_.permissions.can_edit || state_.attention != Attention::none
        || pending_activity_ || (candidate_ && candidate_->activity_backup))
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

LeaseEntry Container::advise_lease_entry(
    const std::array<std::uint8_t, 16> &suspended_session,
    std::uint64_t suspended_counter, std::uint64_t now_utc_ms,
    std::uint64_t unchanged_monotonic_ms) const
{
    if (!unlocked_ || state_.access != Access::open
        || state_.screen != Screen::unlocked || state_.publication != PublicationPhase::idle
        || state_.attention != Attention::none || !state_.permissions.can_edit
        || state_.edit != EditMode::read_only
        || unlocked_->must_be_changed)
        throw StateError::invalid_transition;
    const auto &lease = unlocked_->editing_lease;
    if (!lease.active) return LeaseEntry::acquire;
    const bool local = local_lease_session_
        && *local_lease_session_ == suspended_session
        && lease.session_id == suspended_session;
    if (local && lease.heartbeat_counter != suspended_counter)
        return LeaseEntry::changed;
    const bool clock_advanced = now_utc_ms >= lease.holder_utc_ms;
    const auto age = clock_advanced ? now_utc_ms - lease.holder_utc_ms : 0;
    if (local && clock_advanced && age < lease.duration_ms)
        return LeaseEntry::resume;
    if ((clock_advanced && age >= lease.duration_ms)
        || unchanged_monotonic_ms >= lease.duration_ms)
        return LeaseEntry::takeover;
    if (!clock_advanced || unlocked_->owner_slot || unlocked_->recovery_slot)
        return LeaseEntry::confirm_takeover;
    return LeaseEntry::blocked;
}

TransitionResult Container::prepare_lease_change(std::uint64_t operation_id,
    const LeaseChange &change, const std::uint8_t *password,
    std::size_t password_size)
{
    if (transitioning_ || candidate_ || !unlocked_
        || state_.access != Access::open
        || (state_.screen != Screen::unlocked
            && !(state_.screen == Screen::locked
                && change.action == LeaseAction::release))
        || state_.publication != PublicationPhase::idle
        || state_.attention != Attention::none || state_.target_access
        || (state_.screen == Screen::unlocked && !state_.permissions.can_edit)
        || !(unlocked_->permissions & 1u) || unlocked_->must_be_changed)
        throw StateError::invalid_transition;
    if (operation_id <= state_.last_operation_id)
        throw StateError::stale_operation;
    if (!password || password_size == 0 || change.session_id == SlotId{}
        || change.duration_ms == 0 || change.duration_ms > INT64_MAX)
        throw ContainerFailure{ContainerError::invalid_argument};
    const auto authenticated = persistence_.unlock_revised_envelope(
        committed_bytes_.data(), committed_bytes_.size(), password, password_size,
        format::RevisionLimits::defaults());
    if (authenticated.slot_id != unlocked_->slot_id)
        throw ContainerFailure{ContainerError::authentication_failed};
    const auto &prior = authenticated.editing_lease;
    if (prior.active != change.expected_active
        || prior.session_id != change.expected_session_id
        || prior.heartbeat_counter != change.expected_counter
        || prior.holder_utc_ms != change.expected_holder_utc_ms
        || prior.duration_ms != change.expected_duration_ms)
        throw StateError::stale_operation;
    const bool same = prior.active && prior.session_id == change.session_id;
    const bool local = local_lease_session_ && *local_lease_session_ == change.session_id;
    switch (change.action) {
    case LeaseAction::acquire:
        if (prior.active) throw StateError::invalid_transition;
        break;
    case LeaseAction::refresh:
        if (!same || !local || state_.edit != EditMode::editing)
            throw StateError::invalid_transition;
        break;
    case LeaseAction::resume:
        if (!same || !local || state_.edit != EditMode::read_only)
            throw StateError::invalid_transition;
        break;
    case LeaseAction::release:
        if (!same || !local) throw StateError::invalid_transition;
        break;
    case LeaseAction::takeover: {
        if (!prior.active || same || !change.explicit_takeover)
            throw StateError::invalid_transition;
        const bool expired = change.now_utc_ms >= prior.holder_utc_ms
            && change.now_utc_ms - prior.holder_utc_ms >= prior.duration_ms;
        const bool observed_stale = change.unchanged_monotonic_ms >= prior.duration_ms;
        if (!expired && !observed_stale
            && !(authenticated.owner_slot || authenticated.recovery_slot))
            throw StateError::invalid_transition;
        break;
    }
    }
    if (change.now_utc_ms > INT64_MAX
        || (change.action != LeaseAction::release
            && (change.holder_name.empty() || change.holder_email.empty()
                || change.device_name.empty())))
        throw ContainerFailure{ContainerError::invalid_argument};
    EditingLeaseData next;
    next.active = change.action != LeaseAction::release;
    next.session_id = next.active ? change.session_id : SlotId{};
    if (prior.heartbeat_counter == UINT64_MAX)
        throw ContainerFailure{ContainerError::limit_exceeded};
    next.heartbeat_counter = same ? prior.heartbeat_counter + 1 : 1;
    next.holder_utc_ms = change.now_utc_ms;
    next.duration_ms = change.duration_ms;
    if (next.active) {
        next.holder_name = change.holder_name;
        next.holder_email = change.holder_email;
        next.device_name = change.device_name;
    }
    ContainerCandidate proposed;
    proposed.operation_id = operation_id;
    proposed.submitted_generation = content_generation_;
    proposed.lease_change = true;
    proposed.lease_held_after = next.active;
    proposed.lease_session_after = change.session_id;
        const auto &graph = *authenticated.revision_graph;
        proposed.source_head = graph.head();
        format::RevisionLease lease;
        lease.active = next.active;
        lease.session_id = next.session_id;
        lease.heartbeat_counter = next.heartbeat_counter;
        lease.holder_utc_ms = next.holder_utc_ms;
        lease.duration_ms = next.duration_ms;
        lease.holder_name = next.holder_name;
        lease.holder_email = next.holder_email;
        lease.device = next.device_name;
        const auto encoded = graph.replace_lease(lease);
        proposed.bytes = persistence_.replace_revised_graph(committed_bytes_.data(),
            committed_bytes_.size(), password, password_size,
            encoded.data(), encoded.size());
        proposed.adopted_data = persistence_.unlock_revised_envelope(
            proposed.bytes.data(), proposed.bytes.size(), password, password_size,
            format::RevisionLimits::defaults());
        if (proposed.adopted_data.revision_graph->head() != graph.head())
            throw ContainerFailure{ContainerError::crypto_error};
    if (proposed.adopted_data.document_id != unlocked_->document_id
        || proposed.adopted_data.slot_id != unlocked_->slot_id)
        throw ContainerFailure{ContainerError::authentication_failed};
    candidate_.emplace(std::move(proposed));
    try {
        return install_transition(BeginPublication{operation_id,
            PublicationKind::lease_change});
    } catch (...) {
        candidate_.reset();
        throw;
    }
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

void Container::assess_merge(const std::uint8_t *local_bytes, std::size_t local_size,
    const std::uint8_t *target_password, std::size_t target_password_size,
    const std::uint8_t *local_password, std::size_t local_password_size,
    std::string_view profile_name, std::string_view profile_email,
    std::string_view device_name, std::string_view resolved_content,
    std::uint64_t timestamp_ms) const
{
    if (state_.access != Access::open
        || state_.screen != Screen::unlocked || committed_bytes_.empty())
        throw StateError::invalid_transition;
    if (!local_bytes || local_size == 0 || !target_password
        || target_password_size == 0 || !local_password || local_password_size == 0)
        throw ContainerFailure{ContainerError::invalid_argument};
    (void)document::MergeSave::create_revised(
        committed_bytes_.data(), committed_bytes_.size(), local_bytes, local_size,
        target_password, target_password_size, local_password, local_password_size,
        profile_name, profile_email, device_name, resolved_content, timestamp_ms);
}

TransitionResult Container::prepare_merge(std::uint64_t operation_id,
    const std::uint8_t *local_bytes, std::size_t local_size,
    const std::uint8_t *target_password, std::size_t target_password_size,
    const std::uint8_t *local_password, std::size_t local_password_size,
    std::string_view profile_name, std::string_view profile_email,
    std::string_view device_name, std::string_view resolved_content,
    std::uint64_t timestamp_ms)
{
    if (transitioning_ || candidate_ || !unlocked_
        || !unlocked_->revision_graph || state_.access != Access::open
        || state_.screen != Screen::unlocked
        || state_.publication != PublicationPhase::idle
        || state_.edit != EditMode::editing || state_.lease != Lease::held
        || !state_.permissions.can_edit || state_.attention != Attention::none
        || state_.target_access)
        throw StateError::invalid_transition;
    if (operation_id <= state_.last_operation_id)
        throw StateError::stale_operation;
    if (!local_bytes || local_size == 0 || !target_password
        || target_password_size == 0 || !local_password || local_password_size == 0)
        throw ContainerFailure{ContainerError::invalid_argument};
    submit_content(resolved_content);
    ContainerCandidate proposed;
    proposed.operation_id = operation_id;
    proposed.source_head = unlocked_->revision_graph->head();
    proposed.submitted_generation = content_generation_;
    proposed.bytes = document::MergeSave::create_revised(
        committed_bytes_.data(), committed_bytes_.size(), local_bytes, local_size,
        target_password, target_password_size, local_password, local_password_size,
        profile_name, profile_email, device_name, resolved_content, timestamp_ms);
    proposed.adopted_data = persistence_.unlock_revised_envelope(
        proposed.bytes.data(), proposed.bytes.size(), target_password,
        target_password_size, format::RevisionLimits::defaults());
    if (proposed.adopted_data.document_id != unlocked_->document_id
        || proposed.adopted_data.slot_id != unlocked_->slot_id)
        throw ContainerFailure{ContainerError::authentication_failed};
    candidate_.emplace(std::move(proposed));
    try {
        return install_transition(BeginPublication{operation_id,
            PublicationKind::save});
    } catch (...) {
        candidate_.reset();
        throw;
    }
}

TransitionResult Container::prepare_compaction(std::uint64_t operation_id,
    const std::uint8_t *password, std::size_t password_size,
    const std::array<std::uint8_t, 16> &lease_session_id,
    std::uint64_t lease_heartbeat_counter, bool explicit_decision,
    bool clean_state_confirmed, const std::uint8_t *verified_backup,
    std::size_t verified_backup_size, std::size_t retain_deltas,
    std::string_view client_name, std::string_view client_email,
    std::string_view device, std::uint64_t timestamp_ms)
{
    if (transitioning_ || candidate_ || !unlocked_ || !content_clear_
        || !unlocked_->revision_graph
        || state_.access != Access::open || state_.screen != Screen::unlocked
        || state_.publication != PublicationPhase::idle
        || state_.edit != EditMode::editing || state_.lease != Lease::held
        || !state_.permissions.can_edit || !state_.permissions.can_add_passwords
        || !state_.permissions.can_remove_passwords
        || state_.attention != Attention::none || state_.target_access
        || !target_bytes_.empty()) throw StateError::invalid_transition;
    if (operation_id <= state_.last_operation_id)
        throw StateError::stale_operation;
    if (!explicit_decision || !clean_state_confirmed || !password || !password_size
        || !verified_backup || verified_backup_size != committed_bytes_.size()
        || std::memcmp(verified_backup, committed_bytes_.data(), verified_backup_size) != 0
        || !local_lease_session_ || *local_lease_session_ != lease_session_id)
        throw ContainerFailure{ContainerError::invalid_argument};
    const auto authenticated = persistence_.unlock_revised_envelope(
        committed_bytes_.data(), committed_bytes_.size(), password, password_size,
        format::RevisionLimits::defaults());
    const auto &graph = *authenticated.revision_graph;
    const auto &lease = graph.lease();
    const auto actor = std::find_if(graph.slots().begin(), graph.slots().end(),
        [&](const auto &slot) { return slot.id == authenticated.slot_id; });
    const auto current = graph.reconstruct(graph.content_head());
    if (authenticated.slot_id != unlocked_->slot_id
        || authenticated.document_id != unlocked_->document_id
        || actor == graph.slots().end() || (actor->permissions & 7u) != 7u
        || actor->must_be_changed || graph.records().back().provisional
        || !current || *current != *content_clear_
        || !lease.active || lease.session_id != lease_session_id
        || lease.heartbeat_counter != lease_heartbeat_counter)
        throw ContainerFailure{ContainerError::invalid_argument};

    ContainerCandidate proposed;
    proposed.operation_id = operation_id;
    proposed.source_head = graph.head();
    proposed.submitted_generation = content_generation_;
    const auto encoded = history_.compact_graph(graph, retain_deltas, *actor,
        client_name, client_email, device, timestamp_ms);
    proposed.bytes = persistence_.replace_revised_graph(committed_bytes_.data(),
        committed_bytes_.size(), password, password_size,
        encoded.data(), encoded.size());
    proposed.adopted_data = persistence_.unlock_revised_envelope(
        proposed.bytes.data(), proposed.bytes.size(), password, password_size,
        format::RevisionLimits::defaults());
    if (proposed.adopted_data.document_id != unlocked_->document_id
        || proposed.adopted_data.slot_id != unlocked_->slot_id)
        throw ContainerFailure{ContainerError::authentication_failed};
    candidate_.emplace(std::move(proposed));
    try {
        return install_transition(BeginPublication{operation_id,
            PublicationKind::compaction});
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
    const auto authenticated = persistence_.unlock_revised_envelope(
        committed_bytes_.data(), committed_bytes_.size(), actor_password,
        actor_password_size, format::RevisionLimits::defaults());
    if (authenticated.slot_id != unlocked_->slot_id)
        throw ContainerFailure{ContainerError::authentication_failed};
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

TransitionResult Container::prepare_activity_attempt(std::uint64_t operation_id,
    bool backup, bool clean_state_confirmed,
    const std::uint8_t *observed_target, std::size_t observed_size,
    const std::uint8_t *password, std::size_t password_size,
    std::string_view client_name, std::string_view client_email,
    std::string_view device, std::uint64_t timestamp_ms)
{
    if (transitioning_ || candidate_ || pending_activity_ || !unlocked_
        || !content_clear_ || !unlocked_->revision_graph
        || state_.access != Access::open || state_.screen != Screen::unlocked
        || state_.publication != PublicationPhase::idle
        || state_.attention != Attention::none || state_.target_access
        || unlocked_->must_be_changed)
        throw StateError::invalid_transition;
    if (operation_id <= state_.last_operation_id)
        throw StateError::stale_operation;
    if (!password || password_size == 0 || !observed_target || observed_size == 0)
        throw ContainerFailure{ContainerError::invalid_argument};
    if (observed_size != committed_bytes_.size()
        || std::memcmp(observed_target, committed_bytes_.data(), observed_size) != 0)
        throw StateError::invalid_transition;
    const auto &graph = *unlocked_->revision_graph;
    if (graph.records().back().provisional)
        throw StateError::invalid_transition;
    if (backup) {
        const auto committed = graph.reconstruct(graph.content_head());
        if (!clean_state_confirmed || !committed || *content_clear_ != *committed)
            throw StateError::invalid_transition;
    }
    const auto authenticated = persistence_.unlock_revised_envelope(
        committed_bytes_.data(), committed_bytes_.size(), password,
        password_size, format::RevisionLimits::defaults());
    if (authenticated.slot_id != unlocked_->slot_id)
        throw ContainerFailure{ContainerError::authentication_failed};
    const auto actor = std::find_if(graph.slots().begin(), graph.slots().end(),
        [&](const auto &slot) { return slot.id == unlocked_->slot_id; });
    if (actor == graph.slots().end() || actor->must_be_changed)
        throw StateError::invalid_transition;
    ContainerCandidate proposed;
    proposed.operation_id = operation_id;
    proposed.source_head = graph.head();
    proposed.submitted_generation = content_generation_;
    proposed.activity_backup = backup;
    const auto encoded = graph.append_activity_event(*actor,
        backup ? "backup-attempted" : "export-attempted", {}, 0,
        client_name, client_email, device, timestamp_ms);
    proposed.bytes = persistence_.replace_revised_graph(committed_bytes_.data(),
        committed_bytes_.size(), password, password_size,
        encoded.data(), encoded.size());
    proposed.adopted_data = persistence_.unlock_revised_envelope(
        proposed.bytes.data(), proposed.bytes.size(), password, password_size,
        format::RevisionLimits::defaults());
    if (proposed.adopted_data.document_id != unlocked_->document_id
        || proposed.adopted_data.slot_id != unlocked_->slot_id)
        throw ContainerFailure{ContainerError::authentication_failed};
    candidate_.emplace(std::move(proposed));
    try {
        return install_transition(BeginPublication{operation_id,
            backup ? PublicationKind::backup_attempt
                : PublicationKind::export_attempt});
    } catch (...) {
        candidate_.reset();
        throw;
    }
}

TransitionResult Container::complete_activity(
    std::uint64_t attempt_operation_id, bool succeeded)
{
    if (!pending_activity_ || pending_activity_->attempt_operation_id
        != attempt_operation_id || pending_activity_->succeeded.has_value())
        throw StateError::stale_operation;
    const auto result = install_transition(CompleteHostAction{
        attempt_operation_id, succeeded});
    pending_activity_->succeeded = succeeded;
    return result;
}

TransitionResult Container::restore_activity_outcome(
    std::uint64_t attempt_operation_id,
    const std::array<std::uint8_t, 32> &attempt_head,
    bool backup, bool succeeded,
    const std::uint8_t *observed_target, std::size_t observed_size)
{
    if (transitioning_ || candidate_ || pending_activity_ || !unlocked_
        || !unlocked_->revision_graph
        || state_.access != Access::open || state_.screen != Screen::unlocked
        || state_.publication != PublicationPhase::idle
        || state_.attention != Attention::none || state_.target_access
        || unlocked_->must_be_changed)
        throw StateError::invalid_transition;
    if (!observed_target || observed_size == 0)
        throw ContainerFailure{ContainerError::invalid_argument};
    if (observed_size != committed_bytes_.size()
        || std::memcmp(observed_target, committed_bytes_.data(), observed_size) != 0)
        throw StateError::invalid_transition;
    const auto &graph = *unlocked_->revision_graph;
    const auto &record = graph.records().back();
    if (graph.head() != attempt_head || record.kind != 2
        || record.actor_slot != unlocked_->slot_id
        || record.event_type != (backup ? "backup-attempted" : "export-attempted"))
        throw StateError::invalid_transition;
    const auto result = install_transition(RestorePendingActivity{
        attempt_operation_id, backup ? PublicationKind::backup_attempt
            : PublicationKind::export_attempt});
    pending_activity_ = PendingActivity{attempt_operation_id,
        attempt_head, backup, succeeded};
    return result;
}

TransitionResult Container::prepare_activity_outcome(std::uint64_t operation_id,
    const std::uint8_t *observed_target, std::size_t observed_size,
    const std::uint8_t *password, std::size_t password_size,
    std::string_view client_name, std::string_view client_email,
    std::string_view device, std::uint64_t timestamp_ms)
{
    if (transitioning_ || candidate_ || !pending_activity_
        || !pending_activity_->succeeded.has_value() || !unlocked_
        || state_.screen != Screen::unlocked
        || state_.publication != PublicationPhase::outcome_pending
        || state_.attention != Attention::none || state_.target_access)
        throw StateError::invalid_transition;
    if (operation_id <= state_.last_operation_id)
        throw StateError::stale_operation;
    if (!password || password_size == 0 || !observed_target || observed_size == 0)
        throw ContainerFailure{ContainerError::invalid_argument};
    if (observed_size != committed_bytes_.size()
        || std::memcmp(observed_target, committed_bytes_.data(), observed_size) != 0)
        throw StateError::invalid_transition;
    const auto &graph = *unlocked_->revision_graph;
    if (graph.head() != pending_activity_->attempt_head)
        throw StateError::invalid_transition;
    const auto authenticated = persistence_.unlock_revised_envelope(
        committed_bytes_.data(), committed_bytes_.size(), password,
        password_size, format::RevisionLimits::defaults());
    if (authenticated.slot_id != unlocked_->slot_id)
        throw ContainerFailure{ContainerError::authentication_failed};
    const auto actor = std::find_if(graph.slots().begin(), graph.slots().end(),
        [&](const auto &slot) { return slot.id == unlocked_->slot_id; });
    if (actor == graph.slots().end() || actor->must_be_changed)
        throw StateError::invalid_transition;
    const bool backup = pending_activity_->backup;
    const bool succeeded = *pending_activity_->succeeded;
    ContainerCandidate proposed;
    proposed.operation_id = operation_id;
    proposed.source_head = graph.head();
    proposed.submitted_generation = content_generation_;
    const auto detail = "attempt=" + revision_hex(pending_activity_->attempt_head);
    const auto encoded = graph.append_activity_event(*actor,
        backup ? (succeeded ? "backup-succeeded" : "backup-failed")
            : (succeeded ? "export-succeeded" : "export-failed"),
        detail, succeeded ? 1 : 2, client_name, client_email, device, timestamp_ms);
    proposed.bytes = persistence_.replace_revised_graph(committed_bytes_.data(),
        committed_bytes_.size(), password, password_size,
        encoded.data(), encoded.size());
    proposed.adopted_data = persistence_.unlock_revised_envelope(
        proposed.bytes.data(), proposed.bytes.size(), password,
        password_size, format::RevisionLimits::defaults());
    if (proposed.adopted_data.document_id != unlocked_->document_id
        || proposed.adopted_data.slot_id != unlocked_->slot_id)
        throw ContainerFailure{ContainerError::authentication_failed};
    candidate_.emplace(std::move(proposed));
    try {
        return install_transition(BeginPublication{operation_id,
            PublicationKind::activity_outcome});
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
        const bool lease_change = candidate_->lease_change;
        const bool lease_held_after = candidate_->lease_held_after;
        const auto lease_session_after = candidate_->lease_session_after;
        const auto activity_backup = candidate_->activity_backup;
        committed_bytes_.swap(candidate_->bytes);
        if (remove_active) unlocked_.reset();
        else unlocked_ = std::move(candidate_->adopted_data);
        if (candidate_->discard && content_generation_ == candidate_->submitted_generation)
            content_clear_ = std::move(candidate_->discarded_content);
        candidate_.reset();
        if (activity_backup) {
            pending_activity_ = PendingActivity{before.operation_id.value_or(0),
                unlocked_->revision_graph->head(), *activity_backup, std::nullopt};
        } else if (before.publication_kind == PublicationKind::activity_outcome) {
            pending_activity_.reset();
        }
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
        } else if (lease_change) {
            if (lease_held_after) local_lease_session_ = lease_session_after;
            else local_lease_session_.reset();
            auto refreshed = state_manager_.apply(state_, PublishedLease{lease_held_after});
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
        pending_activity_.reset();
        committed_bytes_.clear();
        target_bytes_.clear();
        document_id_.reset();
        local_lease_session_.reset();
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
