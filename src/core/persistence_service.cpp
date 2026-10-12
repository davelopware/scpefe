#include "core/persistence_service.hpp"

#include <array>
#include "container/recoverable_password_container.hpp"
#include "container/revised_v3_container.hpp"

namespace scpefe::core {
namespace {

std::uint64_t read_le(const std::uint8_t *value, std::size_t count)
{
    std::uint64_t result = 0;
    for (std::size_t index = 0; index < count; ++index)
        result |= std::uint64_t(value[index]) << (index * 8);
    return result;
}

} // namespace

bool PersistenceService::has_valid_v3_framing(
    const std::uint8_t *bytes, std::size_t size, std::size_t max_bytes) const
{
    constexpr std::array<std::uint8_t, 8> magic{'S', 'C', 'P', 'E', 'F', 'E', 0, 3};
    if (bytes == nullptr || size < 72 || size > max_bytes) return false;
    for (std::size_t index = 0; index < magic.size(); ++index)
        if (bytes[index] != magic[index]) return false;
    if (read_le(bytes + 8, 4) != 3 || read_le(bytes + 12, 4) != 2
        || read_le(bytes + 16, 8) != 2
        || read_le(bytes + 24, 8) != 67108864
        || read_le(bytes + 36, 4) != 1) return false;
    const auto slots = read_le(bytes + 32, 4);
    const auto payload = read_le(bytes + 64, 8);
    if (slots < 1 || slots > 9 || payload < 33) return false;
    const auto records_end = std::size_t(72 + 110 * slots);
    if (size < records_end || payload > size - records_end) return false;
    if (payload != size - records_end) return false;
    for (std::size_t index = 0; index < slots; ++index)
        if (read_le(bytes + 72 + 110 * index + 40, 4) != 66) return false;
    return true;
}

bool PersistenceService::recognizes_revised_envelope(
    const std::uint8_t *bytes, std::size_t size) const
{
    return container::RevisedV3Container::recognizes(bytes, size);
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

void PersistenceService::validate_legacy_envelope(
    const std::uint8_t *bytes, std::size_t size) const
{
    container::RecoverablePasswordContainer::validate_structure(bytes, size);
}

container::UnlockedContainerData PersistenceService::unlock_legacy_envelope(
    const std::uint8_t *bytes, std::size_t size,
    const std::uint8_t *password, std::size_t password_size,
    const format::RevisionLimits &limits) const
{
    return container::RecoverablePasswordContainer::unlock(
        bytes, size, password, password_size, limits);
}

} // namespace scpefe::core
