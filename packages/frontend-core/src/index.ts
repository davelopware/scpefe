/** A portable source of immutable presentation snapshots. */
export interface SnapshotSource<Snapshot> {
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
}

/** Checks the structural boundary used by presentation adapters. */
export function isSnapshotSource(value: unknown): value is SnapshotSource<unknown> {
  return typeof value === "object" && value !== null
    && "getSnapshot" in value && typeof value.getSnapshot === "function"
    && "subscribe" in value && typeof value.subscribe === "function";
}

export { WorkingCopy } from "./working-copy.ts";
export { DocumentSession } from "./document-session.ts";
export type { DocumentSessionHost, DocumentSessionOutcome, DocumentSessionSnapshot,
  SessionAttention, SessionCommands, SessionDocument, SessionEditAttention,
  SessionFailureCode, SessionInvitation,
  SessionLeaseAttention, SessionLeaseDecision, SessionLockWarningCode, SessionMergeDraft,
  SessionPendingOperation } from "./document-session.ts";
export type { WorkingCopyFindResult, WorkingCopyJournalHost, WorkingCopySelection,
  WorkingCopySnapshot,
  WorkingCopyUpdate } from "./working-copy.ts";
