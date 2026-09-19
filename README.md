# SCPEFE

SCPEFE is a storage-neutral, cross-platform application for editing small encrypted text files. A document may live on a local disk, a network share or NAS, or cloud-backed storage; cloud-hosted files are a required capability, not a required location.

The developing requirements and design decisions are recorded in [docs/SPECIFICATION.md](docs/SPECIFICATION.md). Canonical project terminology is defined in [docs/DOMAIN_MODEL.md](docs/DOMAIN_MODEL.md).

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
accepted as command-line arguments. The milestone envelope is documented in
[docs/format/password-container-v1.md](docs/format/password-container-v1.md).
Its CC0 valid and invalid interoperability vectors live under
[`tests/vectors/draft-v1`](tests/vectors/draft-v1/README.md) and are executed
through the public common-core APIs by the native test suite.

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
local profile, publishing a new encrypted document, and reopening it read-only.
The sandboxed renderer sees only four validated preload operations; passwords,
container bytes, native bindings, filesystem paths, and publication remain in
the Electron host. New desktop documents use the backward-compatible
[recoverable v2 envelope](docs/format/password-container-v2.md), while the core
continues to read the draft v1 vectors.

Build the Node-API bridge alongside the native library by supplying the header
directory from the Node/Electron SDK used for packaging:

```bash
cmake -S . -B build -DSCPEFE_BUILD_NODE_ADDON=ON \
  -DNODE_API_INCLUDE_DIR=/path/to/node/include
cmake --build build
cd apps/windows
npm install
npm test
npm run build
```

On Windows, also pass `NODE_API_LIBRARY` for the matching SDK import library.
Copy the resulting `scpefe_electron_native.node` beside `apps/windows/native`
as part of packaging; production packaging details remain a release task.
