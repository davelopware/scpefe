#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace scpefe::format {

/* Wipes a borrowed temporary buffer on success and exception paths. */
class ClearBufferOnExit {
public:
    /* Tracks a string object even when its storage changes. */
    explicit ClearBufferOnExit(std::string &buffer) noexcept;
    /* Tracks a byte vector even when its storage changes. */
    explicit ClearBufferOnExit(std::vector<std::uint8_t> &buffer) noexcept;
    /* Tracks an optional reconstructed string while it is engaged. */
    explicit ClearBufferOnExit(std::optional<std::string> &buffer) noexcept;
    /* Overwrites the buffer's current bytes before leaving scope. */
    ~ClearBufferOnExit();
    /* Prevents duplicating a borrowed cleanup obligation. */
    ClearBufferOnExit(const ClearBufferOnExit &) = delete;
    /* Prevents replacing a borrowed cleanup obligation. */
    ClearBufferOnExit &operator=(const ClearBufferOnExit &) = delete;
    /* Wipes current bytes before replacement without changing the buffer's size. */
    void clear() const noexcept;

private:
    void *buffer_;
    void (*clear_)(void *) noexcept;
};

} // namespace scpefe::format
