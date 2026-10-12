#include "core/context.hpp"
#include "core/service_registry.hpp"
#include "container/container.hpp"
#include "container/container_error.hpp"
#include "container/recoverable_password_container.hpp"
#include "container/revised_v3_container.hpp"
#include "document/new_document.hpp"
#include "scpefe/scpefe.h"
#include "format/snapshot_revision.hpp"

#include <cassert>
#include <cstdint>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

using namespace scpefe;

namespace {

class FakePassword final : public core::PasswordService {
public:
    explicit FakePassword(const core::EncryptionService &encryption)
        : core::PasswordService(encryption) {}
    security::PasswordPolicyAssessment assess(const std::uint8_t *, std::size_t) const override
    { ++assess_calls; return security::PasswordPolicyAssessment::accepted; }
    mutable unsigned assess_calls{};
};

class FakeEncryption final : public core::EncryptionService {
public:
    void random_bytes(std::uint8_t *out, std::size_t size) const override
    { ++random_calls; for (std::size_t i = 0; i < size; ++i) out[i] = 42; }
    std::array<std::uint8_t, format::content_hash_size> hash_content(
        const std::uint8_t *, std::size_t) const override
    { ++hash_calls; std::array<std::uint8_t, format::content_hash_size> result{};
      result.fill(17); return result; }
    mutable unsigned random_calls{};
    mutable unsigned hash_calls{};
};

class FakePersistence final : public core::PersistenceService {
public:
    bool has_valid_v3_framing(const std::uint8_t *, std::size_t, std::size_t) const override
    { return true; }
    void validate_legacy_envelope(const std::uint8_t *, std::size_t) const override
    { ++open_calls; }
    container::UnlockedContainerData unlock_legacy_envelope(
        const std::uint8_t *, std::size_t, const std::uint8_t *, std::size_t,
        const format::RevisionLimits &) const override
    { ++unlock_calls; container::UnlockedContainerData result;
      result.slot_id[0] = 7; result.permissions = 7; return result; }
    mutable unsigned open_calls{};
    mutable unsigned unlock_calls{};
};

class FakeHistory final : public core::HistoryService {
public:
    std::size_t compaction_cutoff(std::size_t, std::size_t) const override { return 42; }
    std::vector<std::uint8_t> compact_legacy_document(
        const std::uint8_t *, std::size_t, const std::uint8_t *, std::size_t,
        const std::array<std::uint8_t, 16> &, std::uint64_t) const override
    { ++compact_calls; return {0x53, 0x43, 0x50}; }
    mutable unsigned compact_calls{};
};

class CountingObserver final : public container::ContainerStateObserver {
public:
    explicit CountingObserver(const container::Container &container) : container_(container) {}
    void on_state_changed(const container::ContainerState &before,
        const container::ContainerState &after, std::uint64_t operation_id) noexcept override
    {
        assert(container_.state() == after);
        assert(before != after);
        last_operation = operation_id;
        ++count;
    }
    const container::Container &container_;
    unsigned count{};
    std::uint64_t last_operation{};
};

scpefe_status clock(void *instance, std::uint64_t *time)
{
    *time = *static_cast<std::uint64_t *>(instance);
    return SCPEFE_STATUS_OK;
}

std::vector<std::uint8_t> read_hex(const std::string &path)
{
    std::ifstream input(path);
    assert(input.good());
    std::string hex;
    std::string line;
    while (std::getline(input, line))
        if (!line.empty() && line[0] != '#') hex += line;
    assert(hex.size() % 2 == 0);
    auto digit = [](char value) -> std::uint8_t {
        if (value >= '0' && value <= '9') return value - '0';
        if (value >= 'a' && value <= 'f') return value - 'a' + 10;
        assert(false);
        return 0;
    };
    std::vector<std::uint8_t> result;
    for (std::size_t index = 0; index < hex.size(); index += 2)
        result.push_back((digit(hex[index]) << 4) | digit(hex[index + 1]));
    return result;
}

} // namespace

int main(int argc, char **argv)
{
    assert(argc == 2);
    auto valid_v3 = read_hex(std::string(argv[1])
        + "/tests/vectors/draft-v3/valid/baseline-container.hex");
    core::PersistenceService persistence;
    assert(persistence.has_valid_v3_framing(valid_v3.data(), valid_v3.size(),
        valid_v3.size()));
    assert(!persistence.has_valid_v3_framing(valid_v3.data(), valid_v3.size(),
        valid_v3.size() - 1));
    valid_v3[72 + 40] = 65;
    assert(!persistence.has_valid_v3_framing(valid_v3.data(), valid_v3.size(),
        valid_v3.size()));

    using namespace container;
    std::uint64_t first_time = 101;
    std::uint64_t second_time = 202;
    auto fakes = [] {
        auto encryption = std::make_unique<FakeEncryption>();
        auto password = std::make_unique<FakePassword>(*encryption);
        return core::ServiceRegistry(
            std::move(password),
            std::move(encryption),
            std::make_unique<FakePersistence>(),
            std::make_unique<FakeHistory>(),
            std::make_unique<ContainerStateManagerService>());
    };
    core::Context first(core::HostServices(&first_time, clock), fakes());
    core::Context second(core::HostServices(&second_time, clock), fakes());
    assert(&first.services().password() != &second.services().password());
    std::uint8_t random_byte{};
    first.services().encryption().random_bytes(&random_byte, 1);
    assert(random_byte == 42);
    assert(first.services().password().new_slot_salt()[0] == 42);
    core::HealthInfo health{};
    assert(first.read_health(health) && health.host_monotonic_time_ms == 101);
    assert(second.read_health(health) && health.host_monotonic_time_ms == 202);

    auto &active = first.make_container();
    auto &other = second.make_container();
    assert(&active == &first.make_container());
    CountingObserver observer(active);
    active.subscribe(observer);
    ContainerStateManagerService manager;
    ContainerState simulated;
    auto step = [&](const StateTransition &attempt) {
        auto result = manager.apply(simulated, attempt);
        simulated = result.state;
        return result;
    };
    auto rejected = [&](const StateTransition &attempt) {
        try { step(attempt); return false; }
        catch (StateError) { return true; }
    };
    auto opened = step(Open{});
    assert(simulated.access == Access::open);
    assert(simulated.screen == Screen::locked);
    assert(other.state().access == Access::closed);
    assert(opened.effects.empty());

    step(Unlock{SlotId{7}, Permissions{true, false, false}, true});
    assert(simulated.screen == Screen::unlocked);
    auto editing = step(AcquireEdit{Lease::held});
    assert(simulated.edit == EditMode::editing);
    assert(editing.effects.size() == 1 && editing.effects[0].kind == EffectKind::start_heartbeat);

    auto publication = step(BeginPublication{11, PublicationKind::save});
    assert(publication.effects.size() == 3);
    assert(simulated.screen == Screen::unlocked);
    assert(simulated.publication == PublicationPhase::publishing);
    assert(rejected(AcknowledgePublication{10, PublicationOutcome::verified}));
    assert(simulated.publication == PublicationPhase::publishing);
    auto adopted = step(AcknowledgePublication{11, PublicationOutcome::verified});
    assert(adopted.effects[0].kind == EffectKind::adopt_candidate);
    assert(simulated.publication == PublicationPhase::idle);
    assert(rejected(BeginPublication{11, PublicationKind::save}));

    step(Lock{});
    assert(simulated.screen == Screen::locked);
    assert(simulated.edit == EditMode::read_only);
    assert(other.state().access == Access::closed);

    step(Unlock{SlotId{7}, Permissions{true, false, false}, false});
    step(AcquireEdit{Lease::held});
    auto demoted = step(ApplyTargetPermissions{Permissions{}, false});
    assert(simulated.edit == EditMode::read_only);
    assert(!simulated.permissions.can_edit);
    assert(demoted.effects.size() == 2);
    assert(demoted.effects[1].kind == EffectKind::preserve_unsaved_work);
    assert(rejected(BeginPublication{12, PublicationKind::save}));
    auto wrapper_change = step(ApplyTargetPermissions{Permissions{}, true});
    assert(wrapper_change.effects[0].kind == EffectKind::clear_display);
    assert(simulated.screen == Screen::locked);
    assert(simulated.attention == Attention::reauthenticate);
    assert(rejected(ClearAttention{}));
    assert(rejected(Unlock{SlotId{7}, Permissions{true, true, true}, false}));
    step(Close{});
    step(Open{});
    step(Unlock{SlotId{7}, Permissions{}, false});
    assert(rejected(BeginPublication{11, PublicationKind::backup_attempt}));
    step(Close{});

    step(Open{});
    step(Unlock{SlotId{7}, Permissions{true, false, false}, true,
        false, Lease::other_holder});
    assert(simulated.edit == EditMode::read_only);
    assert(simulated.lease == Lease::other_holder);
    assert(rejected(BeginPublication{12, PublicationKind::save}));
    step(BeginPublication{12, PublicationKind::lease_change});
    assert(rejected(AcknowledgePublication{11, PublicationOutcome::verified}));
    assert(simulated.publication == PublicationPhase::publishing);
    step(AcknowledgePublication{12, PublicationOutcome::verified});
    auto acquired_lease = step(PublishedLease{true});
    assert(simulated.edit == EditMode::editing && simulated.lease == Lease::held);
    assert(acquired_lease.effects.size() == 1
        && acquired_lease.effects[0].kind == EffectKind::start_heartbeat);
    step(Lock{});
    assert(simulated.lease == Lease::held && simulated.edit == EditMode::read_only);
    step(Unlock{SlotId{7}, Permissions{true, false, false}, true,
        false, Lease::held});
    assert(simulated.edit == EditMode::read_only);
    auto released_lease = step(PublishedLease{false});
    assert(simulated.lease == Lease::none && simulated.edit == EditMode::read_only);
    assert(released_lease.effects.empty());
    step(Close{});

    step(Open{});
    step(Unlock{SlotId{9}, Permissions{}, false});
    auto attempt = step(BeginPublication{21, PublicationKind::backup_attempt});
    assert(attempt.effects[0].kind == EffectKind::reread_target);
    auto published = step(AcknowledgePublication{21, PublicationOutcome::verified});
    assert(simulated.publication == PublicationPhase::awaiting_host_action);
    assert(published.effects.back().kind == EffectKind::perform_backup);
    assert(rejected(BeginPublication{22, PublicationKind::save}));
    auto completed = step(CompleteHostAction{21, true});
    assert(simulated.publication == PublicationPhase::outcome_pending);
    assert(completed.effects[0].kind == EffectKind::record_success_outcome);
    assert(completed.effects[1].kind == EffectKind::journal_activity_outcome);
    step(BeginPublication{22, PublicationKind::activity_outcome});
    step(AcknowledgePublication{22, PublicationOutcome::ambiguous});
    assert(simulated.publication == PublicationPhase::recovery_required);
    assert(rejected(ResolveAmbiguity{21, true}));
    step(ResolveAmbiguity{22, true});
    assert(simulated.publication == PublicationPhase::idle);
    step(BeginPublication{23, PublicationKind::export_attempt});
    auto export_attempt = step(
        AcknowledgePublication{23, PublicationOutcome::verified});
    assert(export_attempt.effects.back().kind == EffectKind::perform_export);
    auto export_failure = step(CompleteHostAction{23, false});
    assert(export_failure.effects[0].kind == EffectKind::record_failure_outcome);
    assert(export_failure.effects[1].kind == EffectKind::journal_activity_outcome);
    step(BeginPublication{24, PublicationKind::activity_outcome});
    step(AcknowledgePublication{24, PublicationOutcome::definite_failure});
    assert(simulated.publication == PublicationPhase::outcome_pending);
    auto closed = step(Close{});
    assert(closed.effects[0].kind == EffectKind::journal_activity_outcome);

    // The same injected services drive actual context document operations.
    const std::uint8_t weak_password[]{'w'};
    auto candidate = active.create_document("Ada", "ada@example.org", "test",
        "first line", 123, weak_password, sizeof(weak_password), nullptr, 0);
    const auto &fake_password = static_cast<const FakePassword &>(first.services().password());
    const auto &fake_encryption = static_cast<const FakeEncryption &>(first.services().encryption());
    const auto &fake_persistence = static_cast<const FakePersistence &>(first.services().persistence());
    assert(fake_password.assess_calls == 1);
    assert(fake_encryption.random_calls >= 7 && fake_encryption.hash_calls == 0);
    assert(!candidate.empty());
    auto fake_generated = core::PersistenceService{}.unlock_revised_envelope(
        candidate.data(), candidate.size(), weak_password, sizeof(weak_password),
        format::RevisionLimits::defaults());
    assert(fake_generated.slot_id[0] == 42);
    assert(fake_generated.revision_graph->records().size() == 1);
    assert(fake_generated.revision_graph->reconstruct(
        fake_generated.revision_graph->content_head()) == "first line");
    auto legacy_candidate = document::NewDocument::create("Ada", "ada@example.org",
        "test", "first line", 123, weak_password, sizeof(weak_password),
        nullptr, 0, &first.services().encryption());
    active.open_legacy_document(legacy_candidate.data(), legacy_candidate.size());
    assert(fake_persistence.open_calls == 1);
    assert(!active.try_transition(Unlock{SlotId{7}, Permissions{true, true, true}, true}));
    assert(!active.try_transition(Open{}));
    assert(!active.can_read_clear());
    assert(active.unlock_legacy_document(weak_password, sizeof(weak_password)).slot_id[0] == 7);
    assert(fake_persistence.unlock_calls == 1);
    assert(!active.try_transition(AcquireEdit{Lease::held}));
    assert(!active.try_transition(BeginPublication{1, PublicationKind::save}));
    assert(!active.try_transition(AcknowledgePublication{1, PublicationOutcome::verified}));
    assert(!active.try_transition(ClearAttention{}));
    assert(!active.try_transition(ApplyTargetPermissions{Permissions{}, false}));
    assert(!active.try_transition(ApplyTargetPermissions{Permissions{}, true}));
    active.transition(Lock{});
    assert(!active.try_transition(Unlock{SlotId{7}, Permissions{true, true, true}, true}));
    assert(!active.can_read_clear());
    assert(active.unlock_legacy_document(weak_password, sizeof(weak_password)).slot_id[0] == 7);
    assert(active.can_read_clear());
    assert(observer.count == 4);
    active.transition(Close{});

    // Production services can decrypt the candidate they created.
    std::uint64_t production_time = 303;
    core::Context production(core::HostServices(&production_time, clock));
    auto &production_container = production.make_container();
    const std::string strong_password = "0b4e79c5-7cfe-4b7c-b4f3-d89129cb7b5e";
    const auto *password_bytes = reinterpret_cast<const std::uint8_t *>(strong_password.data());
    auto revised_created = production_container.create_document("Ada", "ada@example.org",
        "test", "first line", 123, password_bytes, strong_password.size(), nullptr, 0);
    assert(RevisedV3Container::recognizes(revised_created.data(), revised_created.size()));
    auto real_candidate = document::NewDocument::create("Ada", "ada@example.org",
        "test", "first line", 123, password_bytes, strong_password.size(), nullptr, 0);
    auto bad_structure = real_candidate;
    bad_structure[32] = 3; // Unsupported base-slot count in the transitional header.
    try {
        production_container.open_legacy_document(bad_structure.data(), bad_structure.size());
        assert(false);
    } catch (const ContainerFailure &failure) {
        assert(failure.error == ContainerError::malformed_container);
    }
    assert(production_container.state().access == Access::closed);
    try {
        production_container.open_legacy_document(real_candidate.data(), 8);
        assert(false);
    } catch (const ContainerFailure &failure) {
        assert(failure.error == ContainerError::malformed_container);
    }
    assert(production_container.state().access == Access::closed);
    bad_structure = real_candidate;
    bad_structure[64] = 0; // The encrypted payload length must match the envelope.
    try {
        production_container.open_legacy_document(bad_structure.data(), bad_structure.size());
        assert(false);
    } catch (const ContainerFailure &failure) {
        assert(failure.error == ContainerError::malformed_container);
    }
    assert(production_container.state().access == Access::closed);
    bad_structure = real_candidate;
    bad_structure[36] = 2; // Keep the unsupported-algorithm error distinct.
    try {
        production_container.open_legacy_document(bad_structure.data(), bad_structure.size());
        assert(false);
    } catch (const ContainerFailure &failure) {
        assert(failure.error == ContainerError::unsupported_format);
    }
    assert(production_container.state().access == Access::closed);
    production_container.open_legacy_document(real_candidate.data(), real_candidate.size());
    const auto &real_unlocked = production_container.unlock_legacy_document(
        password_bytes, strong_password.size());
    const auto revision = format::SnapshotRevision::decode(
        real_unlocked.encoded_snapshot_revision.data(),
        real_unlocked.encoded_snapshot_revision.size(), format::RevisionLimits::defaults());
    assert(revision.data().content == "first line");
    assert(production_container.can_read_clear());
    assert(!production_container.try_transition(ApplyTargetPermissions{Permissions{}, false}));
    assert(!production_container.try_transition(ApplyTargetPermissions{Permissions{}, true}));
    assert(!production_container.try_transition(AcquireEdit{Lease::held}));
    assert(!production_container.try_transition(BeginPublication{1, PublicationKind::save}));
    auto unrelated_target = document::NewDocument::create(
        "Other", "other@example.org",
        "test", "unrelated", 124, password_bytes, strong_password.size(), nullptr, 0);
    try {
        production_container.apply_target_legacy_document(unrelated_target.data(),
            unrelated_target.size(), password_bytes, strong_password.size());
        assert(false);
    } catch (const ContainerFailure &failure) {
        assert(failure.error == ContainerError::malformed_container);
    }
    assert((production_container.state().permissions == Permissions{true, true, true}));
    const std::string replacement_password = "f5ee6791-97ad-44bc-8a72-b79b7b26316a";
    const auto *replacement_bytes = reinterpret_cast<const std::uint8_t *>(
        replacement_password.data());
    auto changed_target = RecoverablePasswordContainer::change_password(
        real_candidate.data(), real_candidate.size(), password_bytes,
        strong_password.size(), replacement_bytes, replacement_password.size());
    try {
        production_container.apply_target_legacy_document(changed_target.data(),
            changed_target.size(), password_bytes, strong_password.size());
        assert(false);
    } catch (const ContainerFailure &failure) {
        assert(failure.error == ContainerError::authentication_failed);
    }
    assert(production_container.can_read_clear());
    production_container.apply_target_legacy_document(changed_target.data(),
        changed_target.size(), replacement_bytes, replacement_password.size());
    try {
        production_container.unlock_legacy_document(password_bytes, strong_password.size());
        assert(false);
    } catch (const ContainerFailure &failure) {
        assert(failure.error == ContainerError::authentication_failed);
    }
    assert(production_container.state().screen == Screen::locked);
    assert(production_container.state().attention == Attention::reauthenticate);
    assert(!production_container.try_transition(Unlock{real_unlocked.slot_id,
        Permissions{true, true, true}, true, true}));
    assert(!production_container.try_transition(ClearAttention{}));
    const auto &target_access = production_container.unlock_legacy_document(
        replacement_bytes, replacement_password.size());
    assert(target_access.permissions == 7);
    assert(production_container.state().attention == Attention::none);
    try {
        production_container.apply_target_legacy_document(real_candidate.data(),
            real_candidate.size(), password_bytes, strong_password.size());
        assert(false);
    } catch (StateError error) {
        assert(error == StateError::invalid_transition);
    }
    production_container.transition(Lock{});
    try {
        production_container.unlock_legacy_document(password_bytes, strong_password.size());
        assert(false);
    } catch (const ContainerFailure &failure) {
        assert(failure.error == ContainerError::authentication_failed);
    }
    assert(production_container.unlock_legacy_document(replacement_bytes,
        replacement_password.size()).permissions == 7);
    production_container.transition(Close{});

    // A target's authenticated slot rights replace local effective rights.
    const std::string temporary_password = "temporary editor credential maple mountain";
    const std::string editor_password = "claimed editor credential cedar meadow";
    const auto *temporary_bytes = reinterpret_cast<const std::uint8_t *>(
        temporary_password.data());
    const auto *editor_bytes = reinterpret_cast<const std::uint8_t *>(
        editor_password.data());
    auto invited = RecoverablePasswordContainer::add_invitation(real_candidate.data(),
        real_candidate.size(), password_bytes, strong_password.size(), temporary_bytes,
        temporary_password.size(), 1, "Editor");
    auto claimed = RecoverablePasswordContainer::claim_invitation(invited.data(),
        invited.size(), temporary_bytes, temporary_password.size(), editor_bytes,
        editor_password.size(), "Grace", "grace@example.test");
    production_container.open_legacy_document(claimed.data(), claimed.size());
    const auto &editor_access = production_container.unlock_legacy_document(
        editor_bytes, editor_password.size());
    assert(editor_access.permissions == 1);
    auto demoted_target = RecoverablePasswordContainer::update_slot_permissions(
        claimed.data(), claimed.size(), password_bytes, strong_password.size(),
        editor_access.slot_id, 0);
    auto demoted_result = production_container.apply_target_legacy_document(
        demoted_target.data(), demoted_target.size(), editor_bytes,
        editor_password.size());
    assert(demoted_result.state.screen == Screen::unlocked);
    assert(demoted_result.state.permissions == Permissions{});
    assert(!demoted_result.state.target_access->wrapper_changed);
    assert(editor_access.permissions == 0);
    assert(!production_container.try_transition(BeginPublication{2, PublicationKind::save}));
    production_container.transition(Lock{});
    assert(!production_container.try_transition(Unlock{editor_access.slot_id,
        Permissions{true, true, true}, true, true}));
    assert(production_container.unlock_legacy_document(editor_bytes,
        editor_password.size()).permissions == 0);
    const SlotId removed_slot_id = editor_access.slot_id;
    production_container.transition(Close{});

    // Another authenticated slot can prove that the active slot lost access.
    auto removed_target = RecoverablePasswordContainer::remove_slot(claimed.data(),
        claimed.size(), password_bytes, strong_password.size(), removed_slot_id);
    production_container.open_legacy_document(claimed.data(), claimed.size());
    production_container.unlock_legacy_document(editor_bytes, editor_password.size());
    production_container.apply_target_legacy_document(removed_target.data(),
        removed_target.size(), password_bytes, strong_password.size());
    assert(!production_container.can_read_clear());
    assert(production_container.state().attention == Attention::reauthenticate);
    try {
        production_container.unlock_legacy_document(editor_bytes, editor_password.size());
        assert(false);
    } catch (const ContainerFailure &failure) {
        assert(failure.error == ContainerError::authentication_failed);
    }
    production_container.transition(Close{});
}
