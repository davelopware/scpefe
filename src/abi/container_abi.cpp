#include "scpefe/scpefe.h"

#include "container/container_error.hpp"
#include "container/password_container.hpp"
#include "container/unlocked_container_data.hpp"
#include "format/text_validation.hpp"

#include <cstring>
#include <new>
#include <utility>
#include <vector>

extern "C" void sodium_memzero(void *buffer, std::size_t size);

using scpefe::container::ContainerError;
using scpefe::container::ContainerFailure;
using scpefe::container::PasswordContainer;
using scpefe::container::UnlockedContainerData;

namespace {

/* Maps an internal container failure to its stable C ABI status. */
scpefe_status external_status(ContainerError error)
{
    switch (error) {
    case ContainerError::invalid_argument:
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    case ContainerError::malformed_container:
        return SCPEFE_STATUS_MALFORMED_CONTAINER;
    case ContainerError::unsupported_format:
        return SCPEFE_STATUS_UNSUPPORTED_FORMAT;
    case ContainerError::authentication_failed:
        return SCPEFE_STATUS_AUTHENTICATION_FAILED;
    case ContainerError::out_of_memory:
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    case ContainerError::crypto_error:
        return SCPEFE_STATUS_CRYPTO_ERROR;
    }
    return SCPEFE_STATUS_CRYPTO_ERROR;
}

} // namespace

struct scpefe_unlocked_container {
    /* Takes ownership of authenticated unlocked values. */
    explicit scpefe_unlocked_container(UnlockedContainerData value)
        : data(std::move(value)) {}
    UnlockedContainerData data;
};

scpefe_status scpefe_password_container_create(
    const std::uint8_t *password,
    std::size_t password_size,
    const std::uint8_t *encoded_snapshot_revision,
    std::size_t encoded_snapshot_revision_size,
    std::uint8_t *output,
    std::size_t output_capacity,
    std::size_t *output_size
)
{
    if (!scpefe::format::span_is_valid(password, password_size)
        || password_size == 0
        || !scpefe::format::span_is_valid(
            encoded_snapshot_revision, encoded_snapshot_revision_size
        )
        || encoded_snapshot_revision_size == 0 || output_size == nullptr) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    try {
        const std::size_t required_size = PasswordContainer::encoded_size(
            encoded_snapshot_revision_size
        );
        *output_size = required_size;
        if (output == nullptr || output_capacity < required_size) {
            return SCPEFE_STATUS_BUFFER_TOO_SMALL;
        }
        const std::vector<std::uint8_t> encoded = PasswordContainer::create(
            password, password_size, encoded_snapshot_revision,
            encoded_snapshot_revision_size
        );
        std::memcpy(output, encoded.data(), encoded.size());
        return SCPEFE_STATUS_OK;
    } catch (const ContainerFailure &failure) {
        return external_status(failure.error);
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_password_container_unlock(
    const std::uint8_t *container,
    std::size_t container_size,
    const std::uint8_t *password,
    std::size_t password_size,
    scpefe_unlocked_container **unlocked
)
{
    if (!scpefe::format::span_is_valid(container, container_size)
        || container_size == 0
        || !scpefe::format::span_is_valid(password, password_size)
        || password_size == 0 || unlocked == nullptr) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    *unlocked = nullptr;
    try {
        UnlockedContainerData data = PasswordContainer::unlock(
            container, container_size, password, password_size
        );
        *unlocked = new scpefe_unlocked_container(std::move(data));
        return SCPEFE_STATUS_OK;
    } catch (const ContainerFailure &failure) {
        return external_status(failure.error);
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_unlocked_container_view(
    const scpefe_unlocked_container *unlocked,
    scpefe_unlocked_container_v1 *view
)
{
    if (unlocked == nullptr || view == nullptr
        || view->struct_size < sizeof(scpefe_unlocked_container_v1)) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    const std::uint32_t struct_size = view->struct_size;
    *view = scpefe_unlocked_container_v1{
        struct_size,
        unlocked->data.document_id.data(),
        unlocked->data.document_id.size(),
        unlocked->data.encoded_snapshot_revision.data(),
        unlocked->data.encoded_snapshot_revision.size(),
    };
    return SCPEFE_STATUS_OK;
}

void scpefe_unlocked_container_destroy(scpefe_unlocked_container *unlocked)
{
    if (unlocked == nullptr) return;
    sodium_memzero(
        unlocked->data.document_id.data(), unlocked->data.document_id.size()
    );
    if (!unlocked->data.encoded_snapshot_revision.empty()) {
        sodium_memzero(
            unlocked->data.encoded_snapshot_revision.data(),
            unlocked->data.encoded_snapshot_revision.size()
        );
    }
    delete unlocked;
}
