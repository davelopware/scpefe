#pragma once

#include <cstddef>

namespace scpefe::format {

bool span_is_valid(const void *data, std::size_t size);
bool valid_utf8(const char *data, std::size_t size);
bool valid_canonical_document_text(const char *data, std::size_t size);

} // namespace scpefe::format
