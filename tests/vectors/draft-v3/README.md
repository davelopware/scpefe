<!-- SPDX-License-Identifier: CC0-1.0 -->

# Revised, unreleased v3 conformance vectors

These vectors describe the target [v3 grammar](../../../docs/format/password-container-v3.md),
not the old snapshot-only milestone implementation. `.hex` files contain ASCII
hexadecimal with whitespace and `#` comments ignored. All data, including
password, salts, nonces, keys, IDs, and timestamps, is deterministic **test data**;
production writers must generate fresh independent random values. The test
password for `valid/baseline-container.hex` is `correct horse battery staple`.
The fixed document ID is `101112131415161718191a1b1c1d1e1f` and the owner
slot ID is `000102030405060708090a0b0c0d0e0f`. The generator uses Python stdlib
and the system Libsodium; `python3 generate.py` regenerates all rows. The
`manifest.json` lists represented byte lengths, SHA-256 fingerprints, and
expected results. The portable payload conformance target executes the payload
rows; the native stateful C ABI test authenticates the saved checkpoint envelope.

| Vector | Expected check |
| --- | --- |
| `valid/baseline-payload.hex` | Minimal saved history, baseline only; text `alpha\n`. |
| `valid/baseline-container.hex` | Authenticate envelope and decrypt to the baseline payload. |
| `valid/delta-event.hex` | Apply byte-copy/insert delta; event advances head without changing content head. |
| `valid/pruned-checkpoint.hex` | Baseline body unavailable; original IDs unchanged; checkpoint at existing delta ID reconstructs `alpha\nbeta\n`. |
| `valid/pruned-checkpoint-container.hex` | Authenticated saved history with unavailable baseline body and reconstructable checkpoint. |
| `valid/repeated-compaction.hex` | A later compaction prunes the first cutoff's checkpoint while retaining the first compaction event and its immutable details. |
| `valid/foreign-merge.hex` | Imported foreign body is unavailable; its original ID and attribution survive; merge delta reconstructs from the canonical local parent. |
| `invalid/nonminimal-key.hex` | Reject longer-than-necessary CBOR map-key encoding. |
| `invalid/duplicate-key.hex` | Reject duplicate top-level key. |
| `invalid/timestamp-bound.hex` | Reject timestamp `2^63`. |
| `invalid/dangling-parent.hex` | Reject a well-hashed delta whose parent ID is absent. |
| `invalid/delta-out-of-range.hex` | Reject a well-hashed delta that copies outside its parent text. |
| `invalid/reconstruction-hash.hex` | Reject a well-hashed record whose declared resulting content hash is false. |
| `invalid/unsupported-codec.hex` | Reject unknown delta codec 1. |
| `invalid/text-invalid-utf8.hex` | Reject malformed UTF-8 text bytes. |
| `invalid/checkpoint-content-hash.hex` | Reject a replacement checkpoint with the wrong text. |
| `invalid/incorrect-revision-id.hex` | Reject revision ID that differs from the immutable preimage hash. |
| `invalid/pruned-without-anchor.hex` | Reject a head with no available reconstruction base. |
| `invalid/orphan-foreign.hex` | Reject imported metadata omitted from the resolving merge's source links. |
| `invalid/compaction-count.hex` | Reject a compaction event whose retained-delta count disagrees with the canonical line. |
| `invalid/unknown-required-feature.hex` | Reject unknown mandatory feature 999. |
| `invalid/envelope-slot-count-zero.hex` | Reject slot count 0 before KDF. |
| `invalid/envelope-payload-length-overflow.hex` | Reject impossible total length before KDF. |
| `invalid/envelope-wrapper-length.hex` | Reject wrapper length 65 before KDF. |

Payload rows begin at `container-v3`, excluding the preceding 16-byte document
ID. Structural envelope errors are intentionally tested without decrypting.
The portable revision graph reader checks decrypted payload rows, and the
stateful container reader authenticates the saved checkpoint vector. A reader
should verify all valid records' IDs, original body digests, content
hashes, graph links, and reconstruction, and should reject every invalid row
for the stated reason after the appropriate structural/authentication phase.
