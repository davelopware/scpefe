<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Password container version 3 (pre-release revision)

Status: normative target for the unreleased v3 writer and reader. Independent
cryptographic and format review remains a production gate. This replaces the
older snapshot-only v3 milestone grammar, including its `SCPMIG01`, `SCPINV02`,
`SCPINV03`, `SCPLEAS1`, and `SCPOWN01` payload extensions. The version remains 3
because no v3 format has been released. The machine-readable grammar and vectors
are [here](password-container-v3.cddl) and [here](../../tests/vectors/draft-v3/README.md).

Unreleased v1/v2 container reading and v2 migration are **outside this refactor**.
Only the revised v3 is required of the replacement API. The old milestone API
and its draft-v1 vectors may coexist during implementation; they do not define
this revised grammar. After a stable format is released, its read support must
be retained.

## Outer envelope

All envelope integers are unsigned little endian. Sizes and offsets are octets.
No padding or trailing bytes are allowed. The envelope exposes only the bytes
needed to recognize, bound, and decrypt the file. Semantic slot identity,
permissions, document identity, lease, content, and history are encrypted.

| Offset | Size | Field and required value |
| ---: | ---: | --- |
| 0 | 8 | magic `53 43 50 45 46 45 00 03` |
| 8 | 4 | envelope version `3` |
| 12 | 4 | KDF `2` (Argon2id v1.3) |
| 16 | 8 | KDF operations `2` |
| 24 | 8 | KDF memory `67108864` bytes |
| 32 | 4 | slot count, `1..9` |
| 36 | 4 | payload AEAD `1` (XChaCha20-Poly1305-IETF) |
| 40 | 24 | fresh payload nonce |
| 64 | 8 | payload ciphertext length, at least `34` |
| 72 | `110 * slot count` | ordered slot records |
| `72 + 110 * slot count` | payload ciphertext length | encrypted payload, including its 16-byte tag |

Each slot record is `salt[16] || nonce[24] || u32le(66) || wrapped[66]`.
The wrapped plaintext is `document-key[32] || slot-id[16] ||
permission-bits[1] || must-be-changed[1]`; the last octet is 0 or 1.
Permission bits 0..2 are edit, add-password, and remove-password; other bits
must be zero. Slot 0 is the permanent owner. At most seven ordinary slots follow,
then an optional permanent recovery slot. The owner and recovery wrappers have
permission bits `07`. The corresponding encrypted slot metadata identifies
ordinary versus recovery slots. Salt/nonce pairs must be unique within the
container. Writers put the same document key in every wrapper; a reader verifies
each wrapper it authenticates against the payload, without requiring the other
slot passwords.
Slot table order is stable for copied wrappers. Deletion closes the gap without
changing the remaining wrappers.

The fixed header is exactly 72 bytes, so total size is exactly
`72 + 110 * slot-count + payload-ciphertext-length`, checked with overflow-safe
arithmetic and caller-selected allocation limits before KDF or payload allocation.
Unknown magic, version, KDF, AEAD, KDF cost, or wrapper length is unsupported;
malformed lengths/counts are rejected before password derivation. No fallback
to weaker KDF parameters is permitted. The password is an uninterpreted caller
owned byte sequence; password policy is outside the grammar.

Every slot uses Argon2id v1.3 with its independent 16-byte salt, the fixed cost
above, and a 32-byte output key. Its XChaCha20-Poly1305-IETF additional
authenticated data (AAD) is the exact ASCII bytes `SCPEFE-slot-v3` followed by
header bytes 0..31 and 36..39, then that record's 16-byte salt and 24-byte
nonce. The mutable count, payload nonce/length, and other wrappers are absent
from slot AAD so an administrator can copy unknown-password wrappers unchanged.
The slot ciphertext tag occupies its final 16 bytes. Purpose separation and
record salt/nonce authentication prevent an unauthenticated substitution of
wrapper parameters.

The payload key is the 32-byte Libsodium `crypto_kdf` subkey with ID 1 and exact
8-byte context `SCPSNAP1` from the random 32-byte document key. The payload
uses a fresh 24-byte nonce on **every** rewrite, including slot, lease, and
metadata-only changes. Its AAD is the exact 72-byte header followed by the
complete slot table. Its plaintext is
`document-id[16] || content-type[1] || payload-cbor`.
The document ID is independently random. The content type is required immutable
encrypted shared metadata: `0` is Plain Text and `1` is CSV source. CSV source
is UTF-8 text with LF line endings, a heading row, and equally wide data rows;
every published content state must parse as CSV. Unknown values and containers
without this field are unsupported; unreleased earlier containers are not
migrated. The text remains in the revision graph's content body. All slot
records and semantic fields are therefore authenticated together; changing a
wrapper requires reencrypting the payload even if the revision graph is unchanged. Authenticated decryption
and complete CBOR/graph validation precede exposure of semantic values. Wrong
password or tag yields only authentication failure. Key and password bytes are
never diagnostic output.

## Deterministic decrypted payload

`payload-cbor` is exactly one `container-v3` item in
[`password-container-v3.cddl`](password-container-v3.cddl). It uses RFC 8949
core deterministic encoding: definite maps/arrays/strings, shortest integer
and length encodings, unsigned integer map keys in increasing order, valid
shortest-form UTF-8, and no duplicate keys, tags, floats, indefinite items,
undefined values, or trailing octets. Text is normalized only by the author;
readers preserve exact UTF-8 bytes and do not normalize Unicode. The format
uses byte lengths and byte offsets, never character positions. Every integer
must fit the CDDL range; timestamps are Unix milliseconds in `0..2^63-1`.
Structural limits (file size, nesting, record count, text bytes, delta output)
are selected by the reader before allocation and reported as resource-limit
errors, not silently truncated. A valid file always has at least one canonical
baseline revision and at least one available full body on the canonical line.

The top-level numeric fields are: `1` schema version `1`; `2` ordered encrypted
slot metadata; `3` owner identity; `4` editing lease; `5` revision records;
`6` canonical head ID; `7` latest canonical content ID; `8` sorted required
feature IDs (initially empty); and optional `9` extension map. Slot metadata
repeats each decrypted slot ID and effective permission/claim policy and carries
name, email, and management ID. Each authenticated wrapper must agree
with its metadata on the immutable slot ID. Slot metadata order and role must match the envelope order (owner,
ordinary, optional recovery), with unique slot and management IDs. Owner and
recovery have full effective permissions. Effective permissions come from the
authenticated metadata, allowing administration of another slot without its
password. An authenticated wrapper claim flag cannot be cleared by metadata:
effective `must-be-changed` is the OR of wrapper and metadata flags. Owner and
recovery have no claim requirement. Owner identity names slot 0. Lease fields are active, session ID, heartbeat,
holder time, duration, name, email, and device. Inactive lease uses zero session
ID and empty holder strings. Lease updates create no revision.

An unclaimed ordinary invitation stores its temporary label as the slot name
and an empty email. Claiming replaces both fields with the claimant's identity
and clears the claim flag by replacing that slot's wrapper. Credential and slot
metadata changes append event-only revisions. Their details identify the affected
slot and may state permission bits; they never contain a password, document key,
wrapping key, or derived secret.

A record is `[id, immutable, storage-kind, ?body, ?provisional, ?resolved-by,
?foreign]` represented by the numbered map in the CDDL. `immutable` contains
all identity-bearing metadata: original kind (`0` baseline, `1` delta,
`2` event), previous canonical head, content parent, sorted distinct merge
source IDs, timestamp, actor slot/name/email, client name/email, device,
resulting content hash, original body digest for content revisions, and event
type/details for events. Names and emails are captured at save time and are
self-asserted, not verified identities. Passwords and key material never appear
in event details. An event can identify an affected slot; a compaction event
must identify its cutoff and retained-delta count.

Backup and plaintext-export activity events use event-details key 4 for
`attempted` (0), `succeeded` (1), or `failed` (2). The event type is respectively
`backup-attempted`, `backup-succeeded`, `backup-failed`, `export-attempted`,
`export-succeeded`, or `export-failed`. Outcome events put the attempt revision
ID in key 5 as lowercase `attempt=<hex revision ID>` so the observed result
remains linked to its published attempt after compaction.

Let `H(x)` mean Libsodium `crypto_generichash` with 32-byte output, no key
(BLAKE2b-256). Concatenation is `||`; quoted prefixes are exact ASCII bytes
including the shown final NUL (`00`). Identity hashes are:

```text
content-hash = H("SCPEFE-CONTENT-V3\0" || UTF8-text)
original-body-digest = H("SCPEFE-BODY-V3\0" || canonical-original-body-CBOR)
revision-id = H("SCPEFE-REV-ID-V3\0" || canonical-immutable-map-CBOR)
```

The ID is checked on every record, including pruned and foreign records. A
normal stored content body must match its original digest. The immutable map
always retains the original digest after its body is pruned or replaced by a
checkpoint; the replacement checkpoint is validated against the content hash.
Storage kind, current body, provisional flag, resolved-by, foreign marker, and
other envelope state are intentionally outside the ID. This keeps IDs stable
through pruning and checkpoint materialization. The payload AEAD authenticates
those mutable storage fields. An external head witness should compare document
ID and revision ID; a matching revision ID alone does not prove equal current
slot policy or lease.

Storage kind `0` means absent event body, `1` original full snapshot, `2`
original delta, `3` materialized full checkpoint, `4` pruned local body, and
`5` foreign metadata only. A full body is `[0, UTF8-byte-length, text-bstr]`,
with codec `0` (none) and exact length. A delta body is `[0,
output-UTF8-byte-length, [segments...]]`; each segment is `[0, source-byte-start,
byte-count]` to copy a nonempty range from the content parent's text or
`[1, nonempty-insert-bstr]`. Source ranges must be in bounds. Concatenated
output must match the declared length, be valid UTF-8, and match the record's
content hash. A delta is relative to its content parent, including for merges.
No compression codec other than `0` is supported. A checkpoint uses the full
body framing and an existing revision ID; it creates no new revision.

The mandatory record combinations are:

| Original kind | Required immutable fields | Allowed storage kinds |
| --- | --- | --- |
| Baseline (0) | content hash and original body digest; no parent, event fields, or merge sources | original full (1), checkpoint (3), or pruned (4) |
| Delta (1) | previous head, content parent, content hash, original body digest; merge sources only for a merge | original delta (2), checkpoint (3), or pruned (4) |
| Event (2) | previous head, content hash, event type and details; no content parent or body digest | absent event body (0) |

Foreign records retain their original kind and immutable fields but use storage
kind 5, `foreign=true`, no body, and a `resolved-by` ID. Canonical records have
no `foreign` or `resolved-by` field. Storage kind 0 and 4/5 have no body; kinds
1..3 require one body of the corresponding shape. A compaction event requires
detail keys 2 and 3. Unknown event types can carry known detail keys but cannot
impose unknown state changes. Empty copy/insert segments, integer overflow in
range or output accounting, and malformed UTF-8 output are invalid.

The first canonical record is a baseline with no previous head or content
parent, and originally has a full snapshot. Every later canonical record names
the prior canonical head. A content record also names the prior canonical
content revision, while an event has no content parent and repeats its current
content hash. A baseline may be pruned only when a later checkpoint permits
reconstruction of the current head. `head` equals the last canonical record;
`content-head` equals the last canonical content record. The latest head may
therefore be an event with unchanged text. A valid uncompact file may contain
only the baseline and zero deltas.

Records are ordered with immutable predecessor, content-parent, and merge-source
IDs present before their referrer. `resolved-by` is the sole forward reference:
foreign records precede the merge record that resolves them. Canonical
previous-head links form one chain; content-parent links form one
subchain. No cycles, duplicate IDs, dangling links, or second canonical head
are accepted. A merge is a canonical delta whose nonempty merge-source list
names imported foreign head records. Every imported foreign record has storage
kind 5, retains its original ID and immutable metadata, and has `resolved-by`
equal to the merge ID. Its original predecessor and parent metadata are
retained; the imported set must contain the link closure back to a shared
canonical ancestor. The merge source IDs must be the terminal imported heads.
Foreign bodies are unavailable, and no foreign content line is reconstructed.
Unknown historical event type strings may be displayed as inert history data;
they cannot alter slot, lease, or content semantics.

`provisional=true` is allowed only on the last canonical content record, with
no later event. Repeated regular saves replace that one record from its sealed
content parent and previous head; a manual save removes `provisional` without
adding another record or changing its ID if content and metadata are unchanged.
Event publication requires sealing or discarding it first. The exact previous
sealed container image needed for discard belongs to the host journal, not the
shared format.

Opening reconstructs from the nearest available snapshot/checkpoint at or
before `content-head`, then applies each following canonical delta. It verifies
all available bodies, hashes, IDs, links, and final text before returning it.
A pruned content record has explicit body-unavailable status. Compaction
materializes a checkpoint at an existing cutoff content revision, prunes older
content bodies, retains all immutable metadata and links, and appends an event.
With `N` retained content deltas after the cutoff, `N=0` anchors the latest
content revision, `N=1` anchors its predecessor, and the default is `N=10`.
All retained post-cutoff bodies must reconstruct from that checkpoint. The
format authenticates a compaction result; authorization, exact pre-compaction
backup, and publication are host/library workflow requirements.

Required feature IDs in field 8 are sorted unique unsigned integers. A reader
rejects any unknown ID as unsupported before interpreting the graph. Field 9
contains optional extension entries with integer keys `>=1000`, sorted and
unique, whose values are canonical CBOR data; an unknown optional entry may be
ignored on read but must be copied byte-for-byte on a no-op rewrite or dropped
only by an explicit feature-aware rewrite. Unknown keys elsewhere, unknown
revision/storage/codec values, and unknown permission bits are unsupported.
Readers must reject a file whose optional extension contradicts a known field.
