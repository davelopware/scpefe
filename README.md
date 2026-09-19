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
