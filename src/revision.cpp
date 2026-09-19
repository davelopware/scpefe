#include "scpefe/scpefe.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <limits>
#include <new>
#include <string>
#include <vector>

struct scpefe_decoded_snapshot_revision {
    std::vector<std::uint8_t> parent_revision_ids;
    std::uint64_t timestamp_ms{};
    std::vector<std::uint8_t> slot_id;
    std::string slot_identity_name;
    std::string slot_identity_email;
    std::string client_profile_name;
    std::string client_profile_email;
    std::string device_name;
    std::vector<std::uint8_t> content_hash;
    std::string content;
};

namespace {

constexpr std::size_t default_max_input_bytes = 16u * 1024u * 1024u;
constexpr std::size_t default_max_nesting_depth = 8u;
constexpr std::size_t default_max_collection_entries = 1024u;
constexpr std::size_t default_max_text_bytes = 8u * 1024u * 1024u;
constexpr std::size_t default_max_byte_string_bytes = 1024u * 1024u;
constexpr std::size_t default_max_parent_count = 8u;

bool has_complete_limits(const scpefe_revision_limits_v1 *limits)
{
    return limits != nullptr
        && limits->struct_size >= sizeof(scpefe_revision_limits_v1);
}

bool span_is_valid(const void *data, std::size_t size)
{
    return size == 0 || data != nullptr;
}

bool valid_utf8(const char *data, std::size_t size)
{
    if (!span_is_valid(data, size)) {
        return false;
    }
    const auto *bytes = reinterpret_cast<const std::uint8_t *>(data);
    for (std::size_t index = 0; index < size;) {
        const std::uint8_t first = bytes[index++];
        if (first <= 0x7f) {
            continue;
        }
        std::size_t continuation_count = 0;
        std::uint32_t code_point = 0;
        std::uint32_t minimum = 0;
        if (first >= 0xc2 && first <= 0xdf) {
            continuation_count = 1;
            code_point = first & 0x1fu;
            minimum = 0x80u;
        } else if (first >= 0xe0 && first <= 0xef) {
            continuation_count = 2;
            code_point = first & 0x0fu;
            minimum = 0x800u;
        } else if (first >= 0xf0 && first <= 0xf4) {
            continuation_count = 3;
            code_point = first & 0x07u;
            minimum = 0x10000u;
        } else {
            return false;
        }
        if (continuation_count > size - index) {
            return false;
        }
        for (std::size_t offset = 0; offset < continuation_count; ++offset) {
            const std::uint8_t next = bytes[index++];
            if ((next & 0xc0u) != 0x80u) {
                return false;
            }
            code_point = (code_point << 6u) | (next & 0x3fu);
        }
        if (code_point < minimum || code_point > 0x10ffffu
            || (code_point >= 0xd800u && code_point <= 0xdfffu)) {
            return false;
        }
    }
    return true;
}

bool valid_canonical_document_text(const char *data, std::size_t size)
{
    if (!valid_utf8(data, size)) {
        return false;
    }
    if (size == 0) {
        return true;
    }
    const auto *bytes = reinterpret_cast<const std::uint8_t *>(data);
    if (size >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb
        && bytes[2] == 0xbf) {
        return false;
    }
    return std::find(data, data + size, '\r') == data + size;
}

class cbor_writer {
public:
    void unsigned_integer(std::uint64_t value) { head(0, value); }
    void array(std::size_t size) { head(4, size); }
    void map(std::size_t size) { head(5, size); }

    void bytes(const std::uint8_t *data, std::size_t size)
    {
        head(2, size);
        if (size != 0) {
            output_.insert(output_.end(), data, data + size);
        }
    }

    void text(const char *data, std::size_t size)
    {
        head(3, size);
        if (size != 0) {
            const auto *first = reinterpret_cast<const std::uint8_t *>(data);
            output_.insert(output_.end(), first, first + size);
        }
    }

    const std::vector<std::uint8_t> &output() const { return output_; }

private:
    void head(std::uint8_t major, std::uint64_t value)
    {
        if (value < 24) {
            output_.push_back(static_cast<std::uint8_t>((major << 5u) | value));
            return;
        }
        std::size_t bytes = value <= 0xffu ? 1 : value <= 0xffffu ? 2
            : value <= 0xffffffffu ? 4 : 8;
        const std::uint8_t info = bytes == 1 ? 24 : bytes == 2 ? 25
            : bytes == 4 ? 26 : 27;
        output_.push_back(static_cast<std::uint8_t>((major << 5u) | info));
        for (std::size_t shift = bytes; shift > 0; --shift) {
            output_.push_back(static_cast<std::uint8_t>(
                value >> ((shift - 1) * 8u)
            ));
        }
    }

    std::vector<std::uint8_t> output_;
};

struct parse_failure {
    scpefe_status status;
};

class cbor_reader {
public:
    cbor_reader(
        const std::uint8_t *data,
        std::size_t size,
        const scpefe_revision_limits_v1 &limits
    ) : data_(data), size_(size), limits_(limits) {}

    std::uint64_t unsigned_integer() { return head(0); }
    std::size_t array(std::size_t depth) { return collection(4, depth); }
    std::size_t map(std::size_t depth) { return collection(5, depth); }

    std::vector<std::uint8_t> bytes(std::size_t required_size = 0)
    {
        const std::uint64_t length = head(2);
        if (length > limits_.max_byte_string_bytes) {
            fail(SCPEFE_STATUS_LIMIT_EXCEEDED);
        }
        if (required_size != 0 && length != required_size) {
            fail(SCPEFE_STATUS_MALFORMED_CBOR);
        }
        require_available(length);
        std::vector<std::uint8_t> value(data_ + position_, data_ + position_ + length);
        position_ += static_cast<std::size_t>(length);
        return value;
    }

    std::string text()
    {
        const std::uint64_t length = head(3);
        if (length > limits_.max_text_bytes) {
            fail(SCPEFE_STATUS_LIMIT_EXCEEDED);
        }
        require_available(length);
        const char *value = reinterpret_cast<const char *>(data_ + position_);
        if (!valid_utf8(value, static_cast<std::size_t>(length))) {
            fail(SCPEFE_STATUS_MALFORMED_CBOR);
        }
        position_ += static_cast<std::size_t>(length);
        return std::string(value, static_cast<std::size_t>(length));
    }

    bool finished() const { return position_ == size_; }

private:
    [[noreturn]] static void fail(scpefe_status status) { throw parse_failure{status}; }

    void require_available(std::uint64_t count)
    {
        if (count > size_ - position_) {
            fail(SCPEFE_STATUS_MALFORMED_CBOR);
        }
    }

    std::size_t collection(std::uint8_t major, std::size_t depth)
    {
        if (depth > limits_.max_nesting_depth) {
            fail(SCPEFE_STATUS_LIMIT_EXCEEDED);
        }
        const std::uint64_t count = head(major);
        if (count > limits_.max_collection_entries
            || count > std::numeric_limits<std::size_t>::max()) {
            fail(SCPEFE_STATUS_LIMIT_EXCEEDED);
        }
        return static_cast<std::size_t>(count);
    }

    std::uint64_t head(std::uint8_t expected_major)
    {
        require_available(1);
        const std::uint8_t initial = data_[position_++];
        const std::uint8_t major = initial >> 5u;
        const std::uint8_t info = initial & 0x1fu;
        if (major != expected_major || info >= 28) {
            fail(SCPEFE_STATUS_MALFORMED_CBOR);
        }
        if (info < 24) {
            return info;
        }
        const std::size_t count = info == 24 ? 1 : info == 25 ? 2
            : info == 26 ? 4 : 8;
        require_available(count);
        std::uint64_t value = 0;
        for (std::size_t offset = 0; offset < count; ++offset) {
            value = (value << 8u) | data_[position_++];
        }
        const std::uint64_t minimum = count == 1 ? 24u : count == 2 ? 0x100u
            : count == 4 ? 0x10000u : 0x100000000ull;
        if (value < minimum) {
            fail(SCPEFE_STATUS_MALFORMED_CBOR);
        }
        return value;
    }

    const std::uint8_t *data_;
    std::size_t size_;
    std::size_t position_{};
    const scpefe_revision_limits_v1 &limits_;
};

scpefe_status validate_revision(
    const scpefe_snapshot_revision_v1 &revision,
    const scpefe_revision_limits_v1 &limits
)
{
    if (revision.struct_size < sizeof(scpefe_snapshot_revision_v1)
        || revision.format_version != SCPEFE_REVISION_FORMAT_VERSION
        || revision.slot_id_size != SCPEFE_SLOT_ID_SIZE
        || revision.content_hash_size != SCPEFE_CONTENT_HASH_SIZE
        || revision.parent_count
            > std::numeric_limits<std::size_t>::max() / SCPEFE_REVISION_ID_SIZE
        || !span_is_valid(revision.parent_revision_ids,
            revision.parent_count * SCPEFE_REVISION_ID_SIZE)
        || !span_is_valid(revision.slot_id, revision.slot_id_size)
        || !span_is_valid(revision.slot_identity_name, revision.slot_identity_name_size)
        || !span_is_valid(revision.slot_identity_email, revision.slot_identity_email_size)
        || !span_is_valid(revision.client_profile_name, revision.client_profile_name_size)
        || !span_is_valid(revision.client_profile_email, revision.client_profile_email_size)
        || !span_is_valid(revision.device_name, revision.device_name_size)
        || !span_is_valid(revision.content_hash, revision.content_hash_size)
        || !span_is_valid(revision.content, revision.content_size)) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    if (revision.parent_count > limits.max_parent_count
        || revision.parent_count > limits.max_collection_entries
        || limits.max_collection_entries < 11
        || revision.slot_identity_name_size > limits.max_text_bytes
        || revision.slot_identity_email_size > limits.max_text_bytes
        || revision.client_profile_name_size > limits.max_text_bytes
        || revision.client_profile_email_size > limits.max_text_bytes
        || revision.device_name_size > limits.max_text_bytes
        || revision.content_size > limits.max_text_bytes
        || SCPEFE_REVISION_ID_SIZE > limits.max_byte_string_bytes
        || SCPEFE_SLOT_ID_SIZE > limits.max_byte_string_bytes
        || SCPEFE_CONTENT_HASH_SIZE > limits.max_byte_string_bytes
        || limits.max_nesting_depth < 2) {
        return SCPEFE_STATUS_LIMIT_EXCEEDED;
    }
    if (!valid_utf8(revision.slot_identity_name, revision.slot_identity_name_size)
        || !valid_utf8(revision.slot_identity_email, revision.slot_identity_email_size)
        || !valid_utf8(revision.client_profile_name, revision.client_profile_name_size)
        || !valid_utf8(revision.client_profile_email, revision.client_profile_email_size)
        || !valid_utf8(revision.device_name, revision.device_name_size)
        || !valid_canonical_document_text(revision.content, revision.content_size)) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    return SCPEFE_STATUS_OK;
}

std::vector<std::uint8_t> encode_revision(const scpefe_snapshot_revision_v1 &revision)
{
    cbor_writer writer;
    writer.map(11);
    writer.unsigned_integer(1); writer.unsigned_integer(revision.format_version);
    writer.unsigned_integer(2); writer.array(revision.parent_count);
    for (std::size_t index = 0; index < revision.parent_count; ++index) {
        writer.bytes(
            revision.parent_revision_ids + index * SCPEFE_REVISION_ID_SIZE,
            SCPEFE_REVISION_ID_SIZE
        );
    }
    writer.unsigned_integer(3); writer.unsigned_integer(revision.timestamp_ms);
    writer.unsigned_integer(4); writer.bytes(revision.slot_id, revision.slot_id_size);
    writer.unsigned_integer(5); writer.text(revision.slot_identity_name, revision.slot_identity_name_size);
    writer.unsigned_integer(6); writer.text(revision.slot_identity_email, revision.slot_identity_email_size);
    writer.unsigned_integer(7); writer.text(revision.client_profile_name, revision.client_profile_name_size);
    writer.unsigned_integer(8); writer.text(revision.client_profile_email, revision.client_profile_email_size);
    writer.unsigned_integer(9); writer.text(revision.device_name, revision.device_name_size);
    writer.unsigned_integer(10); writer.bytes(revision.content_hash, revision.content_hash_size);
    writer.unsigned_integer(11); writer.map(3);
    writer.unsigned_integer(1); writer.unsigned_integer(0);
    writer.unsigned_integer(2); writer.unsigned_integer(revision.content_size);
    writer.unsigned_integer(3); writer.text(revision.content, revision.content_size);
    return writer.output();
}

void expect_key(cbor_reader &reader, std::uint64_t expected)
{
    if (reader.unsigned_integer() != expected) {
        throw parse_failure{SCPEFE_STATUS_MALFORMED_CBOR};
    }
}

scpefe_decoded_snapshot_revision decode_revision(
    const std::uint8_t *encoded,
    std::size_t encoded_size,
    const scpefe_revision_limits_v1 &limits
)
{
    cbor_reader reader(encoded, encoded_size, limits);
    if (reader.map(1) != 11) {
        throw parse_failure{SCPEFE_STATUS_MALFORMED_CBOR};
    }
    expect_key(reader, 1);
    if (reader.unsigned_integer() != SCPEFE_REVISION_FORMAT_VERSION) {
        throw parse_failure{SCPEFE_STATUS_UNSUPPORTED_FORMAT};
    }
    scpefe_decoded_snapshot_revision revision;
    expect_key(reader, 2);
    const std::size_t parent_count = reader.array(2);
    if (parent_count > limits.max_parent_count) {
        throw parse_failure{SCPEFE_STATUS_LIMIT_EXCEEDED};
    }
    if (parent_count
        > std::numeric_limits<std::size_t>::max() / SCPEFE_REVISION_ID_SIZE) {
        throw parse_failure{SCPEFE_STATUS_LIMIT_EXCEEDED};
    }
    revision.parent_revision_ids.reserve(parent_count * SCPEFE_REVISION_ID_SIZE);
    for (std::size_t index = 0; index < parent_count; ++index) {
        std::vector<std::uint8_t> parent = reader.bytes(SCPEFE_REVISION_ID_SIZE);
        revision.parent_revision_ids.insert(
            revision.parent_revision_ids.end(), parent.begin(), parent.end()
        );
    }
    expect_key(reader, 3); revision.timestamp_ms = reader.unsigned_integer();
    expect_key(reader, 4); revision.slot_id = reader.bytes(SCPEFE_SLOT_ID_SIZE);
    expect_key(reader, 5); revision.slot_identity_name = reader.text();
    expect_key(reader, 6); revision.slot_identity_email = reader.text();
    expect_key(reader, 7); revision.client_profile_name = reader.text();
    expect_key(reader, 8); revision.client_profile_email = reader.text();
    expect_key(reader, 9); revision.device_name = reader.text();
    expect_key(reader, 10); revision.content_hash = reader.bytes(SCPEFE_CONTENT_HASH_SIZE);
    expect_key(reader, 11);
    if (reader.map(2) != 3) {
        throw parse_failure{SCPEFE_STATUS_MALFORMED_CBOR};
    }
    expect_key(reader, 1);
    if (reader.unsigned_integer() != 0) {
        throw parse_failure{SCPEFE_STATUS_UNSUPPORTED_FORMAT};
    }
    expect_key(reader, 2);
    const std::uint64_t uncompressed_size = reader.unsigned_integer();
    expect_key(reader, 3); revision.content = reader.text();
    if (uncompressed_size != revision.content.size()
        || !valid_canonical_document_text(
            revision.content.data(), revision.content.size()
        )
        || !reader.finished()) {
        throw parse_failure{SCPEFE_STATUS_MALFORMED_CBOR};
    }
    return revision;
}

void append_json_string(std::string &json, const char *data, std::size_t size)
{
    static constexpr char hex[] = "0123456789abcdef";
    json.push_back('"');
    for (std::size_t index = 0; index < size; ++index) {
        const unsigned char value = static_cast<unsigned char>(data[index]);
        switch (value) {
        case '"': json += "\\\""; break;
        case '\\': json += "\\\\"; break;
        case '\b': json += "\\b"; break;
        case '\f': json += "\\f"; break;
        case '\n': json += "\\n"; break;
        case '\r': json += "\\r"; break;
        case '\t': json += "\\t"; break;
        default:
            if (value < 0x20) {
                json += "\\u00";
                json.push_back(hex[value >> 4u]);
                json.push_back(hex[value & 0x0fu]);
            } else {
                json.push_back(static_cast<char>(value));
            }
        }
    }
    json.push_back('"');
}

void append_hex(std::string &json, const std::uint8_t *data, std::size_t size)
{
    static constexpr char hex[] = "0123456789abcdef";
    json.push_back('"');
    for (std::size_t index = 0; index < size; ++index) {
        json.push_back(hex[data[index] >> 4u]);
        json.push_back(hex[data[index] & 0x0fu]);
    }
    json.push_back('"');
}

std::string diagnostic_json(
    const scpefe_decoded_snapshot_revision &revision,
    bool include_content
)
{
    std::string json = "{\"format_version\":1,\"parent_revision_ids\":[";
    const std::size_t parent_count = revision.parent_revision_ids.size()
        / SCPEFE_REVISION_ID_SIZE;
    for (std::size_t index = 0; index < parent_count; ++index) {
        if (index != 0) json.push_back(',');
        append_hex(json, revision.parent_revision_ids.data()
            + index * SCPEFE_REVISION_ID_SIZE, SCPEFE_REVISION_ID_SIZE);
    }
    json += "],\"timestamp_ms\":" + std::to_string(revision.timestamp_ms);
    json += ",\"slot_id\":"; append_hex(json, revision.slot_id.data(), revision.slot_id.size());
    json += ",\"slot_identity_name\":"; append_json_string(json, revision.slot_identity_name.data(), revision.slot_identity_name.size());
    json += ",\"slot_identity_email\":"; append_json_string(json, revision.slot_identity_email.data(), revision.slot_identity_email.size());
    json += ",\"client_profile_name\":"; append_json_string(json, revision.client_profile_name.data(), revision.client_profile_name.size());
    json += ",\"client_profile_email\":"; append_json_string(json, revision.client_profile_email.data(), revision.client_profile_email.size());
    json += ",\"device_name\":"; append_json_string(json, revision.device_name.data(), revision.device_name.size());
    json += ",\"content_hash\":"; append_hex(json, revision.content_hash.data(), revision.content_hash.size());
    json += ",\"snapshot\":{\"codec\":\"none\",\"uncompressed_length\":"
        + std::to_string(revision.content.size());
    if (include_content) {
        json += ",\"content\":";
        append_json_string(json, revision.content.data(), revision.content.size());
    }
    json += "}}";
    return json;
}

} // namespace

scpefe_status scpefe_revision_limits_default(scpefe_revision_limits_v1 *limits)
{
    if (limits == nullptr
        || limits->struct_size < sizeof(scpefe_revision_limits_v1)) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    *limits = scpefe_revision_limits_v1{
        sizeof(scpefe_revision_limits_v1),
        default_max_input_bytes,
        default_max_nesting_depth,
        default_max_collection_entries,
        default_max_text_bytes,
        default_max_byte_string_bytes,
        default_max_parent_count,
    };
    return SCPEFE_STATUS_OK;
}

scpefe_status scpefe_snapshot_revision_encode(
    const scpefe_snapshot_revision_v1 *revision,
    const scpefe_revision_limits_v1 *limits,
    std::uint8_t *output,
    std::size_t output_capacity,
    std::size_t *output_size
)
{
    if (revision == nullptr || !has_complete_limits(limits)
        || output_size == nullptr) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    const scpefe_status validation = validate_revision(*revision, *limits);
    if (validation != SCPEFE_STATUS_OK) {
        return validation;
    }
    try {
        const std::vector<std::uint8_t> encoded = encode_revision(*revision);
        if (encoded.size() > limits->max_input_bytes) {
            return SCPEFE_STATUS_LIMIT_EXCEEDED;
        }
        *output_size = encoded.size();
        if (output == nullptr || output_capacity < encoded.size()) {
            return SCPEFE_STATUS_BUFFER_TOO_SMALL;
        }
        std::memcpy(output, encoded.data(), encoded.size());
        return SCPEFE_STATUS_OK;
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_snapshot_revision_decode(
    const std::uint8_t *encoded,
    std::size_t encoded_size,
    const scpefe_revision_limits_v1 *limits,
    scpefe_decoded_snapshot_revision **revision
)
{
    if (!span_is_valid(encoded, encoded_size) || encoded_size == 0
        || !has_complete_limits(limits) || revision == nullptr) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    *revision = nullptr;
    if (encoded_size > limits->max_input_bytes) {
        return SCPEFE_STATUS_LIMIT_EXCEEDED;
    }
    try {
        auto decoded = decode_revision(encoded, encoded_size, *limits);
        auto *owned = new (std::nothrow) scpefe_decoded_snapshot_revision(
            std::move(decoded)
        );
        if (owned == nullptr) {
            return SCPEFE_STATUS_OUT_OF_MEMORY;
        }
        *revision = owned;
        return SCPEFE_STATUS_OK;
    } catch (const parse_failure &failure) {
        return failure.status;
    } catch (const std::bad_alloc &) {
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}

scpefe_status scpefe_decoded_snapshot_revision_view(
    const scpefe_decoded_snapshot_revision *revision,
    scpefe_snapshot_revision_v1 *view
)
{
    if (revision == nullptr || view == nullptr
        || view->struct_size < sizeof(scpefe_snapshot_revision_v1)) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    const std::uint32_t struct_size = view->struct_size;
    *view = scpefe_snapshot_revision_v1{
        struct_size,
        SCPEFE_REVISION_FORMAT_VERSION,
        revision->parent_revision_ids.data(),
        revision->parent_revision_ids.size() / SCPEFE_REVISION_ID_SIZE,
        revision->timestamp_ms,
        revision->slot_id.data(),
        revision->slot_id.size(),
        revision->slot_identity_name.data(),
        revision->slot_identity_name.size(),
        revision->slot_identity_email.data(),
        revision->slot_identity_email.size(),
        revision->client_profile_name.data(),
        revision->client_profile_name.size(),
        revision->client_profile_email.data(),
        revision->client_profile_email.size(),
        revision->device_name.data(),
        revision->device_name.size(),
        revision->content_hash.data(),
        revision->content_hash.size(),
        revision->content.data(),
        revision->content.size(),
    };
    return SCPEFE_STATUS_OK;
}

void scpefe_decoded_snapshot_revision_destroy(
    scpefe_decoded_snapshot_revision *revision
)
{
    delete revision;
}

scpefe_status scpefe_snapshot_revision_diagnostic_json(
    const std::uint8_t *encoded,
    std::size_t encoded_size,
    const scpefe_revision_limits_v1 *limits,
    int include_content,
    char *output,
    std::size_t output_capacity,
    std::size_t *output_size
)
{
    if (output_size == nullptr) {
        return SCPEFE_STATUS_INVALID_ARGUMENT;
    }
    scpefe_decoded_snapshot_revision *decoded = nullptr;
    const scpefe_status decode_status = scpefe_snapshot_revision_decode(
        encoded, encoded_size, limits, &decoded
    );
    if (decode_status != SCPEFE_STATUS_OK) {
        return decode_status;
    }
    try {
        const std::string json = diagnostic_json(*decoded, include_content != 0);
        scpefe_decoded_snapshot_revision_destroy(decoded);
        *output_size = json.size();
        if (output == nullptr || output_capacity <= json.size()) {
            return SCPEFE_STATUS_BUFFER_TOO_SMALL;
        }
        std::memcpy(output, json.data(), json.size());
        output[json.size()] = '\0';
        return SCPEFE_STATUS_OK;
    } catch (const std::bad_alloc &) {
        scpefe_decoded_snapshot_revision_destroy(decoded);
        return SCPEFE_STATUS_OUT_OF_MEMORY;
    }
}
