#include "format/clear_buffer_on_exit.hpp"
#include "format/clear_memory.hpp"

namespace scpefe::format {

ClearBufferOnExit::ClearBufferOnExit(std::string &buffer) noexcept
    : buffer_(&buffer), clear_([](void *value) noexcept {
        auto &text = *static_cast<std::string *>(value);
        clear_memory(text.data(), text.size());
    }) {}

ClearBufferOnExit::ClearBufferOnExit(std::vector<std::uint8_t> &buffer) noexcept
    : buffer_(&buffer), clear_([](void *value) noexcept {
        auto &bytes = *static_cast<std::vector<std::uint8_t> *>(value);
        clear_memory(bytes.data(), bytes.size());
    }) {}

ClearBufferOnExit::ClearBufferOnExit(std::optional<std::string> &buffer) noexcept
    : buffer_(&buffer), clear_([](void *value) noexcept {
        auto &text = *static_cast<std::optional<std::string> *>(value);
        if (text) clear_memory(text->data(), text->size());
    }) {}

ClearBufferOnExit::~ClearBufferOnExit() { clear(); }

void ClearBufferOnExit::clear() const noexcept { clear_(buffer_); }

} // namespace scpefe::format
