#include "core/service_registry.hpp"

#include <stdexcept>
#include <utility>

namespace scpefe::core {

ServiceRegistry::ServiceRegistry(std::unique_ptr<PasswordService> password,
    std::unique_ptr<EncryptionService> encryption,
    std::unique_ptr<PersistenceService> persistence,
    std::unique_ptr<HistoryService> history,
    std::unique_ptr<container::ContainerStateManagerService> state_manager)
    : encryption_(std::move(encryption)), password_(std::move(password)),
      persistence_(std::move(persistence)), history_(std::move(history)),
      state_manager_(std::move(state_manager))
{
    if (!password_ || !encryption_ || !persistence_ || !history_ || !state_manager_)
        throw std::invalid_argument("incomplete service registry");
}

} // namespace scpefe::core
