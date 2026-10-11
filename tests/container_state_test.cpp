#include "core/context.hpp"
#include "core/service_registry.hpp"
#include "container/container.hpp"
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
    bool recognizes_legacy_envelope(const std::uint8_t *, std::size_t) const override
    { ++open_calls; return true; }
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
    auto opened = active.transition(Open{});
    assert(active.state().access == Access::open);
    assert(active.state().screen == Screen::locked);
    assert(other.state().access == Access::closed);
    assert(opened.effects.empty());

    active.transition(Unlock{SlotId{7}, Permissions{true, false, false}, true});
    assert(active.can_read_clear());
    auto editing = active.transition(AcquireEdit{Lease::held});
    assert(active.state().edit == EditMode::editing);
    assert(editing.effects.size() == 1 && editing.effects[0].kind == EffectKind::start_heartbeat);

    auto publication = active.transition(BeginPublication{11, PublicationKind::save});
    assert(publication.effects.size() == 3);
    assert(active.can_read_clear());
    assert(active.state().publication == PublicationPhase::publishing);
    assert(!active.try_transition(AcknowledgePublication{10, PublicationOutcome::verified}));
    assert(active.state().publication == PublicationPhase::publishing);
    auto adopted = active.transition(AcknowledgePublication{11, PublicationOutcome::verified});
    assert(adopted.effects[0].kind == EffectKind::adopt_candidate);
    assert(active.state().publication == PublicationPhase::idle);
    assert(!active.try_transition(BeginPublication{11, PublicationKind::save}));

    active.transition(Lock{});
    assert(!active.can_read_clear());
    assert(active.state().edit == EditMode::read_only);
    assert(observer.last_operation == 0);
    assert(other.state().access == Access::closed);
    assert(observer.count == 6);

    active.transition(Unlock{SlotId{7}, Permissions{true, false, false}, false});
    active.transition(AcquireEdit{Lease::held});
    auto demoted = active.transition(ApplyTargetPermissions{Permissions{}, false});
    assert(active.state().edit == EditMode::read_only);
    assert(!active.state().permissions.can_edit);
    assert(demoted.effects.size() == 2);
    assert(demoted.effects[1].kind == EffectKind::preserve_unsaved_work);
    assert(!active.try_transition(BeginPublication{12, PublicationKind::save}));
    auto wrapper_change = active.transition(ApplyTargetPermissions{Permissions{}, true});
    assert(wrapper_change.effects[0].kind == EffectKind::clear_display);
    assert(!active.can_read_clear());
    assert(active.state().attention == Attention::reauthenticate);
    assert(!active.try_transition(ClearAttention{}));
    active.transition(Unlock{SlotId{7}, Permissions{}, false});
    assert(active.state().attention == Attention::none);
    active.transition(Close{});
    assert(!active.can_read_clear());
    active.transition(Open{});
    active.transition(Unlock{SlotId{7}, Permissions{}, false});
    assert(!active.try_transition(BeginPublication{11, PublicationKind::backup_attempt}));
    active.transition(Close{});

    other.transition(Open{});
    other.transition(Unlock{SlotId{9}, Permissions{}, false});
    auto attempt = other.transition(BeginPublication{21, PublicationKind::backup_attempt});
    assert(attempt.effects[0].kind == EffectKind::reread_target);
    auto published = other.transition(AcknowledgePublication{21, PublicationOutcome::verified});
    assert(other.state().publication == PublicationPhase::awaiting_host_action);
    assert(published.effects.back().kind == EffectKind::perform_backup);
    assert(!other.try_transition(BeginPublication{22, PublicationKind::save}));
    auto completed = other.transition(CompleteHostAction{21, true});
    assert(other.state().publication == PublicationPhase::outcome_pending);
    assert(completed.effects[0].kind == EffectKind::record_success_outcome);
    other.transition(BeginPublication{22, PublicationKind::activity_outcome});
    other.transition(AcknowledgePublication{22, PublicationOutcome::ambiguous});
    assert(other.state().publication == PublicationPhase::recovery_required);
    assert(!other.try_transition(ResolveAmbiguity{21, true}));
    other.transition(ResolveAmbiguity{22, true});
    assert(other.state().publication == PublicationPhase::idle);
    other.transition(BeginPublication{23, PublicationKind::export_attempt});
    auto export_attempt = other.transition(
        AcknowledgePublication{23, PublicationOutcome::verified});
    assert(export_attempt.effects.back().kind == EffectKind::perform_export);
    auto export_failure = other.transition(CompleteHostAction{23, false});
    assert(export_failure.effects[0].kind == EffectKind::record_failure_outcome);
    other.transition(BeginPublication{24, PublicationKind::activity_outcome});
    other.transition(AcknowledgePublication{24, PublicationOutcome::definite_failure});
    assert(other.state().publication == PublicationPhase::outcome_pending);
    auto closed = other.transition(Close{});
    assert(closed.effects[0].kind == EffectKind::preserve_unsaved_work);

    // The same injected services drive actual context document operations.
    const std::uint8_t weak_password[]{'w'};
    auto candidate = active.create_document("Ada", "ada@example.org", "test",
        "first line", 123, weak_password, sizeof(weak_password), nullptr, 0);
    const auto &fake_password = static_cast<const FakePassword &>(first.services().password());
    const auto &fake_encryption = static_cast<const FakeEncryption &>(first.services().encryption());
    const auto &fake_persistence = static_cast<const FakePersistence &>(first.services().persistence());
    const auto &fake_history = static_cast<const FakeHistory &>(first.services().history());
    assert(fake_password.assess_calls == 1);
    assert(fake_encryption.random_calls >= 6 && fake_encryption.hash_calls == 1);
    assert(!candidate.empty());
    auto fake_generated = core::PersistenceService{}.unlock_legacy_envelope(
        candidate.data(), candidate.size(), weak_password, sizeof(weak_password),
        format::RevisionLimits::defaults());
    const auto fake_revision = format::SnapshotRevision::decode(
        fake_generated.encoded_snapshot_revision.data(),
        fake_generated.encoded_snapshot_revision.size(), format::RevisionLimits::defaults());
    assert(fake_generated.slot_id[0] == 42);
    assert(fake_revision.data().content_hash[0] == 17);
    active.open_legacy_document(candidate.data(), candidate.size());
    assert(fake_persistence.open_calls == 1);
    assert(active.unlock_legacy_document(weak_password, sizeof(weak_password)).slot_id[0] == 7);
    assert(fake_persistence.unlock_calls == 1);
    assert(active.transition(AcquireEdit{Lease::held}).state.edit == EditMode::editing);
    const auto compacted = active.compact_legacy_document(weak_password,
        sizeof(weak_password), SlotId{}, 0);
    assert(compacted == std::vector<std::uint8_t>({0x53, 0x43, 0x50}));
    assert(fake_history.compact_calls == 1);
    active.transition(Close{});

    // Production services can decrypt the candidate they created.
    std::uint64_t production_time = 303;
    core::Context production(core::HostServices(&production_time, clock));
    auto &production_container = production.make_container();
    const std::string strong_password = "0b4e79c5-7cfe-4b7c-b4f3-d89129cb7b5e";
    const auto *password_bytes = reinterpret_cast<const std::uint8_t *>(strong_password.data());
    auto real_candidate = production_container.create_document("Ada", "ada@example.org",
        "test", "first line", 123, password_bytes, strong_password.size(), nullptr, 0);
    production_container.open_legacy_document(real_candidate.data(), real_candidate.size());
    const auto &real_unlocked = production_container.unlock_legacy_document(
        password_bytes, strong_password.size());
    const auto revision = format::SnapshotRevision::decode(
        real_unlocked.encoded_snapshot_revision.data(),
        real_unlocked.encoded_snapshot_revision.size(), format::RevisionLimits::defaults());
    assert(revision.data().content == "first line");
    assert(production_container.can_read_clear());
    production_container.transition(Close{});
}
