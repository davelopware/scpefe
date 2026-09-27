# Frontend ownership and incremental cutover

The frontend application core presents a document session; it does not replace
the main-process `DocumentService` or the C++ `libscpefe` context. A frontend
`DocumentSession` will orchestrate presentation of the active target and own a
`WorkingCopy` while unlocked. The existing main-process services continue to
own lifecycle barriers, durable publication, storage, and security policy.

| Concern | Authoritative owner now | Owner after frontend migration | Boundary |
| --- | --- | --- | --- |
| Open, replacement, lock, unlock, and close presentation; active target identity in the UI | Windows React renderer | Frontend `DocumentSession` | Host services perform the actual document operation; the frontend presents its structured result. |
| Working text, manual-save baseline, dirty state, edit history, selection, and find/replace | Windows React renderer | `WorkingCopy` owned by frontend `DocumentSession` | Journal writes use a narrow host capability. |
| Command availability, semantic attention, and status shown to the user | Windows React renderer | Frontend `DocumentSession` | React maps attention and outcomes to dialogs and safe messages. |
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

`DocumentSession` begins only after successful target adoption, survives Lock
with target identity but without reachable plaintext or secrets, and ends at
Close. It serializes frontend commands; the main process retains its own
lifecycle barrier and durable safety guarantees. A locked snapshot cannot
contain editable working state. A future CLI can present the same semantic
attention as prompts without importing React or DOM behavior.

The npm workspace packages expose TypeScript source through explicit public entry
points. Windows consumes them as workspace dependencies, so a clean install needs no
prebuilt package output. New renderer-side production modules are strict
TypeScript; this rule does not migrate unrelated main/preload JavaScript.
