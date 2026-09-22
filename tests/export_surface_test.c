#include <stdio.h>

#if defined(_WIN32)
#    include <windows.h>
typedef HMODULE library_handle;
typedef FARPROC symbol_pointer;

static library_handle open_library(const char *path)
{
    return LoadLibraryA(path);
}

static symbol_pointer find_symbol(library_handle library, const char *name)
{
    return GetProcAddress(library, name);
}

static void close_library(library_handle library)
{
    FreeLibrary(library);
}
#else
#    include <dlfcn.h>
typedef void *library_handle;
typedef void *symbol_pointer;

static library_handle open_library(const char *path)
{
    return dlopen(path, RTLD_NOW | RTLD_LOCAL);
}

static symbol_pointer find_symbol(library_handle library, const char *name)
{
    return dlsym(library, name);
}

static void close_library(library_handle library)
{
    dlclose(library);
}
#endif

int main(int argc, char **argv)
{
    static const char *required[] = {
        "scpefe_abi_version",
        "scpefe_context_create",
        "scpefe_context_destroy",
        "scpefe_context_health",
        "scpefe_decoded_snapshot_revision_destroy",
        "scpefe_decoded_snapshot_revision_view",
        "scpefe_library_version",
        "scpefe_manual_save",
        "scpefe_compact_document",
        "scpefe_merge_save",
        "scpefe_new_document_create",
        "scpefe_provisional_save_discard",
        "scpefe_regular_save",
        "scpefe_password_container_change_password",
        "scpefe_password_container_add_invitation",
        "scpefe_password_container_claim_invitation",
        "scpefe_password_container_update_slot_permissions",
        "scpefe_password_container_remove_slot",
        "scpefe_password_container_reconcile_identity",
        "scpefe_password_container_create",
        "scpefe_password_container_unlock",
        "scpefe_password_container_unlock_with_limits",
        "scpefe_revision_limits_default",
        "scpefe_snapshot_revision_decode",
        "scpefe_snapshot_revision_diagnostic_json",
        "scpefe_snapshot_revision_encode",
        "scpefe_unlocked_container_destroy",
        "scpefe_unlocked_container_slot_access",
        "scpefe_unlocked_container_managed_slot_count",
        "scpefe_unlocked_container_managed_slot",
        "scpefe_unlocked_container_view",
    };
    static const char *internal[] = {
        "ZxcvbnMatch",
        "ZxcvbnFreeInfo",
    };
    size_t index;
    if (argc != 2) return 2;
    library_handle library = open_library(argv[1]);
    if (library == NULL) {
        fprintf(stderr, "could not load shared library\n");
        return 3;
    }
    for (index = 0; index < sizeof(required) / sizeof(required[0]); ++index) {
        if (find_symbol(library, required[index]) == NULL) {
            fprintf(stderr, "missing public symbol: %s\n", required[index]);
            close_library(library);
            return 4;
        }
    }
    for (index = 0; index < sizeof(internal) / sizeof(internal[0]); ++index) {
        if (find_symbol(library, internal[index]) != NULL) {
            fprintf(stderr, "internal symbol is public: %s\n", internal[index]);
            close_library(library);
            return 5;
        }
    }
    close_library(library);
    return 0;
}
