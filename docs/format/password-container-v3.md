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

A manual save preserves the complete slot area, decrypted 16-octet document ID,
and encrypted editing-lease block. It generates a fresh snapshot nonce, records
the new ciphertext length, and encrypts the document ID, lease block, and new
deterministic snapshot revision with the existing document key. A save from a
sealed head has one parent: the 32-octet generic hash of the exact previous
encoded revision. This construction
keeps all password slots usable, avoids nonce reuse, and authenticates every
immutable header field. Version-2 containers remain readable but cannot be
rewritten because their slot wrappers authenticate the mutable fields.

A regular save marks the snapshot revision provisional with deterministic-CBOR
field 13 set to `false` and retains the exact encoded sealed base revision in
field 14. The first regular save uses that sealed base as its parent; later
regular saves replace the provisional head while retaining the same parent and
sealed base, so timer events do not add history nodes. A manual save of a
provisional head removes fields 13 and 14 and seals the consolidated revision
without adding another node. Explicit discard restores field 14 only after the
caller has revalidated the current head and editing lease.

A password change replaces only the 65-octet wrapper belonging to the slot
authenticated by the current password. The slot's existing independent salt
and nonce remain in the unchanged header; only the password-derived wrapping
key and resulting wrapper change. The document key, slot
identifier, permissions, header, other wrappers, and encrypted snapshot bytes
remain unchanged. Before replacement, the new password is assessed locally and
tried against every other slot so one password cannot address two slots.

Current version-3 writers place a `SCPLEAS1` editing-lease block between the
document ID and revision. The block contains an active flag, 16-octet session
ID, heartbeat counter, holder UTC milliseconds, file-defined duration
(600,000 milliseconds by default), and length-prefixed UTF-8 holder name,
email, and device name. Readers also accept early version-3 payloads without
the block and expose an inactive lease with the default duration. Lease-only
updates re-encrypt this payload with a fresh nonce and preserve the exact
revision bytes, so they never create history revisions.

Invitation-capable readers accept the earlier `SCPINV02` extension between the fixed
owner/recovery wrappers and encrypted snapshot. It contains a little-endian
32-bit invitation count followed by independently salted and nonced invitation
records. Each record carries a 16-octet salt, 24-octet nonce, 32-bit ciphertext
length, and XChaCha20-Poly1305 ciphertext. Its plaintext contains the document
key, immutable slot ID, permission byte, `mustBeChanged` flag, and length-prefixed
UTF-8 display name and email. The extension supports at most seven invitations,
keeping the ordinary owner-plus-invitation total at eight; the optional recovery
slot remains separate. A 64-octet keyed state authenticator follows the records:
one 32-octet value authenticates the complete extension through the last record,
and one authenticates the current encrypted snapshot. Adding, claiming, or
rewrapping an invitation refreshes the snapshot nonce and both authenticators.
This binds every accepted record to the current container state, so a previously
valid temporary-password record cannot be replayed after it has been claimed.

Current writers use `SCPINV03`. Each password-encrypted record is followed by a
24-octet nonce, a 32-bit ciphertext length, and an XChaCha20-Poly1305 ciphertext
under the purpose-separated slot-state key. That administrative plaintext repeats
an opaque management ID, the immutable password-slot ID when known, permissions,
`mustBeChanged` flag, display name, email, and independent known-value flags, but
never contains the document key. This allows a full administrative slot to list,
update, or remove ordinary invitation slots without knowing their passwords, while
keeping identity and policy metadata encrypted. The keyed state authenticator
covers both ciphertexts. A managed permission or identity update re-randomizes the
administrative ciphertext and snapshot and refreshes both authenticators. Removing
a record rebuilds the extension; removing its final record removes the extension.
Permanent owner and recovery/master wrappers are outside this extension and cannot
be demoted or removed.

Readers enumerate `SCPINV02` records by deriving a stable opaque management ID from
the authenticated immutable salt and nonce and the slot-state key. The handle
therefore survives a claim or password rewrap before migration. Values that were
available only inside the unknown password wrapper are explicitly marked unknown.
In particular, permission knowledge and `mustBeChanged` knowledge are separate, so
an administrative permission update cannot clear the password wrapper's claim
requirement or expose content early. Claiming uses the effective managed permissions
when it creates the replacement password wrapper. The first
administrative update or identity reconciliation rebuilds the extension as
`SCPINV03` while copying each original password salt, nonce, length, and ciphertext
byte-for-byte. Consequently migration neither needs nor changes an invited person's
password. Authentication by that person can later populate the immutable slot ID
and identity without changing the management ID.

Any authenticated slot with remove-password permission may enumerate the managed
records needed to select a removal target. Changing permissions remains restricted
to a full administrator holding both add-password and remove-password permission.

Current writers also place an authenticated `SCPOWN01` owner-identity block after
the lease and before the revision. It binds the permanent owner slot ID to its name
and email independently of whichever slot authored the current revision. New
documents write it at creation. An owner-authenticated operation upgrades an older
payload when the owner-authored revision still supplies the identity, and explicit
owner reconciliation can establish or replace it. Recovery use never treats an
identity difference as a profile mismatch.
