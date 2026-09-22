#pragma once

#include <cstddef>

namespace scpefe::format {

/* Checks whether a pointer/size pair denotes a valid possibly-empty span. */
bool span_is_valid(const void *data, std::size_t size);
/* Checks strict UTF-8 validity without normalizing the input. */
bool valid_utf8(const char *data, std::size_t size);
/* Checks UTF-8 document text for no BOM and LF-only line endings. */
bool valid_canonical_document_text(const char *data, std::size_t size);

} // namespace scpefe::format
