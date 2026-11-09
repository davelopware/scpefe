#include <jni.h>
#include <sodium.h>

#include "scpefe/scpefe.h"

#include <chrono>
#include <cstdint>
#include <memory>
#include <mutex>
#include <new>
#include <unordered_map>
#include <vector>

namespace {

// Owns a JNI copy and clears even failed password and content requests.
struct Bytes {
    std::vector<uint8_t> value;
    ~Bytes() { if (!value.empty()) sodium_memzero(value.data(), value.size()); }
};

// Owns the C ABI context and its sole active container.
struct Session {
    std::mutex mutex;
    scpefe_context *context = nullptr;
    scpefe_container *container = nullptr;
    ~Session() {
        if (container) scpefe_container_close(container);
        scpefe_context_destroy(context);
    }
};

std::mutex sessions_mutex;
std::unordered_map<jlong, std::shared_ptr<Session>> sessions;
jlong next_handle = 1;

scpefe_status read_clock(void *, uint64_t *value) {
    if (!value) return SCPEFE_STATUS_INVALID_ARGUMENT;
    const auto now = std::chrono::steady_clock::now().time_since_epoch();
    *value = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(now).count());
    return SCPEFE_STATUS_OK;
}

std::shared_ptr<Session> lookup(jlong handle) {
    std::lock_guard lock(sessions_mutex);
    const auto it = sessions.find(handle);
    return it == sessions.end() ? nullptr : it->second;
}

bool copy_array(JNIEnv *env, jbyteArray source, Bytes &destination) {
    if (!source) return false;
    const jsize size = env->GetArrayLength(source);
    destination.value.resize(static_cast<size_t>(size));
    if (size) {
        env->GetByteArrayRegion(source, 0, size,
            reinterpret_cast<jbyte *>(destination.value.data()));
    }
    return !env->ExceptionCheck();
}

jobject result(JNIEnv *env, scpefe_status status, jlong handle = 0,
               const uint8_t *data = nullptr, size_t size = 0,
               const uint8_t *document_id = nullptr) {
    jclass type = env->FindClass("org/scpefe/nativecore/NativeCore$Result");
    if (!type) return nullptr;
    jmethodID constructor = env->GetMethodID(type, "<init>", "(IJ[B[B)V");
    if (!constructor) return nullptr;
    jbyteArray content = nullptr;
    jbyteArray id = nullptr;
    if (data) {
        content = env->NewByteArray(static_cast<jsize>(size));
        if (!content) return nullptr;
        if (size) env->SetByteArrayRegion(content, 0, static_cast<jsize>(size),
            reinterpret_cast<const jbyte *>(data));
    }
    if (document_id) {
        id = env->NewByteArray(SCPEFE_DOCUMENT_ID_SIZE);
        if (!id) return nullptr;
        env->SetByteArrayRegion(id, 0, SCPEFE_DOCUMENT_ID_SIZE,
            reinterpret_cast<const jbyte *>(document_id));
    }
    if (env->ExceptionCheck()) return nullptr;
    return env->NewObject(type, constructor, static_cast<jint>(status), handle, content, id);
}

jobject failure(JNIEnv *env) {
    return result(env, SCPEFE_STATUS_OUT_OF_MEMORY);
}

} // namespace

extern "C" JNIEXPORT jobject JNICALL
Java_org_scpefe_nativecore_NativeCore_nativeCreateContext(JNIEnv *env, jclass) {
    try {
        auto session = std::make_shared<Session>();
        const scpefe_host_services_v1 host = {
            sizeof(host), SCPEFE_ABI_VERSION, nullptr, read_clock};
        const auto status = scpefe_context_create(&host, &session->context);
        if (status != SCPEFE_STATUS_OK) return result(env, status);
        jlong handle;
        {
            std::lock_guard lock(sessions_mutex);
            handle = next_handle++;
        }
        // A failed class lookup or Java constructor must leave the context
        // owned here, so Session's destructor closes it on the null return.
        jobject created = result(env, SCPEFE_STATUS_OK, handle);
        if (!created) return nullptr;
        {
            std::lock_guard lock(sessions_mutex);
            sessions.emplace(handle, std::move(session));
        }
        return created;
    } catch (const std::bad_alloc &) { return failure(env); }
}

extern "C" JNIEXPORT jobject JNICALL
Java_org_scpefe_nativecore_NativeCore_nativeCloseContext(JNIEnv *env, jclass, jlong handle) {
    std::shared_ptr<Session> removed;
    {
        std::lock_guard lock(sessions_mutex);
        const auto it = sessions.find(handle);
        if (it == sessions.end()) return result(env, SCPEFE_STATUS_INVALID_STATE);
        removed = std::move(it->second);
        sessions.erase(it);
    }
    // An in-flight operation holds a shared owner; destruction follows its return.
    removed.reset();
    return result(env, SCPEFE_STATUS_OK);
}

extern "C" JNIEXPORT jint JNICALL
Java_org_scpefe_nativecore_NativeCore_nativeActiveContextCount(JNIEnv *, jclass) {
    std::lock_guard lock(sessions_mutex);
    return static_cast<jint>(sessions.size());
}

extern "C" JNIEXPORT jobject JNICALL
Java_org_scpefe_nativecore_NativeCore_nativeOpen(JNIEnv *env, jclass,
                                                 jlong handle, jbyteArray encrypted) {
    try {
        const auto session = lookup(handle);
        if (!session) return result(env, SCPEFE_STATUS_INVALID_STATE);
        Bytes bytes;
        if (!copy_array(env, encrypted, bytes)) {
            return env->ExceptionCheck() ? nullptr : result(env, SCPEFE_STATUS_INVALID_ARGUMENT);
        }
        std::lock_guard lock(session->mutex);
        scpefe_container *opened = nullptr;
        const scpefe_container_open_v1 request = {
            sizeof(request), SCPEFE_ABI_VERSION, bytes.value.data(), bytes.value.size()};
        const auto status = scpefe_container_open(session->context, &request, &opened);
        if (status == SCPEFE_STATUS_OK) session->container = opened;
        return result(env, status);
    } catch (const std::bad_alloc &) { return failure(env); }
}

extern "C" JNIEXPORT jobject JNICALL
Java_org_scpefe_nativecore_NativeCore_nativeUnlock(JNIEnv *env, jclass,
                                                   jlong handle, jbyteArray password) {
    try {
        const auto session = lookup(handle);
        if (!session) return result(env, SCPEFE_STATUS_INVALID_STATE);
        Bytes bytes;
        if (!copy_array(env, password, bytes)) {
            return env->ExceptionCheck() ? nullptr : result(env, SCPEFE_STATUS_INVALID_ARGUMENT);
        }
        std::lock_guard lock(session->mutex);
        if (!session->container) return result(env, SCPEFE_STATUS_INVALID_STATE);
        const scpefe_password_input_v1 request = {
            sizeof(request), SCPEFE_ABI_VERSION, bytes.value.data(), bytes.value.size()};
        return result(env, scpefe_container_unlock(session->container, &request));
    } catch (const std::bad_alloc &) { return failure(env); }
}

extern "C" JNIEXPORT jobject JNICALL
Java_org_scpefe_nativecore_NativeCore_nativeCreateDocument(
    JNIEnv *env, jclass, jlong handle, jbyteArray name, jbyteArray email,
    jbyteArray device, jbyteArray content, jlong timestamp,
    jbyteArray password, jint content_type) {
    try {
        const auto session = lookup(handle);
        if (!session) return result(env, SCPEFE_STATUS_INVALID_STATE);
        if (content_type < 0 || content_type > 255)
            return result(env, SCPEFE_STATUS_INVALID_ARGUMENT);
        Bytes name_bytes, email_bytes, device_bytes, content_bytes, password_bytes;
        if (!copy_array(env, name, name_bytes) || !copy_array(env, email, email_bytes)
            || !copy_array(env, device, device_bytes)
            || !copy_array(env, content, content_bytes)
            || !copy_array(env, password, password_bytes)) {
            return env->ExceptionCheck() ? nullptr : result(env, SCPEFE_STATUS_INVALID_ARGUMENT);
        }
        scpefe_container_create_v1 request{};
        request.struct_size = sizeof(request);
        request.abi_version = SCPEFE_ABI_VERSION;
        auto &document = request.document;
        document.struct_size = sizeof(document);
        document.profile_name = reinterpret_cast<const char *>(name_bytes.value.data());
        document.profile_name_size = name_bytes.value.size();
        document.profile_email = reinterpret_cast<const char *>(email_bytes.value.data());
        document.profile_email_size = email_bytes.value.size();
        document.device_name = reinterpret_cast<const char *>(device_bytes.value.data());
        document.device_name_size = device_bytes.value.size();
        document.content = reinterpret_cast<const char *>(content_bytes.value.data());
        document.content_size = content_bytes.value.size();
        document.timestamp_ms = static_cast<uint64_t>(timestamp);
        document.owner_password = password_bytes.value.data();
        document.owner_password_size = password_bytes.value.size();
        document.content_type = static_cast<uint8_t>(content_type);
        std::lock_guard lock(session->mutex);
        scpefe_container *created = nullptr;
        const auto status = scpefe_container_create(session->context, &request, &created);
        if (status == SCPEFE_STATUS_OK) session->container = created;
        return result(env, status);
    } catch (const std::bad_alloc &) { return failure(env); }
}

extern "C" JNIEXPORT jobject JNICALL
Java_org_scpefe_nativecore_NativeCore_nativeRead(JNIEnv *env, jclass, jlong handle) {
    const auto session = lookup(handle);
    if (!session) return result(env, SCPEFE_STATUS_INVALID_STATE);
    std::lock_guard lock(session->mutex);
    if (!session->container) return result(env, SCPEFE_STATUS_INVALID_STATE);
    scpefe_owned_snapshot *raw = nullptr;
    const auto status = scpefe_container_read(session->container, &raw);
    if (status != SCPEFE_STATUS_OK) return result(env, status);
    const std::unique_ptr<scpefe_owned_snapshot,
        decltype(&scpefe_owned_snapshot_destroy)> snapshot(
            raw, scpefe_owned_snapshot_destroy);
    scpefe_owned_snapshot_view_v1 view{};
    view.struct_size = sizeof(view);
    view.abi_version = SCPEFE_ABI_VERSION;
    const auto view_status = scpefe_owned_snapshot_view(snapshot.get(), &view);
    if (view_status != SCPEFE_STATUS_OK) return result(env, view_status);
    return result(env, SCPEFE_STATUS_OK, 0,
                  reinterpret_cast<const uint8_t *>(view.content), view.content_size,
                  view.document_id);
}

extern "C" JNIEXPORT jobject JNICALL
Java_org_scpefe_nativecore_NativeCore_nativeCloseContainer(JNIEnv *env, jclass,
                                                            jlong handle) {
    const auto session = lookup(handle);
    if (!session) return result(env, SCPEFE_STATUS_INVALID_STATE);
    std::lock_guard lock(session->mutex);
    if (!session->container) return result(env, SCPEFE_STATUS_INVALID_STATE);
    const auto status = scpefe_container_close(session->container);
    if (status == SCPEFE_STATUS_OK) session->container = nullptr;
    return result(env, status);
}
