<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Recoverable password container envelope version 2

Status: implementation milestone format; independent cryptographic and format
review remains required before production release.

Version 2 retains the version-1 encrypted snapshot and cryptographic parameters
but permits an independent recovery/master slot. Readers distinguish it by the
eight-byte magic `53 43 50 45 46 45 00 02`. All integers are unsigned little
endian, sizes are octets, and no trailing data or padding is permitted.

```text
recoverable-password-container-v2 =
    magic[8]
    u32le(2)                       ; envelope version
    u32le(2)                       ; Argon2id v1.3
    u64le(2)                       ; operations limit
    u64le(67108864)                ; memory limit
    u32le(slot-count)              ; 1 or 2
    u32le(1)                       ; snapshot XChaCha20-Poly1305-IETF
    snapshot-nonce[24]
    u64le(encrypted-snapshot-length)
    owner-salt[16]
    owner-nonce[24]
    u32le(65)
    recovery-salt[16]              ; zero when slot-count = 1
    recovery-nonce[24]             ; zero when slot-count = 1
    u32le(recovery-wrapped-length) ; 65 when present, otherwise 0
    owner-wrapped-slot[65]
    recovery-wrapped-slot[65]      ; present only when slot-count = 2
    encrypted-snapshot[encrypted-snapshot-length]
```

The fixed header is 160 octets. The snapshot length is at least 32 octets and
must consume the exact remainder after `160 + 65 * slot-count`. Each 65-octet
wrapped slot encrypts a 32-octet document key, a 16-octet random immutable slot
ID, and the full-administrator permission octet `07`, followed by the 16-octet
AEAD tag. Both slots wrap the same document key. A recovery slot has no identity;
the initial revision identifies the owner slot and configured local profile.

Each wrapping key uses its own salt with the exact Argon2id parameters above.
The slot nonce is selected from the corresponding header field. The 160-octet
header is additional authenticated data for every slot and for the snapshot.
The snapshot key derivation and plaintext are unchanged from version 1: Libsodium
`crypto_kdf` subkey 1 with context `SCPSNAP1`, then a random 16-octet document ID
and one deterministic `snapshot-revision-v1` record. All salts, nonces, IDs,
keys, and slot IDs are independently generated.

Readers validate the complete structure and mandatory algorithms before
allocating or deriving a password key. Normal unlock checks owner first and
recovery second and exposes only authentication failure if neither succeeds.
After authentication, the snapshot and revision must validate fully before any
semantic value is returned. Version-1 readers remain supported by the same
common-core unlock API.
