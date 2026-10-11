#include "core/encryption_service.hpp"

#include <stdexcept>

extern "C" int sodium_init(void);
extern "C" void randombytes_buf(void *buffer, std::size_t size);

namespace scpefe::core {

void EncryptionService::random_bytes(std::uint8_t *out, std::size_t size) const
{
    if (size != 0 && out == nullptr) throw std::invalid_argument("null random buffer");
    if (sodium_init() < 0) throw std::runtime_error("libsodium initialization failed");
    if (size != 0) randombytes_buf(out, size);
}

} // namespace scpefe::core
