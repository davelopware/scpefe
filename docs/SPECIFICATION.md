<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# SCPEFE specification

Status: working specification, recorded 19 September 2026. This document captures decisions made so far and distinguishes them from details that remain open.

Canonical entity names and state terminology are defined in [DOMAIN_MODEL.md](DOMAIN_MODEL.md).

## 1. Purpose

SCPEFE is an open-source, storage-neutral, cross-platform editor for small UTF-8 text documents stored as self-contained encrypted files. A document should be usable across devices without distributing key files or creating a SCPEFE account.

Local disks, network shares and NAS storage, and cloud-backed storage are equally valid locations. Cloud-hosted files are a required application capability, but no individual document is required to use cloud storage. Google Drive is the first cloud-storage use case, but neither the format nor application behavior may depend on Google Drive or any other provider-specific locking or revision service.

The software is licensed under `GPL-3.0-or-later`. The public file-format specification uses `CC BY 4.0`, while machine-readable schemas and interoperability test vectors use `CC0`. Independently written proprietary implementations of the public format are permitted provided they do not incorporate GPL-covered SCPEFE code.

## 2. Delivery order

### 2.1 Platform sequence

The planned platform order is:

1. Windows GUI.
2. Android mobile app.
3. Linux GUI.
4. End-user Windows and Linux CLI.

The Windows GUI uses ordinary filesystem paths. Google Drive for desktop, local disks, and mounted NAS shares therefore use the same file-access path. A small developer diagnostic CLI is required from the beginning, independently of the later polished end-user CLI.

### 2.2 Shared implementation stack

As much code as practical must be shared. Encryption, file-format handling, history, merge behavior, validation, and diagnostics belong in a common core. Platform-specific code should primarily provide the UI, lifecycle integration, and file access.

The selected implementation direction is:

- A C++20 common core built with CMake and exposed through a narrow stable C interface.
- A responsive React and TypeScript HTML UI.
- Electron for Windows and Linux desktop applications.
- Capacitor for Android, using a small native plugin and JNI bridge to the C++ core.
- Native C++ command-line applications linked directly to the core.
- Node-API bindings for the Electron host; the sandboxed renderer receives only a narrow validated API.

The native build is the production path. A WebAssembly build of the platform-neutral core is maintained as a secondary target for portability/conformance testing and possible future browser diagnostics, but production password, key, file-replacement, and lease handling remain native initially.

### 2.3 Library and host adapters

The common C++ implementation is delivered as one `libscpefe` library. Internally it preserves logical separation between pure format/cryptographic code and application orchestration, but exposes both low-level diagnostic/format APIs and high-level session/configuration APIs through one stable, versioned C ABI.

The C ABI is an adapter seam, not the internal programming model. Core state and domain behavior are implemented in idiomatic, object-oriented C++20 classes and value types with encapsulation, RAII ownership, and standard-library types. C entry points remain thin: they validate and marshal C-compatible arguments, delegate to C++ objects, translate results/errors, and must not accumulate the primary implementation logic. C structs, opaque handles, callbacks, and function tables are used only where data crosses the external ABI or a host-adapter seam. Pure stateless algorithms may remain free functions where that is clearer, but domain state must not be represented internally as an anemic C-style struct manipulated primarily by free procedures.

Internal code is organized for discoverability and reuse: each class has a clearly named private `.hpp`/`.cpp` pair, and even small reusable helpers live in their own named files rather than being hidden inside an unrelated implementation file. Files implementing the external C seam use the `_abi.cpp` suffix and contain adapter logic only. Public C headers use `.h`; private C++ interfaces use `.hpp` and are never installed as part of the C ABI. Because this convention creates more files, adding another cohesive, purpose-named folder level is explicitly encouraged when it keeps directory contents navigable.

The public `libscpefe` headers define a versioned host-services interface. Official Windows, POSIX/Linux, and Android adapter libraries implement it; an embedding application may provide its own implementation. The frontend creates an adapter instance and passes its function table and instance data to an explicit SCPEFE context. Registration is per-context rather than process-global, allowing multiple isolated contexts and deterministic test adapters.

Host services use opaque document handles rather than assuming filesystem paths and cover document reads/safe replacement, app-private blob/journal storage, typed-settings persistence, clocks, lifecycle input, and declared storage capabilities. `libscpefe` owns schemas, defaults, and validation for meaningful SCPEFE settings; purely frontend preferences such as window geometry and theme remain in the frontend.

### 2.4 Execution model

`libscpefe` creates no hidden worker threads or event loops. Operations are synchronous and cancellable where practical; each host dispatches expensive work using its native worker facilities. The library reports its next deadline for lease refreshes and recovery checkpoints, and the host calls a due-event processing API. Production cryptographic randomness is not an injectable host service.

## 3. Threat model and security boundary

### 3.1 Protected threats and exclusions

SCPEFE is intended to protect document content from:

- The cloud-storage provider.
- An attacker who obtains access to the storage account or copies encrypted files.
- Competent attackers and automated or LLM-assisted offline password guessing.
- Someone who obtains a device while SCPEFE is locked.

It is not intended to resist a nation-state adversary or protect plaintext that is already visible in a currently unlocked editor. It also cannot prevent compromise by malware, keyloggers, screen capture, or a fully compromised operating system.

### 3.2 Visible and encrypted metadata

The storage layer may see the meaningful external filename, file size, and filesystem timestamps. Semantic metadata—including lock state, internal document metadata, author identity, device identity, revision history, and document content—must be encrypted. Only non-semantic data strictly required to recognize and decrypt the container, such as format and cryptographic envelope parameters, may be exposed.

### 3.3 Cryptographic baseline and release gates

Established, reviewed cryptographic libraries must be used; custom cryptographic primitives must not be invented. The selected baseline is Libsodium, Argon2id v1.3 for password-based key derivation, a random 256-bit document key, purpose-derived subkeys, and XChaCha20-Poly1305 authenticated encryption with random nonces. Algorithm identifiers and exact parameters are stored so formats can evolve without silently changing existing files.

Before any production release, the cryptographic design and file format require independent expert review. Password-derivation parameters must also be benchmarked and tuned on a representative low-end supported Android phone while the real WebView UI is running. The provisional target is 64 MiB of Argon2id working memory and approximately one second per password attempt, subject to that required portability testing before the format freezes. Allocation failure must fail cleanly and must never cause silent parameter weakening. This tuning is a production gate rather than near-term implementation work.

### 3.4 Authentication failure

If authenticated decryption detects corruption or tampering, the editor must fail closed. It must not present partially authenticated content as an ordinary editable document. Diagnostic reporting is allowed; best-effort salvage is a separate future recovery feature.

## 4. Identity and storage authentication

### 4.1 Local profile

Before SCPEFE can be used, the user must configure a local profile containing:

- Name.
- Email address.
- A user-chosen name for the current machine or device.

This is self-asserted authorship information, not an authenticated identity. The values in effect when a revision is saved are included in that encrypted revision.

### 4.2 Storage authentication

SCPEFE has no application account. Authentication needed to reach Google Drive, a NAS, or another storage location is handled by the operating system or storage provider. Once a file is available to SCPEFE, one valid password slot is the only SCPEFE credential needed to unlock it; no separate key file or SCPEFE login is required.

## 5. Passwords and key management

### 5.1 Password-slot model

Each document has an independent small set of password slots. A password never implicitly unlocks a collection or vault. Version 1 supports up to eight ordinary slots, including the original owner, plus one separate optional recovery/master slot: nine slots at most.

Every file begins with an original owner slot and may also have an optional, independent recovery/master slot. The recovery password is strongly encouraged at file creation. Guidance must tell the user to store it safely offline and separately from ordinary passwords. Additional slots support invitation of other users without revealing an existing password.

Every slot grants viewing and has encrypted policy metadata:

- A stable random slot identifier and human-facing display identity.
- `canEdit`.
- `canAddPasswords`.
- `canRemovePasswords`.
- `mustBeChanged`.

### 5.2 Permissions

The original owner and recovery/master slots always have edit, add, and remove permissions and cannot be demoted. Add or remove permission implies edit permission. Every slot may change its own password regardless of its administrative permissions, and the application prevents removal of the last administrative slot. Permissions delegated to a new slot cannot exceed those possessed by the creating slot.

### 5.3 Invitations and first use

New invitation slots use a strong temporary password and start with `mustBeChanged` set. Until that password has been replaced and the replacement safely committed, the official app exposes only the password-change workflow rather than document content. The initial owner and recovery/master passwords start with the flag clear because their owners chose them directly. Temporary passwords must satisfy the normal strength rules and should be conveyed through a separate secure channel.

The app generates a strong temporary invitation passphrase by default, with manual entry permitted only when it passes the normal strength check. A generated plaintext passphrase is displayed once for deliberate transfer and is not retained. A new or changed password is rejected if it already unlocks another slot in the same document.

Every newly chosen password uses the same minimum length and local resistance-to-guessing policy. A canonical hyphenated version-4 UUID is accepted as a documented exception to the estimator, case-insensitively; because its text cannot prove how it was generated, users must obtain UUID passwords from a trusted random generator. Other UUID versions receive the normal strength assessment.

### 5.4 Slot identity and profile reconciliation

An unclaimed invitation may have a temporary descriptive label. When it is claimed, its encrypted display identity becomes the claiming client's configured name and email; removal and other UI actions identify the slot by that display identity while using its immutable ID internally. The device name remains revision-specific. On later unlock, a mismatch between slot identity and local profile is prominently reported and never updated automatically. The user may reconcile the slot through the normal lease and atomic-save flow. Declining permits read-only access but blocks edit mode until the identities match. Slot-identity changes are retained in encrypted history, and revisions record slot ID, registered identity, current client profile, and device name. Changing the app-wide name or email warns that previously claimed documents will request reconciliation.

### 5.5 Recovery/master slot

The recovery/master slot is an emergency administrative credential rather than a person: it has full permissions, has no bound profile or mismatch prompt, is never marked `mustBeChanged`, and records the current client profile/device whenever used. The UI discourages routine use or sharing.

### 5.6 Policy limits and revocation

View-only and password-management flags are cooperative policy enforced by conforming applications, not protection against a malicious authorized recipient. Anyone who can decrypt the document can copy its plaintext or construct a replacement container using modified software. Removing a slot prevents that password from unlocking future copies of the updated document; it cannot revoke plaintext or keys already obtained or invalidate older file copies.

### 5.7 Key wrapping and password changes

Document content is encrypted using the random document key. Every slot has independent salt/KDF parameters, and its password-derived key wraps that same document key plus the slot's capability metadata. Changing a password re-wraps the existing document key; it does not re-encrypt all document content unless a future explicit key-rotation operation is performed. If a password may have been compromised, the application strongly recommends full document-key rotation because an attacker may already possess the old key.

### 5.8 Slot lookup and unlock order

Finding a matching slot may require multiple sequential KDF attempts. Normal unlock tries the last successful ordinary slot remembered by that client, the remaining ordinary slots, and the recovery/master slot last. A dedicated “Use recovery/master password” action targets that slot directly during genuine recovery. The client remembers only a random slot identifier, never the password or decrypted key. On a new client, trying all ordinary slots may take several seconds.

### 5.9 Password quality and memory handling

Weak passwords must be rejected. Strength is assessed locally using resistance-to-guessing estimation rather than rigid composition rules, so strong memorable passphrases are supported. Passwords are never sent elsewhere for assessment.

The UI explains why a proposed password is rejected without logging, retaining, or transmitting it.

Passwords and decrypted file keys are not persistently stored in operating-system credential storage in the initial releases. They remain only for the active unlocked session and are cleared on re-lock or exit as far as the platform permits.

Libsodium guarded or locked memory and explicit zeroing are used as defense in depth where supported. These mechanisms are not presented as absolute protection against a compromised operating system.

## 6. Self-contained file format

### 6.1 Container identity and constraints

Encrypted documents use a dedicated `.scpefe` extension. A meaningful filename may be retained, for example `notes.md.scpefe`.

Everything durable that defines the shared document belongs in the single `.scpefe` file. This includes content, semantic metadata, lock/lease state, revision history, and merge ancestry. The format must not require adjacent key, lock, index, history, or metadata files.

Encrypted work journals in application-private local storage are an accepted exception. They are local recovery or pending-synchronization state, not companion files in the shared storage location.

The format must be versioned and publicly documented so that independent implementations can read it and documents remain recoverable in the long term.

Each document has a permanent random document identifier. Each revision cryptographically identifies its parent revision or parents. This hash-linked revision graph supports both merging and local replacement/rollback detection; it is not presented as a blockchain or distributed consensus system.

The expected common case is an uncompacted file of roughly 10–100 KB. The format imposes no arbitrary maximum, but clients must enforce device-appropriate allocation limits and fail gracefully before exhausting memory or storage.

### 6.2 Serialization and envelope

The file uses two layers:

- A minimal purpose-built binary envelope containing only recognition/version information, password-KDF parameters, wrapped-key slots, nonces, lengths, and opaque encrypted-record framing needed before decryption.
- RFC 8949 deterministic CBOR for decrypted structured records.

The SCPEFE CBOR profile uses definite lengths, integer field identifiers, no floating-point values, strict UTF-8 validation, rejection of duplicate keys, and explicit limits on nesting, counts, and sizes. Unknown optional fields are preserved or ignored as specified; unknown mandatory features are rejected. A public CDDL schema plus valid and invalid conformance vectors define the profile. Diagnostic tooling maps numeric fields to readable JSON names.

Version 1 stores snapshots and delta segments uncompressed. Records nevertheless contain versioned codec framing, initially `none`, and validated uncompressed lengths so a later speed-oriented compression enhancement does not require changing record semantics. Unsupported codecs are rejected cleanly.

### 6.3 Proposed history representation

The agreed direction is a hybrid representation:

- An encrypted full snapshot supports fast normal opening.
- Encrypted revision records contain parent revision identifiers, content hashes, timestamps, author/device information, and text deltas.
- Revision ancestry forms a graph rather than only a linear list, permitting divergent offline edits to share a merge base.
- Occasional encrypted checkpoints prevent recovery from depending on an indefinitely long delta chain.
- Checkpoint frequency and similar tuning are implementation details.

This structure must be designed for crash detection and authenticated integrity. The precise binary layout is not yet specified.

## 7. History and compaction

### 7.1 Revision lifecycle

Each explicit document save creates a revision. History is retained indefinitely by default.

Optional regular saves are a configurable per-client application preference, disabled by default with a two-minute default interval when enabled. They commit to the actual `.scpefe` file but update one provisional autosave revision whose cumulative delta is based on the last user-asserted save; timer events do not fill history with individual revisions. A manual save seals the consolidated revision.

On clean exit with a provisional autosave, the user is still warned about unsaved changes. Choosing save seals the consolidated update. Choosing discard restores the last manually saved content and removes the provisional autosave, subject to the normal divergence check. After a crash or stale lease, the next editor is offered an explicit choice to recover or discard the provisional changes, with author/device details shown after decryption.

### 7.2 Compaction prompting and policy

When the file's estimated size exceeds a configurable multiple of its estimated compacted size, the application regularly suggests compaction. The default threshold is 10×. The user may permanently dismiss this notification for an individual file.

Compaction creates a fresh baseline from the latest resolved content and, after explicit confirmation, discards earlier embedded history. The UI must warn that compaction cannot erase copies retained by storage providers, sync tools, caches, or backups.

Compaction is allowed only from a clean, manually sealed, conflict-free document while holding the lease, and only for a slot possessing both add-password and remove-password permissions. Before compaction, SCPEFE creates and verifies an exact backup using the standard timestamped naming convention. The fresh baseline retains the previous head hash as a shallow “history truncated here” parent reference so clients that witnessed that head can recognize continuity.

### 7.3 Deferred history interface

Browsing, comparing, and restoring historical revisions is a future feature and is not required for the initial release. The history is nevertheless recorded from the first format version so later implementations can use it.

## 8. Editing and locking

### 8.1 Read-only and edit modes

Every document initially opens in read-only mode after password entry. Merely viewing never acquires an editing lease. The user explicitly enters edit mode, which acquires the advisory lease. A successful save remains in edit mode and retains the lease; the lease is normally released when edit mode ends or the application exits.

The normal workflow edits an internal working copy. The shared `.scpefe` file is updated by a manual save or, when enabled, a regular provisional save. The UI must make unsaved and provisionally autosaved changes unmistakable.

Concurrent editing is not a primary supported workflow. SCPEFE uses a provider-neutral advisory lease stored inside the encrypted file. It must not depend on provider-specific locking or revision facilities and must not create an adjacent lock file.

An actively leased file can still be opened read-only after password entry, showing the decrypted lease-holder details. Entering edit mode warns the second editor rather than silently permitting concurrent editing.

### 8.2 Lease lifecycle and heartbeat

The encrypted per-file lease duration defaults to ten minutes so every client applies the same takeover rule. While unlocked in edit mode the holder refreshes the lease every two minutes. Refresh stops completely while the application is locked. Lease expiry makes takeover permissible; it does not itself discard the editing session. On unlock, a still-valid lease resumes directly. An expired but unchanged and unclaimed lease is transparently reacquired. If another client acquired or changed the file, recovery/conflict handling applies.

Each refresh contains a random lease-session identifier, monotonically increasing heartbeat counter, holder UTC time, and lease duration. A reader uses advancing heartbeats as proof of activity. If clocks appear inconsistent, it can observe an unchanged session/counter for one full lease duration using its own monotonic clock before treating the lease as stale. Carefully confirmed forced takeover remains available so a bad clock cannot lock a file indefinitely.

Lease-only refreshes change the storage-level modification time but never create document-history revisions. Version 1 safely rewrites the small container while reusing unchanged ciphertext rather than adding a specialized in-place double-buffered header writer; this may be optimized later only if measurement shows problematic synchronization traffic.

### 8.3 Clock sanity checks

A client may locally learn approximate clock offsets from observed heartbeats as an additional sanity check. This app-private cache is keyed by document/device, records uncertainty and observation times, is never authoritative, and is invalidated after clock jumps, contradictory evidence, or prolonged gaps. Offset learning is disable-able per client; disabling it deletes the client's cache. Read-only observation never writes clock estimates into the shared document.

### 8.4 Lock limitations and conflicts

Because generic filesystems, cloud-sync clients, and NAS implementations do not provide uniform atomic compare-and-swap behavior, this lock cannot guarantee exclusion. Two editors can read the same unlocked version before either write becomes visible. SCPEFE must describe the lock as advisory rather than claiming distributed locking guarantees.

An editor that detects a changed base does not automatically choose a winner or silently merge. It presents a manual three-way merge using the common ancestor, local version, and current observed version. Initial conflict handling creates a working draft using the Git-style marker sequence `<<<<<<< local`, `=======`, and `>>>>>>> current` around the two alternatives.

Final save is blocked until all conflict markers are resolved. Both branches remain represented in history. SCPEFE can only detect or merge versions it can observe; it cannot recover a version already discarded by the underlying storage system.

## 9. Offline work and local journal

Offline editing is supported. Network connectivity alone is not proof that a particular file provider is current or reachable, so synchronization decisions must be based on actually rereading and validating the target file. All local recovery and pending-publication behavior uses the single encrypted work journal described below.

When a target becomes available after an offline save:

- If the observed base still matches the journal's base revision/hash, the pending version may be committed.
- If the target has diverged, manual three-way conflict resolution is required.

The UI must clearly distinguish:

- Unsaved edits.
- Saved locally but pending synchronization.
- Successfully saved to the target file.

Pending journal states survive application restarts. They remain prominently flagged, and the application repeatedly encourages the user to resolve synchronization and clear them. Pending work remains until committed, merged, or explicitly discarded. Recovered text remains labelled as unsaved.

### 9.1 Unified local work journal

Auto-lock recovery, crash recovery, offline saves, conflicts, and interrupted publication use one encrypted app-private local work journal per document rather than separate draft mechanisms. It records the base revision, current working content or delta, cursor position, whether changes are unsaved or user-saved but pending publication, conflict state, last update, target location, and any active publication transaction.

The journal is encrypted without introducing persistent credentials outside the document's password-based access model. It is updated ten seconds after typing pauses and at least every thirty seconds during continuous typing by default; both values are configurable per client. It is force-flushed before any automatic/app-initiated lock; ordinary backgrounding does not lock or close in-progress dialogs. A manual save changes its state rather than creating a second kind of draft. It is cleared only after a save has been published and verified or the user deliberately discards the work.

If a journal write fails, editing shows an immediate persistent warning. Mandatory security locking still clears plaintext even if the final journal flush fails and the latest changes are consequently lost.

### 9.2 Crash-safe publication

Publishing a candidate container uses a uniquely named temporary sibling on the target filesystem: prepare, write temporary file, flush, replace, verify, then clean up. This transient sibling is an atomic-write mechanism, not a persistent companion file.

The local work journal materializes the exact candidate `.scpefe` byte stream once and records its ciphertext hash, transaction identifier, target, temporary path, and transaction stage. The byte stream is copied to the same-filesystem sibling without a second serialization or encryption pass. Atomic replacement is used where supported; weaker filesystem behavior is detected and documented rather than overstated.

After a crash, a temporary file is deleted automatically only when it is provably redundant. An unambiguous interrupted publication may be completed automatically with a subsequent user notification; ambiguous cases require confirmation. A potentially newer valid candidate is preserved for authenticated recovery or completion. If the original is missing, the temporary file is recovery data. The app never deletes another client's untracked or potentially active transaction file.

### 9.3 Local head witnessing

Each client remembers the last sealed revision hash observed for a document in app-private state. When the document is next opened:

- A current head descending from the remembered head is normal progress.
- A current head that is an ancestor indicates rollback or a stale copy.
- Unrelated heads indicate divergence or replacement.
- A different permanent document identifier indicates replacement.

An authenticated mismatch may be inspected read-only, but editing and saving remain blocked until the user explicitly accepts the replacement or resolves the divergence. A new client with no previous witness cannot detect rollback of a complete otherwise-valid file; doing so would require an external anchor, which is outside the storage-neutral, self-contained design.

## 10. Backup and format migration

### 10.1 Backup

Backup creates a verified byte-for-byte replica of a clean, manually sealed `.scpefe` container. It uses crash-safe publication at the selected destination and does not decrypt, re-encrypt, change the document ID, or switch the active document away from its original path. View-only slots may create backups. If unsaved or provisional changes exist, the user must save or discard them before Backup.

Backup names use the default form `name.backup-YYYYMMDDTHHMMSSZ.scpefe`, with a UTC filesystem-safe timestamp and numeric collision suffix where required. Existing backups are never overwritten.

### 10.2 Format migration

Every application release reads supported older stable formats but writes only the latest format. Opening an older format offers migration; declining still permits read-only access, while the next save necessarily migrates. Migration preserves the document identity, content, history, and password slots and records a migration event without claiming a text change. Slot wrappers remain individually versioned because passwords for other slots may be unavailable during migration.

Before rewriting an older document, SCPEFE automatically creates and verifies an exact pre-migration backup using the standard backup naming convention. Migration never silently proceeds if backup creation fails; the user may select another destination. The UI warns that older SCPEFE versions may not open the migrated document.

## 11. Automatic locking

### 11.1 Lock triggers

An open document automatically re-locks:

- When the device screen locks.
- After a mandatory finite inactivity timeout, configurable per client from 30 seconds to 10 minutes and defaulting to two minutes.

Immediately before an automatic lock, SCPEFE force-flushes the unified encrypted local work journal if unsaved edits exist. Unlocking again requires a valid document password.

### 11.2 Effect on editing leases

Automatic UI lock does not immediately surrender an editing lease. Heartbeat refresh stops, so the lease naturally becomes eligible for takeover after its file-defined duration. Returning before expiry resumes seamlessly after password entry; returning later transparently reacquires an unchanged, unclaimed file.

## 12. Editor features

### 12.1 Text editing and canonical representation

Initial text editing supports:

- UTF-8 text.
- Undo and redo.
- Find and replace.
- Plaintext export of the current resolved text only.

Canonical internal document text is valid UTF-8 without a BOM and uses `LF` line endings. Pasted text accepts common line endings and an optional UTF-8 BOM. The editor never trims whitespace or changes final-newline state automatically. Plaintext export may optionally use platform-native line endings.

### 12.2 Plaintext input and export

Plaintext export must prominently warn that the exported copy is not password protected and may persist in backups or storage history.

There is no explicit plaintext-import workflow initially; users create a new encrypted document and paste text into it. Export never includes history, identity, lease, or other metadata.

View-only slots may use plaintext export and encrypted Backup because they already possess the plaintext; they cannot enter edit mode, create revisions, compact history, or administer credentials except for changing their own password/identity as explicitly allowed.

### 12.3 Single-document application workflow

Initial releases open only one document at a time and enforce one application instance per logged-in desktop session. A subsequent open request is routed to the existing window. An unresponsive instance is not killed or bypassed automatically; after a short timeout, the app explains the risk and gives platform-specific manual termination instructions. Restart uses the encrypted work journal and normal stale-lease recovery.

Opening another file immediately replaces a clean current document. If modified, the UI offers save and open, destructive discard and open, or cancel. A locally pending rather than target-published save is clearly disclosed before switching. Unresolved journals continue to be surfaced after their document closes.

### 12.4 File-management boundary

Rename, move, copy, and deletion remain operating-system responsibilities. Initial SCPEFE provides New, Open, Save, Backup, and Export Plaintext, but omits ambiguous Save As. A future explicit duplicate-as-new operation may create a new document identity, baseline, and credentials. Ordinary filesystem copies are replicas of the same document.

### 12.5 Markdown and editor state

The file may contain an encrypted metadata flag identifying Markdown content. Markdown preview is desirable but not essential initially. A future Markdown feature should support WYSIWYG editing, with an application preference allowing users to choose WYSIWYG or direct Markdown-source editing.

Undo and redo apply only to the current unlocked editing session. Auto-lock and crash recovery restore text and cursor position but do not serialize or restore the complete editor undo stack.

### 12.6 Language and accessibility

The initial interface is English-only but localization-ready. `libscpefe` returns structured error/message identifiers and data rather than final UI prose. The HTML UI supports keyboard-only operation, screen-reader labelling, visible focus, scalable text, and high-contrast environments from its first release.

## 13. Common core, diagnostics, and testing

A developer diagnostic CLI is built early as a thin wrapper over common-core APIs. Tests call those APIs directly; the CLI must not contain a separate implementation of parsing or cryptography.

Core diagnostic capabilities should include:

- Validate the container and authenticated revision graph.
- Report format versions and cryptographic parameters.
- Dump structured metadata, snapshots, deltas, and lock state as JSON after successful authentication.
- Support golden-file, corruption, migration, merge, and round-trip tests.

The diagnostic dump must never emit passwords or raw encryption keys. It must acquire passwords through a secure interactive prompt or standard input, never a command-line argument. Decrypted document text is excluded by default and requires an explicit `--include-content` option.

## 14. Privacy and network behavior

### 14.1 Telemetry and network access

SCPEFE contains no telemetry or automatic crash-reporting capability. This is a project-level privacy guarantee, not merely a default preference. Diagnostic output is produced only by an explicit local user/developer action.

Production applications do not initiate network connections. Application updates are delivered through the chosen distribution channel. Access to remote, network, or cloud-backed files is performed by the operating system, mounted filesystem, sync client, or Android file provider rather than by SCPEFE-specific network code.

### 14.2 Operating-system backup

App-private SCPEFE data is opted out of operating-system cloud backup, including Android automatic backup. User-managed `.scpefe` documents remain under the user's chosen storage and backup arrangements.

### 14.3 Irrecoverability and legal review

There is no account recovery service, master developer key, escrow key, or backdoor. If every usable document password is lost, recovery is intentionally impossible, and file creation requires the user to acknowledge this. Before public binary distribution, the project requires export-control and target-country legal review and limits availability to cleared jurisdictions.

## 15. Known limitations

- No provider-neutral format can guarantee a distributed lock or atomic compare-and-swap on every filesystem and sync service.
- Connectivity detection cannot guarantee that a cloud-backed filesystem view is current.
- Conflict recovery requires access to both divergent versions; SCPEFE cannot reconstruct a version discarded by another system.
- Compaction cannot delete historical copies outside the current file.
- Self-asserted author details are useful attribution, not a cryptographically verified identity or tamper-proof audit trail against someone who legitimately knows a file password.
- A password cannot protect plaintext already displayed in an unlocked session or a device whose operating system is compromised.
- Password-slot permissions cannot stop a deliberately modified client used by someone who already has a valid password.
- Local head witnessing cannot establish freshness on a new client that has never observed the document.

## 16. Open design questions

The following details have not yet been decided:

- Packaging and distribution details for Electron, Capacitor, and native core binaries.
- Final password-KDF parameters after required Android benchmarking.
- Exact file grammar, CDDL schema, outer-envelope layout, checkpoint cadence, and migration rules.
- Safe-write and replacement behavior across the supported filesystems.
- Final lease write/renewal mechanics and crash behavior when auto-locking, suspending, or resuming.
- Android file-provider workflow and how its availability/staleness is assessed without provider-specific revision APIs.
- Exact password-strength threshold and accessibility/usability testing of its feedback.
- Local work-journal storage quotas, cleanup, and detailed behavior under low-storage conditions.
- Password-slot management UX, key-rotation UX, and handling of first-use invitation races.
- Remaining history-compaction details, including treatment of branches and minimum-size handling for very small documents.
- Profile input validation and detailed presentation of self-asserted authorship.
- Whether and when Markdown preview and WYSIWYG editing enter the release roadmap.
- Contribution and governance model, including a future royalty-free patent commitment for format contributions.
