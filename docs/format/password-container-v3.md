<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Mutable snapshot container envelope version 3

Status: implementation milestone format; independent cryptographic and format
review remains required before production release.

Version 3 has the same fields, offsets, lengths, KDF, and encryption algorithms
as the [version-2 envelope](password-container-v2.md). Readers distinguish it by
the magic `53 43 50 45 46 45 00 03` and the envelope version integer `3`.

Version 3 changes the additional authenticated data used for password-slot
wrapping so that a client holding any editor-capable slot can replace the
encrypted snapshot without knowing every other slot password. Before wrapping
or unwrapping a slot, the implementation copies the complete 160-octet header
and replaces octets 40 through 71 (the snapshot nonce and encrypted-snapshot
length) with zero. That copy is the slot's additional authenticated data. The
actual complete header remains the encrypted snapshot's additional authenticated
data.

A manual save preserves the complete slot area and the decrypted 16-octet
document ID. It generates a fresh snapshot nonce, records the new ciphertext
length, and encrypts the document ID followed by the new deterministic snapshot
revision with the existing document key. The new revision has one parent: the
32-octet generic hash of the exact previous encoded revision. This construction
keeps all password slots usable, avoids nonce reuse, and authenticates every
immutable header field. Version-2 containers remain readable but cannot be
rewritten because their slot wrappers authenticate the mutable fields.
