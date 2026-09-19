#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace scpefe::format {

class DiagnosticJsonWriter {
public:
    void raw(const std::string &value);
    void character(char value);
    void string(const char *data, std::size_t size);
    void hex(const std::uint8_t *data, std::size_t size);
    std::string take_output();

private:
    std::string output_;
};

} // namespace scpefe::format
