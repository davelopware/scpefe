import { WorkingCopy, type WorkingCopyJournalHost } from "./working-copy.ts";

/** Host-validated document data required for frontend lifecycle projection. */
export interface SessionDocument {
  readonly content: string;
  readonly readOnly: boolean;
  readonly targetName?: string;
  readonly provisional?: true;
  readonly invitationRequired?: false;
}

/** A target awaiting invitation claim before its document is adopted. */
export interface SessionInvitation {
  readonly readOnly: true;
  readonly invitationRequired: true;
  readonly targetName?: string;
}

/** The lifecycle operations delegated to the host without replacing its barriers. */
export interface DocumentSessionHost<Doc extends SessionDocument,
  Invite extends SessionInvitation = SessionInvitation> {
  openSelectedDocument(password: string): Promise<Doc | Invite>;
  unlockDocument(password: string): Promise<Doc | Invite>;
  lock(): Promise<{ readonly locked: true; readonly journalSaved: boolean;
    readonly warningCode: string | null }>;
  closeDocument(): Promise<boolean>;
}

/** The active frontend command, without arguments or secrets. */
export type SessionPendingOperation = "open" | "unlock" | "lock" | "close";

/** A secret-free closed application state. */
export interface ClosedSessionSnapshot {
  readonly kind: "closed";
  readonly pending?: SessionPendingOperation;
}

/** A locked target with no reachable document or editing state. */
export interface LockedSessionSnapshot {
  readonly kind: "locked";
  readonly targetName: string | null;
  readonly pending?: SessionPendingOperation;
}

/** Unlocked viewing state; host edit authority is absent. */
export interface ReadOnlySessionSnapshot<Doc extends SessionDocument> {
  readonly kind: "read-only";
  readonly adoption: number;
  readonly targetName: string | null;
  readonly document: Readonly<Doc & { readonly readOnly: true }>;
  readonly pending?: SessionPendingOperation;
}

/** Unlocked state after the host has granted edit authority. */
export interface EditSessionSnapshot<Doc extends SessionDocument> {
  readonly kind: "edit";
  readonly adoption: number;
  readonly targetName: string | null;
  readonly document: Readonly<Doc & { readonly readOnly: false }>;
  readonly pending?: SessionPendingOperation;
}

/** The only lifecycle states visible to presentation adapters. */
export type DocumentSessionSnapshot<Doc extends SessionDocument> =
  | ClosedSessionSnapshot | LockedSessionSnapshot
  | ReadOnlySessionSnapshot<Doc> | EditSessionSnapshot<Doc>;

/** Stable command result that never carries raw host errors or secrets. */
export type DocumentSessionOutcome =
  | Readonly<{ status: "opened" | "invitation" | "closed" | "pending"
    | "superseded" }>
  | Readonly<{ status: "locked"; warningCode: SessionLockWarningCode | null }>
  | Readonly<{ status: "failed"; code: SessionFailureCode }>;

/** Codes that the platform message catalogue may safely present. */
export type SessionFailureCode = "OPERATION_FAILED" | "OPEN_FAILED"
  | "UNLOCK_FAILED" | "LOCK_CHECKPOINT_FAILED" | "LIFECYCLE_FAILED";

/** Lock warnings with an intentionally bounded presentation vocabulary. */
export type SessionLockWarningCode = "LOCK_CHECKPOINT_FAILED" | "OPERATION_FAILED";

const CLOSED: ClosedSessionSnapshot = Object.freeze({ kind: "closed" });
const SAFE_HOST_CODES = new Set<SessionFailureCode>([
  "OPERATION_FAILED", "OPEN_FAILED", "UNLOCK_FAILED", "LOCK_CHECKPOINT_FAILED",
  "LIFECYCLE_FAILED",
]);

function hostFailureCode(error: unknown): SessionFailureCode {
  if (typeof error !== "object" || error === null || !("name" in error)
    || error.name !== "SafeBoundaryError" || !("code" in error)) {
    return "OPERATION_FAILED";
  }
  const code = error.code;
  return typeof code === "string" && SAFE_HOST_CODES.has(code as SessionFailureCode)
    ? code as SessionFailureCode : "OPERATION_FAILED";
}

interface QueuedCommand {
  run(): Promise<DocumentSessionOutcome>;
  resolve(outcome: DocumentSessionOutcome): void;
}

function frozenCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.freeze(Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, frozenCopy(item)]))) as T;
  }
  return value;
}

/** Owns the frontend document lifecycle and its WorkingCopy. */
export class DocumentSession<Doc extends SessionDocument,
  Invite extends SessionInvitation = SessionInvitation> {
  private snapshot: DocumentSessionSnapshot<Doc> = CLOSED;
  private workingCopy: WorkingCopy | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly queuedCommands: QueuedCommand[] = [];
  private commandRunning = false;
  private generation = 0;
  private adoptionSequence = 0;
  private disposed = false;

  constructor(private readonly host: DocumentSessionHost<Doc, Invite>,
    private readonly journalHost: WorkingCopyJournalHost) {}

  getSnapshot = (): DocumentSessionSnapshot<Doc> => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Adopts a host-validated open result, replacing the previous frontend session. */
  adopt(result: Doc | Invite): DocumentSessionOutcome {
    if (this.disposed) return Object.freeze({ status: "superseded" });
    if (result.invitationRequired === true) {
      // The host stages an invitation without replacing the current document.
      return Object.freeze({ status: "invitation" });
    }
    const document = frozenCopy(result as Doc);
    const targetName = document.targetName ?? (this.snapshot.kind === "closed"
      ? null : this.snapshot.targetName);
    this.clearWorkingCopy();
    this.workingCopy = new WorkingCopy(this.journalHost);
    this.workingCopy.adoptOpen(document.content, Boolean(document.provisional));
    this.snapshot = this.openSnapshot(document, ++this.adoptionSequence, targetName);
    this.notify();
    return Object.freeze({ status: "opened" });
  }

  /** Applies a host-authorized metadata or mode update without replacing local edits. */
  refreshDocument(document: Doc): boolean {
    const current = this.snapshot;
    if (current.kind !== "read-only" && current.kind !== "edit") return false;
    const safeDocument = frozenCopy(document);
    this.snapshot = this.openSnapshot(safeDocument, current.adoption,
      safeDocument.targetName ?? current.targetName);
    this.notify();
    return true;
  }

  openSelected(password: string): Promise<DocumentSessionOutcome> {
    const generation = this.generation;
    return this.enqueue(() => {
      if (generation !== this.generation) {
        password = "";
        return Promise.resolve(Object.freeze({ status: "superseded" }));
      }
      let operation: Promise<Doc | Invite>;
      try {
        this.publishPending("open");
        operation = this.host.openSelectedDocument(password);
      } catch (error) {
        password = "";
        if (generation !== this.generation) {
          return Promise.resolve(Object.freeze({ status: "superseded" }));
        }
        this.clearPending();
        return Promise.resolve(Object.freeze({ status: "failed",
          code: hostFailureCode(error) }));
      }
      password = "";
      return operation.then((result) => {
        if (generation !== this.generation) return Object.freeze({ status: "superseded" });
        if (result.invitationRequired === true) this.clearPending();
        return this.adopt(result);
      }, (error) => {
        if (generation !== this.generation) return Object.freeze({ status: "superseded" });
        this.clearPending();
        return Object.freeze({ status: "failed" as const, code: hostFailureCode(error) });
      });
    });
  }

  unlock(password: string): Promise<DocumentSessionOutcome> {
    const generation = this.generation;
    return this.enqueue(() => {
      if (generation !== this.generation) {
        password = "";
        return Promise.resolve(Object.freeze({ status: "superseded" }));
      }
      let operation: Promise<Doc | Invite>;
      try {
        this.publishPending("unlock");
        operation = this.host.unlockDocument(password);
      } catch (error) {
        password = "";
        if (generation !== this.generation) {
          return Promise.resolve(Object.freeze({ status: "superseded" }));
        }
        this.clearPending();
        return Promise.resolve(Object.freeze({ status: "failed",
          code: hostFailureCode(error) }));
      }
      password = "";
      return operation.then((result) => {
        if (generation !== this.generation) return Object.freeze({ status: "superseded" });
        if (result.invitationRequired === true) this.clearPending();
        return this.adopt(result);
      }, (error) => {
        if (generation !== this.generation) return Object.freeze({ status: "superseded" });
        this.clearPending();
        return Object.freeze({ status: "failed" as const, code: hostFailureCode(error) });
      });
    });
  }

  /** Clears reachable frontend state at the host's lock-start safety point. */
  lockStarted(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.cancelQueuedCommands();
    if (this.snapshot.kind === "closed") return;
    const targetName = this.snapshot.targetName;
    this.snapshot = Object.freeze({ kind: "locked", targetName });
    this.clearWorkingCopy();
    this.notify();
  }

  lockCompleted(): void { this.lockStarted(); }

  closed(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.cancelQueuedCommands();
    this.snapshot = CLOSED;
    this.clearWorkingCopy();
    this.notify();
  }

  lock(): Promise<DocumentSessionOutcome> {
    return this.enqueue(async () => {
      try {
        this.publishPending("lock");
        const result = await this.host.lock();
        this.lockCompleted();
        const warningCode: SessionLockWarningCode | null = result.warningCode === null
          || result.warningCode === undefined ? null
            : result.warningCode === "LOCK_CHECKPOINT_FAILED"
              ? "LOCK_CHECKPOINT_FAILED" : "OPERATION_FAILED";
        return Object.freeze({ status: "locked" as const, warningCode });
      } catch (error) {
        this.clearPending();
        return Object.freeze({ status: "failed" as const,
          code: hostFailureCode(error) });
      }
    });
  }

  close(): Promise<DocumentSessionOutcome> {
    return this.enqueue(async () => {
      try {
        this.publishPending("close");
        const completed = await this.host.closeDocument();
        if (!completed) {
          this.clearPending();
          return Object.freeze({ status: "pending" as const });
        }
        this.closed();
        return Object.freeze({ status: "closed" as const });
      } catch (error) {
        this.clearPending();
        return Object.freeze({ status: "failed" as const,
          code: hostFailureCode(error) });
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.closed();
    this.listeners.clear();
    this.disposed = true;
  }

  private openSnapshot(document: Doc, adoption: number,
    targetName: string | null): ReadOnlySessionSnapshot<Doc>
    | EditSessionSnapshot<Doc> {
    return document.readOnly
      ? Object.freeze({ kind: "read-only", adoption, targetName,
        document: document as Doc & { readOnly: true } })
      : Object.freeze({ kind: "edit", adoption, targetName,
        document: document as Doc & { readOnly: false } });
  }

  private notify(): void { for (const listener of this.listeners) listener(); }

  private publishPending(pending: SessionPendingOperation): void {
    this.snapshot = Object.freeze({ ...this.snapshot, pending }) as DocumentSessionSnapshot<Doc>;
    this.notify();
  }

  private clearPending(): void {
    if (!("pending" in this.snapshot)) return;
    const { pending: _pending, ...state } = this.snapshot;
    this.snapshot = Object.freeze(state) as DocumentSessionSnapshot<Doc>;
    this.notify();
  }

  private clearWorkingCopy(): void {
    this.workingCopy?.dispose();
    this.workingCopy = null;
  }

  private enqueue(run: () => Promise<DocumentSessionOutcome>): Promise<DocumentSessionOutcome> {
    if (this.disposed) return Promise.resolve(Object.freeze({ status: "superseded" }));
    return new Promise((resolve) => {
      this.queuedCommands.push({ run, resolve });
      this.runNextCommand();
    });
  }

  private runNextCommand(): void {
    if (this.commandRunning) return;
    const command = this.queuedCommands.shift();
    if (!command) return;
    this.commandRunning = true;
    void Promise.resolve().then(command.run).then(command.resolve, () => {
      command.resolve(Object.freeze({ status: "failed", code: "LIFECYCLE_FAILED" }));
    }).finally(() => {
      this.commandRunning = false;
      this.runNextCommand();
    });
  }

  private cancelQueuedCommands(): void {
    for (const command of this.queuedCommands.splice(0)) {
      command.resolve(Object.freeze({ status: "superseded" }));
    }
  }
}
