# Windows desktop preview

The desktop preview is suitable for hands-on development testing. It supports
profile setup, creation and reopening of encrypted documents, explicit edit
mode and manual save, backup, invitations, recovery journals, authenticated
head warnings, optional regular provisional saves, and plaintext export. It is
not a production release: the ZIP
is unsigned, has no installer or automatic updater, and the cryptographic and
storage behavior still requires security and release review.

The Windows preview workflow also launches the packaged executable as multiple
real processes to verify startup request staging, ordered single-instance
routing and focus handoff, and the safe timeout for an unresponsive primary.

## Prerequisites

- 64-bit Windows 10 or later.
- Visual Studio 2022 Build Tools or later (or the matching Visual Studio) with **Desktop
  development with C++** and the Windows SDK.
- CMake 3.20 or later on `PATH`.
- Node.js 22.12 or later with npm on `PATH`.
- A vcpkg checkout. Set `VCPKG_ROOT` to its directory. The script also accepts
  the `VCPKG_INSTALLATION_ROOT` variable provided by GitHub-hosted runners.
- Internet access on the first build so npm, vcpkg, and the matching Electron
  headers/import library can be obtained.

Run this from the repository root in PowerShell:

```powershell
.\scripts\build-windows-preview.ps1
```

The command installs locked npm dependencies, installs `libsodium:x64-windows`
with vcpkg, builds and tests the C++ library and Node-API bridge, builds and
type-checks the renderer and preload, verifies the staged bridge under Electron,
and writes:

```text
apps\windows\release\SCPEFE-win32-x64\SCPEFE.exe
apps\windows\release\SCPEFE-win32-x64.zip
```

Pass `-Launch` to open the staged app after a successful build. During UI-only
iteration after one full build, `cd apps/windows; npm run build; npm start`
provides a developer launch using the already staged native DLLs. Re-run the
full script whenever the native code, Electron version, or native dependencies
change.

For a faster artifact intended only for hands-on inspection, dispatch the
**Windows preview** workflow with **Build an unvalidated artifact for manual
testing only** enabled. This runs the same native, renderer, preload, and ZIP
build but skips every automated test gate. GitHub labels its artifact
`SCPEFE-win32-x64-unsigned-manual-untested` so it cannot be mistaken for a
validated preview. The equivalent local command is:

```powershell
.\scripts\build-windows-preview.ps1 -SkipTests
```

Windows SmartScreen may warn about the preview because it is deliberately
unsigned. Do not distribute it as a release. Code signing and an installer are
separate release-engineering work.
