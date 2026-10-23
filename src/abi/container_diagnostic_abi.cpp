#include "scpefe/scpefe.h"

#include "container/container_error.hpp"
#include "container/revised_v3_container.hpp"
#include "format/revision_error.hpp"

#include <cstring>
#include <new>

extern "C" void sodium_memzero(void *, std::size_t);

namespace {

scpefe_status status_for(scpefe::container::ContainerError error)
{
    using scpefe::container::ContainerError;
    switch (error) {
    case ContainerError::invalid_argument: return SCPEFE_STATUS_INVALID_ARGUMENT;
    case ContainerError::malformed_container: return SCPEFE_STATUS_MALFORMED_CONTAINER;
    case ContainerError::unsupported_format: return SCPEFE_STATUS_UNSUPPORTED_FORMAT;
    case ContainerError::limit_exceeded: return SCPEFE_STATUS_LIMIT_EXCEEDED;
    case ContainerError::authentication_failed: return SCPEFE_STATUS_AUTHENTICATION_FAILED;
    case ContainerError::out_of_memory: return SCPEFE_STATUS_OUT_OF_MEMORY;
    default: return SCPEFE_STATUS_CRYPTO_ERROR;
    }
}

} // namespace

scpefe_status scpefe_container_diagnostic_json(
    const scpefe_container_diagnostic_v1 *request,
    char *output, size_t capacity, size_t *output_size)
{
    if (output_size) *output_size = 0;
    if (!request || !output_size || request->struct_size < sizeof(*request))
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    if (request->abi_version != SCPEFE_ABI_VERSION) return SCPEFE_STATUS_UNSUPPORTED_ABI;
    if (!request->limits || request->limits->struct_size < sizeof(*request->limits)
        || (!request->bytes && request->bytes_size != 0)
        || !request->password || request->password_size == 0
        || request->password_size > 4096
        || (request->include_content != 0 && request->include_content != 1))
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    if (request->bytes_size > SCPEFE_DIAGNOSTIC_MAX_CONTAINER_BYTES)
        return SCPEFE_STATUS_LIMIT_EXCEEDED;
    const auto &limits = *request->limits;
    const scpefe::format::RevisionLimits bounded{limits.max_input_bytes,
        limits.max_nesting_depth, limits.max_collection_entries, limits.max_text_bytes,
        limits.max_byte_string_bytes, limits.max_parent_count};
    try {
        auto json = scpefe::container::RevisedV3Container::diagnostic_json(
            request->bytes, request->bytes_size, request->password, request->password_size,
            bounded, request->include_content != 0);
        const auto size = json.size();
        const bool fits = output && capacity > size;
        if (fits) {
            std::memcpy(output, json.data(), size);
            output[size] = '\0';
        }
        sodium_memzero(json.data(), size);
        *output_size = size;
        return fits ? SCPEFE_STATUS_OK : SCPEFE_STATUS_BUFFER_TOO_SMALL;
    } catch (const scpefe::container::ContainerFailure &failure) {
        return status_for(failure.error);
    } catch (const scpefe::format::RevisionFailure &failure) {
        using scpefe::format::RevisionError;
        switch (failure.error) {
        case RevisionError::limit_exceeded: return SCPEFE_STATUS_LIMIT_EXCEEDED;
        case RevisionError::unsupported_format: return SCPEFE_STATUS_UNSUPPORTED_FORMAT;
        case RevisionError::invalid_argument: return SCPEFE_STATUS_INVALID_ARGUMENT;
        case RevisionError::malformed_cbor: return SCPEFE_STATUS_MALFORMED_CONTAINER;
        }
    } catch (const std::bad_alloc &) { return SCPEFE_STATUS_OUT_OF_MEMORY; }
    catch (...) { return SCPEFE_STATUS_CRYPTO_ERROR; }
    return SCPEFE_STATUS_CRYPTO_ERROR;
}
