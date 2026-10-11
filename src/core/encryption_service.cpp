#include "core/encryption_service.hpp"

#include <stdexcept>

extern "C" int sodium_init(void);
extern "C" void randombytes_buf(void *buffer, std::size_t size);
extern "C" int crypto_generichash(unsigned char *, std::size_t,
    const unsigned char *, unsigned long long, const unsigned char *, std::size_t);

namespace scpefe::core {

void EncryptionService::random_bytes(std::uint8_t *out, std::size_t size) const
{
    if (size != 0 && out == nullptr) throw std::invalid_argument("null random buffer");
    if (sodium_init() < 0) throw std::runtime_error("libsodium initialization failed");
    if (size != 0) randombytes_buf(out, size);
}

std::array<std::uint8_t, format::content_hash_size> EncryptionService::hash_content(
    const std::uint8_t *bytes, std::size_t size) const
{
    if (size != 0 && bytes == nullptr) throw std::invalid_argument("null content");
    if (sodium_init() < 0) throw std::runtime_error("libsodium initialization failed");
    std::array<std::uint8_t, format::content_hash_size> result{};
    if (crypto_generichash(result.data(), result.size(), bytes, size, nullptr, 0) != 0)
        throw std::runtime_error("content hash failed");
    return result;
}

} // namespace scpefe::core
