<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Password container envelope version 1

Status: implementation milestone format; independent cryptographic and format
review remains required before production release.

This document is the normative binary grammar for the bytes emitted by
`scpefe_password_container_create`. All multibyte integers in the envelope are
unsigned and little-endian. Sizes and offsets are in octets. No padding,
alignment octets, or trailing data are permitted.

## Binary grammar

The notation `name[n]` means exactly `n` octets. `u32le(value)` and
`u64le(value)` constrain both width and value. `opaque[n]` has no structure
visible before authentication.

```text
password-container-v1 =
    magic[8]                         ; 53 43 50 45 46 45 00 01
    u32le(envelope-version)          ; 1
    u32le(password-kdf)              ; 2 = Argon2id v1.3
    u64le(kdf-operations-limit)      ; 2
    u64le(kdf-memory-limit)          ; 67108864 octets
    owner-salt[16]
    u32le(owner-slot-aead)           ; 1 = XChaCha20-Poly1305-IETF
    owner-slot-nonce[24]
    u32le(snapshot-aead)             ; 1 = XChaCha20-Poly1305-IETF
    snapshot-nonce[24]
    u32le(wrapped-owner-slot-length) ; 65
    u64le(encrypted-snapshot-length) ; 32 + encoded-revision-length
    wrapped-owner-slot[65]
    encrypted-snapshot[encrypted-snapshot-length]

wrapped-owner-slot =
    opaque[49]                       ; encrypted owner-slot-plaintext
    owner-slot-tag[16]

encrypted-snapshot =
    opaque[encrypted-snapshot-length - 16]
    snapshot-tag[16]

owner-slot-plaintext =
    document-key[32]
    owner-slot-id[16]
    owner-permissions[1]             ; 07

snapshot-plaintext =
    document-id[16]
    encoded-snapshot-revision[encrypted-snapshot-length - 32]
```

The corresponding offset table is:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 8 | `magic` |
| 8 | 4 | `envelope-version` |
| 12 | 4 | `password-kdf` |
| 16 | 8 | `kdf-operations-limit` |
| 24 | 8 | `kdf-memory-limit` |
| 32 | 16 | `owner-salt` |
| 48 | 4 | `owner-slot-aead` |
| 52 | 24 | `owner-slot-nonce` |
| 76 | 4 | `snapshot-aead` |
| 80 | 24 | `snapshot-nonce` |
| 104 | 4 | `wrapped-owner-slot-length` |
| 108 | 8 | `encrypted-snapshot-length` |
| 116 | 65 | `wrapped-owner-slot` |
| 181 | variable | `encrypted-snapshot` |

The total container size is therefore
`181 + encrypted-snapshot-length`, or equivalently
`213 + encoded-snapshot-revision-length`. The encrypted snapshot length must be
at least 32 and must consume the exact remainder of the container.

## Cryptographic construction

The password is an uninterpreted caller-owned octet string. Argon2id v1.3 uses
the 16-octet `owner-salt`, operations limit 2, memory limit 67,108,864 octets,
and produces the 32-octet wrapping key. Empty passwords are representable;
password policy is outside this grammar.

Both AEAD operations use XChaCha20-Poly1305-IETF. The complete 116-octet header
is the additional authenticated data for both operations. The wrapped owner
slot uses `owner-slot-nonce` and the wrapping key. Its 49-octet plaintext is a
fresh random 32-octet document key, a fresh random 16-octet owner slot ID, and
the permission octet `07` (`canEdit`, `canAddPasswords`, and
`canRemovePasswords`). Bits 3 through 7 are zero.

The snapshot key is a 32-octet Libsodium `crypto_kdf` subkey derived from the
document key with subkey ID 1 and the exact eight-octet context `SCPSNAP1`.
The encrypted snapshot uses `snapshot-nonce` and contains a fresh random
16-octet permanent document ID followed by exactly one deterministic CBOR
`snapshot-revision-v1` record defined by
[`snapshot-revision-v1.cddl`](snapshot-revision-v1.cddl).

The AEAD tags are the final 16 octets of their respective ciphertexts. Salt,
nonces, document key, slot ID, and document ID are independently generated with
the cryptographic random source for every create operation.

## Reader requirements and diagnostics

Readers reject an unknown envelope version, KDF, or AEAD and any non-mandatory
KDF cost as unsupported before password derivation or payload allocation. They
must never retry allocation with weaker Argon2id parameters. Lengths and the
decrypted CBOR sizes, collection counts, and nesting depth are checked against
caller-selected limits before the corresponding allocation.

Any header mutation is authenticated even when it remains structurally valid.
Authentication failures expose no document ID, revision bytes, password,
wrapping key, document key, or partially authenticated state. Diagnostic JSON
for the decrypted revision omits document content unless explicitly requested;
it never contains password or key material.

The executable CC0 vectors and their expected common-core results are in
[`tests/vectors/draft-v1`](../../tests/vectors/draft-v1/README.md).
