# Issue #51: lease-refresh failure, lock message, and recovery

Investigated at integration commit `feedb2553a99889a725c7b754ec3c6e31045dd31`.
The immediate-lock policy remains in force. This document records a reproducible
renderer defect and a design for its implementation follow-up.

## Reproduction and boundary

The existing `lock-start-rendered-integration.desktop.ts` harness drives an edit
session's actual two-minute heartbeat callback through `DocumentService`,
`DocumentLifecycleHost`, the built preload, and the mounted production React
renderer. It uses a stateful fake native container and fault-injected target I/O;
it does not use a real remote provider or assistive technology. For this
investigation, a temporary assertion required **Editing lease refresh failed.**
to remain in the accessible status footer after lock completion. The renderer
and preload were rebuilt from the integration commit before the final run.

From `apps/windows`, the red-capable command was:

```sh
systemd-run --user --scope \
  -p MemoryHigh=768M -p MemoryMax=1G -p MemorySwapMax=0 -p TasksMax=256 \
  /usr/bin/time -v timeout --signal=TERM --kill-after=2s 30s \
  node --test --test-concurrency=1 \
  --test-name-pattern='mounted renderer wired to real DocumentService clears at lease-refresh-failed lock start' \
  test/lock-start-rendered-integration.desktop.ts
```

The same assertion failed repeatedly, including the rebuilt renderer run:
the final footer contained **Document locked. Use Security → Unlock to
continue.**, with no lease-refresh cause. The rebuilt run took 4.03 seconds,
peaked at 139,980 KB RSS, and used zero swaps. A changed target image injected
at the heartbeat read produced the same result (4.06 seconds, 140,280 KB RSS,
zero swaps). The temporary failing assertions and debug output were removed
after collecting this evidence.

The reproduced trigger is one dirty edit session, one due heartbeat, and a
failed target read or a different target image. Holding the final journal write
in the harness makes the lock-start and lock-complete phases separately
observable. The overwrite occurs at lock start, before that held write runs.

## Exact sequence and working-copy result

The storage-read reproduction produced this sequence (the first summary is
startup, the last follows lock completion):

```text
journal:summary
document:journal-warning { code: LEASE_REFRESH_FAILED }
document:lock-started
document:locked { journalSaved: true, warningCode: null }
journal:summary
```

The warning is emitted by `DocumentService.#scheduleHeartbeat` before it calls
`lock("lease-refresh-failed")`. `DocumentLifecycleHost` forwards it. The preload
validates the catalog code and the renderer's warning listener sets the message.
At `document:lock-started`, `useSessionEvents` calls `showLockedResult` with a
null warning code. That function synchronously clears mounted secrets and sets
the generic locked message. The status footer is already generic immediately
after that event; `document:locked` calls the same function with another null
warning code and leaves it generic. The subsequent journal summary changes the
recovery count, not the message. The footer has `role="status"`,
`aria-live="polite"`, and `aria-atomic="true"`; the specific warning was not
present in its DOM after lock. Whether a screen reader could announce the
earlier transient state was not tested.

The lock-start clearing correctly removes renderer plaintext before journal
I/O finishes. In the reproduced case, lock completion returned
`journalSaved: true`; reading the encrypted work journal confirmed an unsaved
record containing the fixture's draft. After restoring target access,
`openDocument` returned that draft as recovered work. This is a verified result
for the injected failure, not a guarantee when the final journal write fails.

## Cause, visible message, and safe action

| Failure class | Current visible result | Safe lock and return policy |
| --- | --- | --- |
| Target temporarily unavailable or I/O fails before a candidate is published | `LEASE_REFRESH_FAILED` is emitted, then generic **Document locked** remains. | Lock immediately because the lease cannot be verified. When target access returns, unlock, inspect recovered work and the authenticated current lease, then resume editing only if lease acquisition is allowed. A successful checkpoint preserves the unsaved draft locally. |
| Target image changes, including a lease or document change not yet authenticated | The exact-image check throws `LEASE_CHANGED`; the scheduler emits `LEASE_REFRESH_FAILED`, then generic **Document locked** remains. | Lock immediately. On return, authenticate and inspect the current target, lease, head, and recovered draft. Do not overwrite the changed image or silently claim its lease. Existing head, access, takeover, and divergence decisions govern further work. |
| Candidate publication has a definite or ambiguous failure | The scheduler currently emits the same lease warning and locks. Candidate publication may leave an encrypted pending-publication record. This branch was inspected in code, not fault-injected in the mounted probe. | Lock immediately. On return, reconcile or review the pending candidate before another edit or save. Do not describe an ambiguous publication as definitely failed or successful. |
| Heartbeat becomes stale because lock, release, or session replacement invalidates its generation | No lease-failure warning or second lock is emitted. A contained service test confirmed no warnings for a delayed heartbeat canceled by lock and by lease release. | Keep the already requested lock or release outcome; do not add a lease-failure message. |
| Final encrypted checkpoint fails during any lock | `LOCK_CHECKPOINT_FAILED` is returned at completion and is the more urgent message; a contained existing service test verified plaintext is cleared despite `journalSaved: false`. | Keep the lock. Tell the user that latest edits may be absent from recovery; after unlock, inspect available recovery before continuing. Never claim the draft was saved. |

The service cannot safely name a changed *document* from the heartbeat's
exact-image mismatch alone: it rejects the changed bytes before authenticating
them. A user-facing cause should therefore say **the target changed** or **the
editing lease could not be verified**, without claiming which document or editor
caused it. Raw I/O errors, paths, passwords, and document text must stay behind
the safe catalog boundary.

## Policy and implementation follow-up

Keep automatic locking for every non-stale refresh failure. A transient failure
could make another editor's lease state unknowable; the current session must not
continue claiming edit authority. A stale/canceled heartbeat is already
suppressed. Keep the synchronous lock-start secret clearing and the final
encrypted checkpoint attempt. When that checkpoint fails, its warning must take
priority over the lease-refresh wording.

The UI fix should carry a validated, safe lock cause through both lifecycle
notifications. At lock start, show the lease-refresh cause while clearing
secrets. At lock completion, show the checkpoint failure if `journalSaved` is
false; otherwise retain the lease-refresh cause and give the unlock/recovery
action. The existing `reason` in the service result is lost by
`validateLockResult`, and `document:lock-started` currently has no payload. A
small bounded code such as `LEASE_REFRESH_FAILED` can be derived from the known
lock reason in the host and validated at the preload boundary. The renderer
should not infer a durable cause from a preceding asynchronous warning event.

Tests for the implementation should include mounted service→host→preload→React
failure probes for target-read failure and changed image; assert the footer's
accessible text at lock start and completion, secret clearing before delayed
journal completion, and recovery after a successful checkpoint. Add a checkpoint
write failure case that preserves its stronger warning and makes no recovery
promise. Keep service coverage for stale/canceled heartbeats with zero warnings
and no extra lock. An ambiguous candidate-publication fault deserves a separate
reconciliation assertion because its pending record changes the return path.
