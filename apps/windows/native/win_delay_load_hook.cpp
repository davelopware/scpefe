#ifdef _MSC_VER

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>

#include <delayimp.h>
#include <cstring>

namespace {

FARPROC WINAPI load_host_executable(unsigned int event, DelayLoadInfo *info)
{
    if (event != dliNotePreLoadLibrary) return nullptr;
    if (_stricmp(info->szDll, "node.exe") != 0) return nullptr;

    return reinterpret_cast<FARPROC>(GetModuleHandle(nullptr));
}

} // namespace

// MSVC's delay-load helper consults this hook before resolving node.exe.
decltype(__pfnDliNotifyHook2) __pfnDliNotifyHook2 = load_host_executable;

#endif
