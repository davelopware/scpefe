# Frontend ownership and incremental cutover

The frontend application core presents a document session; it does not replace
the main-process `DocumentService` or the C++ `libscpefe` context. A frontend
`DocumentSession` will orchestrate presentation of the active target and own a
`WorkingCopy` while unlocked. The existing main-process services continue to
own lifecycle barriers, durable publication, storage, and security policy.

| Concern | Authoritative owner now | Owner after frontend migration | Boundary |
| --- | --- | --- | --- |
| Open, replacement, lock, unlock, and close presentation; active target identity in the UI | Frontend `DocumentSession` | Frontend `DocumentSession` | Host services perform the actual document operation; the frontend presents its structured result. |
| Working text, manual-save baseline, dirty state, edit history, selection, and find/replace | `WorkingCopy` owned by frontend `DocumentSession` | `WorkingCopy` owned by frontend `DocumentSession` | Journal writes use a narrow host capability. |
| Editing and lease command availability and takeover attention | Frontend `DocumentSession` | Frontend `DocumentSession` | React maps attention and outcomes to dialogs and safe messages. |
| Save and publication command availability, status, and semantic attention | Frontend `DocumentSession` | Frontend `DocumentSession` | The session serializes commands and projects host results; main-process services retain publication authority. |
| Recovery decisions other than publication | Windows React renderer and frontend `DocumentSession` | Frontend `DocumentSession` | Recovery presentation continues its incremental cutover. |
| Dialog rendering, focus, inert chrome, and form drafts | Windows React renderer and current dialog helpers | Shared React UI and platform frontend | These are presentation details, not document-session state. |
| State-changing frontend command order and pending UI operations | Windows React renderer | Frontend `DocumentSession` | This ordering complements the main-process lifecycle barrier. |
| Main-process lifecycle barrier, generation, and native work completion | Windows main-process lifecycle services | Windows main-process lifecycle services | A frontend command cannot declare native work complete. |
| Durable publication, pending-publication journal, conflict detection, and crash recovery | `DocumentService`, `PublicationService`, and app-private journal | Same main-process services | Frontend state projects results; it does not independently publish or reconcile containers. |
| Target I/O, app-private storage, clocks, and platform capabilities | Host-services implementations and Windows main process | Same host-services implementations and platform frontend | Platform adapters implement the `libscpefe` host-services interface. |
| Format, cryptography, password-slot and lease policy, and permission checks | `libscpefe` and existing main-process orchestration | Same C++ library and main-process orchestration | TypeScript must not duplicate backend decisions. |

At **every intermediate commit**, each state concern has exactly one
authoritative owner. A concern moves from React to `DocumentSession` in one
cutover: React then subscribes to the session snapshot and dispatches commands
instead of maintaining a parallel copy. In particular, React and
`DocumentSession` must never independently own the same working text, dirty
state, lifecycle phase, pending operation, or command eligibility. Derived
rendering values may be calculated from the authoritative snapshot without
becoming a second mutable source of truth.

`DocumentSession` now projects closed, locked, unlocked/read-only, and edit
lifecycle states through an immutable external snapshot. It retains target
identity after Lock but drops document and `WorkingCopy` references at lock
start; Close drops the target identity. It serializes basic lifecycle commands,
while the main process retains its own lifecycle barrier and durable safety
guarantees. A future CLI can observe the same lifecycle snapshot without
importing React or DOM behavior.

`DocumentSession` creates a `WorkingCopy` at successful document adoption and
disposes it at lock start. The Windows editor now reads the session's immutable
working-copy projection and sends synchronous edit, history, selection, and
search commands to the session. React does not retain a second text, baseline,
dirty, history, or selection state. The session also owns edit-lease attention
and consumes one-shot takeover authorization; React receives only the holder
identity and operation needed to present that decision.
Manual save, regular provisional save notifications, pending-publication
retry and discard, backup, and plaintext export now flow through the session.
React uses its publication snapshot and command eligibility for status, menus,
and dialogs; it does not retain a second publication state. The host still owns
the exact candidate, publication transaction, backup destination, and export
policy. Recovery decisions outside publication remain separate work.
The class's journal drain waits for host update acknowledgements; the host
retains durable checkpoint and failure policy, and can report a later
checkpoint warning. The platform adapter supplies a fresh opaque journal
scope for each adoption and passes it with updates. The host echoes that
scope on delayed checkpoint warnings, so a warning from an earlier document
cannot fail the current working copy.

Shared React UI now owns modal focus behavior through `FocusManager` and a
small DOM capability. The Windows renderer and creation security dialog keep
their markup and decide when dialogs open, while the shared manager owns
modal depth, inert chrome, keyboard containment, and safe focus restoration.

The npm workspace packages expose TypeScript source through explicit public entry
points. Windows consumes them as workspace dependencies, so a clean install needs no
prebuilt package output. New renderer-side production modules are strict
TypeScript; this rule does not migrate unrelated main/preload JavaScript.
