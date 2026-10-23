#pragma once

#include "scpefe/scpefe.h"

#include <array>
#include <cstddef>
#include <cstdint>

/* Owns a bounded password read without echo from a terminal or explicit stdin. */
class PasswordInput {
public:
    /* Starts with no password bytes. */
    PasswordInput() = default;
    /* Prevents copying secret storage. */
    PasswordInput(const PasswordInput &) = delete;
    /* Prevents copying secret storage into another input. */
    PasswordInput &operator=(const PasswordInput &) = delete;
    /* Wipes the password before releasing its storage. */
    ~PasswordInput();
    /* Reads one UTF-8 line, removing LF or CRLF; stdin requires explicit opt-in. */
    scpefe_status read(bool from_stdin);
    /* Borrows password bytes until clear or destruction. */
    const std::uint8_t *data() const { return bytes_.data(); }
    /* Returns the number of password bytes, excluding the line ending. */
    std::size_t size() const { return size_; }
    /* Overwrites all password storage immediately. */
    void clear() noexcept;

private:
    std::array<std::uint8_t, 4098> bytes_{};
    std::size_t size_{};
};
