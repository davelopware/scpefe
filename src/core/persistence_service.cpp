#include "core/persistence_service.hpp"

#include "container/revised_v3_container.hpp"

namespace scpefe::core {

std::vector<std::uint8_t> PersistenceService::create_revised_document(
    std::string_view profile_name, std::string_view profile_email,
    std::string_view device_name, std::string_view content,
    std::uint64_t timestamp_ms, const std::uint8_t *owner_password,
    std::size_t owner_password_size, const std::uint8_t *recovery_password,
    std::size_t recovery_password_size, const EncryptionService &encryption) const
{
    return container::RevisedV3Container::create(profile_name, profile_email,
        device_name, content, timestamp_ms, owner_password, owner_password_size,
        recovery_password, recovery_password_size, encryption);
}

void PersistenceService::validate_revised_envelope(
    const std::uint8_t *bytes, std::size_t size) const
{
    container::RevisedV3Container::validate_structure(bytes, size);
}

container::UnlockedContainerData PersistenceService::unlock_revised_envelope(
    const std::uint8_t *bytes, std::size_t size,
    const std::uint8_t *password, std::size_t password_size,
    const format::RevisionLimits &limits) const
{
    return container::RevisedV3Container::unlock(
        bytes, size, password, password_size, limits);
}

std::vector<std::uint8_t> PersistenceService::replace_revised_graph(
    const std::uint8_t *bytes, std::size_t size,
    const std::uint8_t *password, std::size_t password_size,
    const std::uint8_t *graph, std::size_t graph_size) const
{
    return container::RevisedV3Container::replace_graph(bytes, size,
        password, password_size, graph, graph_size);
}

} // namespace scpefe::core
