# Frontend ownership

The frontend application core presents a document session; it does not replace
the main-process `DocumentService` or the C++ `libscpefe` context. A frontend
`DocumentSession` orchestrates presentation of the active target and owns a
`WorkingCopy` while unlocked. The existing main-process services continue to
own lifecycle barriers, durable publication, storage, and security policy.

| Concern | Authoritative owner | Boundary |
| --- | --- | --- |
| Open, replacement, lock, unlock, and close presentation; active target identity in the UI | Frontend `DocumentSession` | Host services perform the actual document operation; the frontend presents its structured result. |
| Working text, manual-save baseline, dirty state, edit history, selection, and find/replace | `WorkingCopy` owned by frontend `DocumentSession` | Journal writes use a narrow host capability. |
| Editing and lease command availability and takeover attention | Frontend `DocumentSession` | React maps attention and outcomes to dialogs and safe messages. |
| Save and publication command availability, status, and semantic attention | Frontend `DocumentSession` | The session serializes commands and projects host results; main-process services retain publication authority. |
| Recovery decisions other than publication | Frontend `DocumentSession` | React presents semantic recovery attention and dispatches the selected action. |
| Dialog rendering, focus, inert chrome, and form drafts | Shared React UI and platform frontend | These are presentation details, not document-session state. |
| State-changing frontend command order and pending UI operations | Frontend `DocumentSession` | This ordering complements the main-process lifecycle barrier. |
| Main-process lifecycle barrier, generation, and native work completion | Windows main-process lifecycle services | A frontend command cannot declare native work complete. |
| Durable publication, pending-publication journal, conflict detection, and crash recovery | `DocumentService`, `PublicationService`, and app-private journal | Frontend state projects results; it does not independently publish or reconcile containers. |
| Target I/O, app-private storage, clocks, and platform capabilities | Host-services implementations and Windows main process | Platform adapters implement the `libscpefe` host-services interface. |
| Format, cryptography, password-slot and lease policy, and permission checks | `libscpefe` and existing main-process orchestration | TypeScript must not duplicate backend decisions. |

Each state concern has exactly one authoritative owner. React subscribes to
the session snapshot and dispatches commands instead of maintaining a parallel
copy. In particular, React and
`DocumentSession` must never independently own the same working text, dirty
state, lifecycle phase, pending operation, or command eligibility. Derived
rendering values may be calculated from the authoritative snapshot without
becoming a second mutable source of truth.

`DocumentSession` now projects closed, locked, unlocked/read-only, and edit
lifecycle states through an immutable external snapshot. It retains target
identity after Lock but drops document and `WorkingCopy` references at lock
start; Close drops the target identity. It serializes state-changing frontend commands,
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
policy. Regular-save notices carry the originating working-copy scope and edit
revision so a late notice cannot attach to another adoption or demote a newer
manual save. Recovery decisions outside publication also flow through the
session and appear as semantic attention for React to present.
The class's journal drain waits for host update acknowledgements; the host
retains durable checkpoint and failure policy, and can report a later
checkpoint warning. The platform adapter supplies a fresh opaque journal
scope for each adoption and passes it with updates. The host echoes that
scope on delayed checkpoint warnings, so a warning from an earlier document
cannot fail the current working copy.

Shared React UI owns modal focus behavior through `FocusManager` and a
small DOM capability. Shared dialog rendering and Windows composition decide
when dialogs open, while the manager owns
modal depth, inert chrome, keyboard containment, and safe focus restoration.

The npm workspace packages expose TypeScript source through explicit public entry
points. Windows consumes them as workspace dependencies, so a clean install needs no
prebuilt package output. New renderer-side production modules are strict
TypeScript; this rule does not migrate unrelated main/preload JavaScript.
