#include "core/service_factory.hpp"

#include <memory>

namespace scpefe::core {

ServiceRegistry ServiceFactory::create()
{
    auto encryption = std::make_unique<EncryptionService>();
    auto password = std::make_unique<PasswordService>(*encryption);
    return ServiceRegistry(std::move(password),
        std::move(encryption),
        std::make_unique<PersistenceService>(),
        std::make_unique<HistoryService>(),
        std::make_unique<container::ContainerStateManagerService>());
}

} // namespace scpefe::core
