#pragma once

#include "core/password_service.hpp"
#include "core/encryption_service.hpp"
#include "core/persistence_service.hpp"
#include "core/history_service.hpp"
#include "container/container_state.hpp"

#include <memory>

namespace scpefe::core {

/* Owns exactly one injectable instance of each document service per context. */
class ServiceRegistry {
public:
    /* Takes exclusive ownership of a complete set of context services. */
    ServiceRegistry(std::unique_ptr<PasswordService> password,
        std::unique_ptr<EncryptionService> encryption,
        std::unique_ptr<PersistenceService> persistence,
        std::unique_ptr<HistoryService> history,
        std::unique_ptr<container::ContainerStateManagerService> state_manager);
    /* Returns the context's password policy service. */
    PasswordService &password() const { return *password_; }
    /* Returns the context's encryption service. */
    EncryptionService &encryption() const { return *encryption_; }
    /* Returns the context's persistence service. */
    PersistenceService &persistence() const { return *persistence_; }
    /* Returns the context's history service. */
    HistoryService &history() const { return *history_; }
    /* Returns the context's state transition service. */
    container::ContainerStateManagerService &state_manager() const { return *state_manager_; }

private:
    std::unique_ptr<EncryptionService> encryption_;
    std::unique_ptr<PasswordService> password_;
    std::unique_ptr<PersistenceService> persistence_;
    std::unique_ptr<HistoryService> history_;
    std::unique_ptr<container::ContainerStateManagerService> state_manager_;
};

} // namespace scpefe::core
