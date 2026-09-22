<!-- SPDX-License-Identifier: CC0-1.0 -->

# SCPEFE draft-v1 conformance vectors

These interoperability vectors are dedicated to the public domain under
CC0-1.0. Each `.hex` file is ASCII hexadecimal; whitespace is ignored and is
not part of the represented byte string.

The executable `scpefe.format-contract` test reads these files and submits the
represented bytes to the same public common-core C APIs used by applications.
It does not contain a second parser.

The native and WebAssembly snapshot conformance targets run the snapshot rows
through one shared runner and emit equivalent structured JSON results. Password
container rows are native-only; publication, lease, and host behavior are also
outside the WebAssembly target.

| Vector | API | Expected result |
|---|---|---|
| `valid/snapshot-revision.hex` | snapshot decode, encode, diagnostic JSON | success; byte-identical re-encoding |
| `invalid/snapshot-unsupported-version.hex` | snapshot decode | `SCPEFE_STATUS_UNSUPPORTED_FORMAT` |
| `invalid/snapshot-duplicate-key.hex` | snapshot decode | `SCPEFE_STATUS_MALFORMED_CBOR` |
| `invalid/snapshot-invalid-utf8.hex` | snapshot decode | `SCPEFE_STATUS_MALFORMED_CBOR` |
| `invalid/snapshot-trailing-data.hex` | snapshot decode | `SCPEFE_STATUS_MALFORMED_CBOR` |
| `valid/password-container.hex` | password-container unlock | success with password `correct horse battery staple` |
| `invalid/container-bad-magic.hex` | password-container unlock | `SCPEFE_STATUS_MALFORMED_CONTAINER` |
| `invalid/container-corrupt-tag.hex` | password-container unlock | `SCPEFE_STATUS_AUTHENTICATION_FAILED` |

The valid container contains the valid snapshot vector. Its random values are
fixed test data, not values implementations should reproduce. Implementations
must generate fresh randomness when creating containers.
