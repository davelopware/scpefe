# SCPEFE

SCPEFE is a storage-neutral, cross-platform application for editing small encrypted text files. A document may live on a local disk, a network share or NAS, or cloud-backed storage; cloud-hosted files are a required capability, not a required location.

The developing requirements and design decisions are recorded in [docs/SPECIFICATION.md](docs/SPECIFICATION.md). Canonical project terminology is defined in [docs/DOMAIN_MODEL.md](docs/DOMAIN_MODEL.md). The [C++ library architecture guide](docs/CPP_LIBRARY_ARCHITECTURE.md) maps the implemented classes and their call flow; the [visual HTML architecture guide](docs/CPP_LIBRARY_ARCHITECTURE.html) includes class and user-story flow diagrams.

## Initial project scope

- Support editing the same encrypted text files across multiple devices and platforms.
- Work equally through ordinary file access with local, network, NAS, and cloud-backed storage; use Google Drive as the first cloud-storage use case.
- Target Windows, Linux, and Android mobile initially.
- Maximise shared code between platforms, ideally through a common core with platform-appropriate user interfaces.
- Allow a user to unlock and edit an encrypted file by entering a password, without having to distribute or manage separate key files.
- Support a small set of per-file password slots for invited viewers/editors, including an optional independent recovery/master password.

The selected direction is a C++20 common core with a React/TypeScript UI, Electron on Windows and Linux, and Capacitor on Android. Security-sensitive format and cryptographic details remain subject to implementation validation and independent expert review before production release.

## Native developer build

The supported native build uses CMake and produces the shared `libscpefe`
common library plus the `scpefe-diagnostic` developer CLI:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build
ctest --test-dir build --output-on-failure
./build/scpefe-diagnostic health
```

Builds embed the project and third-party licence notices for `licenses`.
CMake discovers the installed libsodium notice; pass
`-DSCPEFE_SODIUM_LICENSE_FILE=/path/to/libsodium/copyright` if your package stores
it elsewhere. The notice must belong to the libsodium version you link.

The health operation crosses the public, versioned C ABI. Its clock value comes
from a deterministic in-memory host adapter registered with that CLI's explicit
SCPEFE context.

The common core also exposes bounded C ABI functions for deterministic-CBOR
snapshot revision encoding, decoding, and diagnostic JSON. The v1 record schema
is documented in `docs/format/snapshot-revision-v1.cddl`. To inspect an encoded
already-decrypted record through the same common-core parser:

```bash
./build/scpefe-diagnostic revision snapshot.cbor
./build/scpefe-diagnostic revision snapshot.cbor --include-content
```

Snapshot content is omitted from diagnostic JSON unless `--include-content` is
explicitly supplied. This developer operation consumes a decrypted revision
record for format/conformance work; it does not accept a password or open an
encrypted container.

The common core also creates and unlocks the initial self-contained,
single-owner password container through byte-span C APIs. Passwords are never
accepted as command-line arguments. The original milestone envelope is documented in
[docs/format/password-container-v1.md](docs/format/password-container-v1.md).
Its CC0 valid and invalid interoperability vectors live under
[`tests/vectors/draft-v1`](tests/vectors/draft-v1/README.md) and are executed
through the public common-core APIs by the native test suite.

To inspect a complete encrypted container with the current core, use:

```bash
./build/scpefe-diagnostic inspect document.scpefe
secret-provider | ./build/scpefe-diagnostic inspect document.scpefe --password-stdin
./build/scpefe-diagnostic inspect document.scpefe --include-content
```

`inspect` is a read-only developer operation. By default it reads a password
from the controlling terminal without echo (the Windows console on Windows).
`--password-stdin` explicitly reads one UTF-8 line from standard input for
automation; LF and CRLF endings are removed, and a final line without LF is
accepted. Passwords are limited to 4096 bytes and are never accepted in arguments.

The CLI delegates authentication, graph validation, and JSON generation to
`scpefe_container_diagnostic_json`, a public versioned common-core API. It reads
the same revised-v3 containers as the current document API; obsolete development
v1/v2 envelopes are rejected. Success writes one JSON object to stdout containing
envelope algorithms and sizes, document ID and content type, slot identities and
permissions, editing lease, heads, revision links, attribution, hashes, and graph
validation. Reports use two-space indentation for readability. Failure returns nonzero, writes a safe `{"status":"error","code":N}`
object to stderr, and leaves stdout empty. Numeric codes are `scpefe_status` values.
Input and output are bounded; callers of the C API can supply graph resource limits.

Document text is omitted by default. **`--include-content` emits authenticated
historical text wherever still reconstructable**, which can expose earlier text
as well as the current content. Diagnostic metadata also contains personal
identities. Treat captured output accordingly. Password and temporary decrypted
buffers are cleared on completion as far as the platform permits. See the
[JSON contract](docs/format/container-diagnostic-json-v1.md) for field and omission rules.

The **Windows diagnostic preview** GitHub Actions workflow publishes
`scpefe-diagnostic-win-x64-unsigned`. Download and extract that GitHub artifact,
then copy **`scpefe-diagnostic.exe` alone** wherever you need it on Windows x64
(Intel/AMD 64-bit). There is no installer or companion application DLL requirement;
the common core, libsodium and C/C++ runtime are compiled into the executable.
This developer preview is unsigned. Build tools and Python are not needed to run it.

The artifact also contains `scpefe-diagnostic.exe.sha256`, `preview-manifest.json`
and usage notes. These are verification information, not runtime dependencies.
The manifest records the exact source commit, successful validation, system DLL
imports and SHA-256 of the validated EXE. Verify the EXE before copying or running:

```powershell
$expected = (Get-Content .\scpefe-diagnostic.exe.sha256).Split(' ')[0]
$actual = (Get-FileHash .\scpefe-diagnostic.exe -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "EXE checksum mismatch" }
.\scpefe-diagnostic.exe licenses
.\scpefe-diagnostic.exe inspect "C:\path\document.scpefe"
```

The interactive prompt hides the password. Automation supplies one UTF-8 password
line through standard input with `--password-stdin`; never put a password in
arguments. Document content is omitted unless you add `--include-content`.
`licenses` displays the embedded project and third-party notices without
requiring any licence files beside the EXE.

To build the same downloadable preview on Windows with the prerequisites below,
run `scripts\build-windows-diagnostic-preview.ps1`. It preserves the default
shared-library regression tests, builds/tests the static diagnostic, validates
only the copied EXE outside development directories with a system-only PATH,
empty working directory and private TEMP/TMP, and checks exact golden JSON,
privacy, errors and unchanged inputs. Windows directory notifications catch even
DLLs extracted and deleted during execution. Publication follows successful
validation, and the workflow downloads the artifact again to verify that its EXE
checksum and source commit match the validated manifest.

## Single-EXE Windows diagnostic build

On Windows x64 with Visual C++ (MSVC), CMake, Python 3.12 and a bootstrapped
vcpkg checkout, set `VCPKG_ROOT` and run:

```powershell
.\scripts\test-windows-static-diagnostic.ps1
.\build\windows-static-diagnostic\Release\scpefe-diagnostic.exe licenses
```

The script installs both `libsodium:x64-windows` and
`libsodium:x64-windows-static`, configures `SCPEFE_STATIC_DIAGNOSTIC=ON` with
the static library's path and licence notice, builds Release, and runs the
native suite. The diagnostic uses the same public C ABI and source code as
`libscpefe`, with the core, libsodium and release C/C++ runtime (`/MT`) linked
inside the EXE. Other targets retain the normal shared-library build and runtime,
including the default Electron bridge configuration.

The validated executable is
`build\windows-static-diagnostic\Release\scpefe-diagnostic.exe`. It can be
copied alone and needs only supported Windows system components and your input
container at runtime. Build and test tools are not runtime dependencies. Licence
notices are compiled from the maintained project, zxcvbn-c and installed libsodium
notices and are available through `licenses` with no companion files.

Validation rejects application and Visual C++ runtime DLL imports, copies only
the EXE into an isolated directory, clears the development runtime path, and
exercises health, version, revision and authenticated inspection against the
shared core's ABI and diagnostic golden vectors. Wrong passwords, malformed
containers, explicit content inclusion and privacy rules use the same regression
checks as the shared build. The Windows diagnostic preview workflow runs this
gate alongside the default shared-library regression suite before packaging the EXE.

## WebAssembly conformance build

The platform-neutral snapshot format is also compiled with Emscripten and run
under Node.js against the same valid and invalid vectors. The native and
WebAssembly conformance executables share one runner and emit the same
structured JSON result, making status and byte-for-byte encoding differences
visible:

```bash
emcmake cmake -S . -B build-wasm -DCMAKE_BUILD_TYPE=Debug
cmake --build build-wasm --target scpefe_wasm_conformance
ctest --test-dir build-wasm -R scpefe.wasm-format-conformance --output-on-failure
```

This secondary target deliberately excludes password/container cryptography,
publication, lease, and host-service behavior. Those responsibilities remain
native-only and continue to be covered by the native test suite.

## Windows desktop milestone

`apps/windows` contains the Electron/React Windows frontend for configuring a
local profile, publishing a new encrypted document, reopening it read-only, and
explicitly entering edit mode for a manual save. The sandboxed renderer sees
only validated preload operations; container bytes, native bindings, filesystem
paths, and publication remain in the Electron host. New desktop documents use
the [mutable v3 envelope](docs/format/password-container-v3.md), which is the
current native document reader's supported envelope. The separate snapshot
format APIs still read the draft v1 revision vectors.

Build the Node-API bridge alongside the native library by supplying the header
directory from the Node/Electron SDK used for packaging:

```bash
cmake -S . -B build -DSCPEFE_BUILD_NODE_ADDON=ON \
  -DNODE_API_INCLUDE_DIR=/path/to/node/include
cmake --build build
npm install
cd apps/windows
npm test
npm run build
```

On Windows, also pass `NODE_API_LIBRARY` for the matching SDK import library.
Copy the resulting `scpefe_electron_native.node` beside `apps/windows/native`
as part of packaging; production packaging details remain a release task.

The repository root is an npm workspace. `packages/frontend-core` and
`packages/react-ui` expose TypeScript source through public package entries;
the Windows frontend consumes those entries directly after a root `npm ci`,
without a package build. `npm run typecheck` at the root checks all three
workspaces. The focused TypeScript package gate is `npm run test:frontend`.
Its runner discovers nested `.test.ts` and `.test.tsx` files in both packages
and the Windows frontend, transforms them with the installed Vite Oxc
transformer, and runs them serially with Node's test runner. Typechecking
checks the same TypeScript implementation and test files separately.
On Linux, run that gate inside the required bounded user scope:

```bash
systemd-run --user --scope \
  -p MemoryHigh=768M -p MemoryMax=1G -p MemorySwapMax=0 -p TasksMax=256 \
  /usr/bin/time -v timeout --signal=TERM --kill-after=2s 60s \
  npm run test:frontend
```

The same scope limits apply to every Node/Electron renderer build and desktop
test invocation. See `docs/agents/resource-safety.md`.

For a repeatable, unsigned Windows preview build, see
[`apps/windows/README.md`](apps/windows/README.md). From a Windows checkout with
the documented prerequisites, the complete build and smoke test is one command:

```powershell
.\scripts\build-windows-preview.ps1
```

## License

SCPEFE software is licensed under [GPL-3.0-or-later](LICENSE). The public
file-format specification is CC BY 4.0, while machine-readable schemas and
interoperability vectors carry CC0 markers.
