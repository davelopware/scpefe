import { WorkingCopy, type ReadyWorkingCopySnapshot, type WorkingCopyFindResult,
  type WorkingCopyJournalHost, type WorkingCopySelection } from "./working-copy.ts";

/** Host-validated document data required for frontend lifecycle projection. */
export interface SessionDocument {
  readonly content: string;
  readonly readOnly: boolean;
  readonly targetName?: string;
  readonly provisional?: true;
  readonly invitationRequired?: false;
  readonly canEdit?: boolean;
  readonly publicationState?: "target-published" | "pending-publication" | "conflict";
  readonly migrationRequired?: true;
  readonly recovery?: object;
  readonly headMismatch?: object;
  readonly profileMismatch?: object;
}

/** Command eligibility projected from the same state as the editor. */
export interface SessionCommands {
  readonly enterEdit: boolean;
  readonly write: boolean;
  readonly undo: boolean;
  readonly redo: boolean;
  readonly save: boolean;
  readonly backup: boolean;
  readonly export: boolean;
  readonly publicationRetry: boolean;
  readonly publicationDiscard: boolean;
}

/** The host's publication state plus a provisional revision still awaiting manual save. */
export type SessionPublicationState = "target-published" | "provisional"
  | "pending-publication" | "conflict";

/** Publication status shared by graphical and terminal presentation adapters. */
export interface SessionPublicationSnapshot {
  readonly state: SessionPublicationState;
  readonly resolving: boolean;
}

/** A target awaiting invitation claim before its document is adopted. */
export interface SessionInvitation {
  readonly readOnly: true;
  readonly invitationRequired: true;
  readonly targetName?: string;
}

/** Host-issued one-shot lease challenge; authorization stays inside the session. */
export interface SessionLeaseDecision {
  readonly decisionRequired: "lease-takeover";
  readonly operation: "edit" | "recovery" | "divergence" | "migration";
  readonly holderName: string;
  readonly authorization: string;
}

/** Safe identity context a presentation adapter may show to its user. */
export interface SessionLeaseAttention {
  readonly kind: "lease-takeover";
  readonly operation: SessionLeaseDecision["operation"];
  readonly holderName: string;
}

/** A failed edit transition that can be retried without retaining host error text. */
export interface SessionEditAttention {
  readonly kind: "edit-unavailable";
  readonly code: SessionFailureCode;
}

/** A locally saved candidate requiring an explicit publication decision. */
export interface SessionPublicationAttention {
  readonly kind: "publication-decision";
  readonly state: "pending-publication" | "conflict";
  readonly failureCode?: SessionFailureCode;
}

/** A failed manual save with a safe catalogue code for retry presentation. */
export interface SessionSaveAttention {
  readonly kind: "save-failed";
  readonly code: SessionFailureCode;
}

/** Semantic attention projected independently of a graphical dialog. */
export type SessionAttention = SessionLeaseAttention | SessionEditAttention
  | SessionPublicationAttention | SessionSaveAttention;

/** A host-produced merge draft for the lease-gated divergence workflow. */
export interface SessionMergeDraft {
  readonly content: string;
  readonly hasConflicts: boolean;
  readonly ancestorRevision: string;
  readonly localRevision: string;
  readonly currentRevision: string;
}

/** The lifecycle operations delegated to the host without replacing its barriers. */
export interface DocumentSessionHost<Doc extends SessionDocument,
  Invite extends SessionInvitation = SessionInvitation> {
  openSelectedDocument(password: string): Promise<Doc | Invite>;
  unlockDocument(password: string): Promise<Doc | Invite>;
  lock(): Promise<{ readonly locked: true; readonly journalSaved: boolean;
    readonly warningCode: string | null }>;
  closeDocument(): Promise<boolean>;
  enterEditMode(request?: { readonly authorization?: string }):
    Promise<Doc | SessionLeaseDecision>;
  cancelLeaseTakeover(authorization: string): Promise<boolean>;
  restoreRecoveredWork(request: { readonly authorization: string }): Promise<
    (Doc & { readonly recoveredUnsaved: true; readonly cursor: WorkingCopySelection })
    | SessionLeaseDecision>;
  beginDivergenceResolution(request?: { readonly authorization?: string }):
    Promise<SessionMergeDraft | SessionLeaseDecision>;
  migrateDocument(request: { readonly authorization: string }): Promise<
    { readonly opened: Doc; readonly compatibilityCode: string }
    | SessionLeaseDecision | null>;
  saveDocument(content: string): Promise<{ readonly saved: true; readonly content: string;
    readonly publicationState: "target-published" | "pending-publication" | "conflict" }>;
  saveDivergenceResolution(content: string): Promise<{ readonly saved: true;
    readonly content: string;
    readonly publicationState: "target-published" | "pending-publication" | "conflict" }>;
  reconnectPendingPublication(): Promise<{ readonly content: string;
    readonly publicationState: "target-published" | "pending-publication" | "conflict" }>;
  discardPendingPublication(): Promise<Doc>;
  backupDocument(): Promise<{ readonly backedUp: true } | null>;
  exportPlaintext(request: { readonly content: string;
    readonly lineEndings: "lf" | "native" }): Promise<{ readonly exported: true } | null>;
}

/** The active frontend command, without arguments or secrets. */
export type SessionPendingOperation = "open" | "unlock" | "lock" | "close"
  | "edit" | "lease-confirm" | "lease-cancel" | "save"
  | "publication-retry" | "publication-discard" | "backup" | "export"
  | "divergence";

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
  readonly publication: SessionPublicationSnapshot;
}

/** Unlocked viewing state; host edit authority is absent. */
export interface ReadOnlySessionSnapshot<Doc extends SessionDocument> {
  readonly kind: "read-only";
  readonly adoption: number;
  readonly targetName: string | null;
  readonly document: Readonly<Doc & { readonly readOnly: true }>;
  readonly working: ReadyWorkingCopySnapshot;
  readonly commands: SessionCommands;
  readonly publication: SessionPublicationSnapshot;
  readonly attention?: SessionAttention;
  readonly pending?: SessionPendingOperation;
  readonly queued?: "lease-confirm" | "lease-cancel";
}

/** Unlocked state after the host has granted edit authority. */
export interface EditSessionSnapshot<Doc extends SessionDocument> {
  readonly kind: "edit";
  readonly adoption: number;
  readonly targetName: string | null;
  readonly document: Readonly<Doc & { readonly readOnly: false }>;
  readonly working: ReadyWorkingCopySnapshot;
  readonly commands: SessionCommands;
  readonly publication: SessionPublicationSnapshot;
  readonly attention?: SessionAttention;
  readonly pending?: SessionPendingOperation;
  readonly queued?: "lease-confirm" | "lease-cancel";
}

/** The only lifecycle states visible to presentation adapters. */
export type DocumentSessionSnapshot<Doc extends SessionDocument> =
  | ClosedSessionSnapshot | LockedSessionSnapshot
  | ReadOnlySessionSnapshot<Doc> | EditSessionSnapshot<Doc>;

/** Stable command result that never carries raw host errors or secrets. */
export type DocumentSessionOutcome<Doc extends SessionDocument = SessionDocument> =
  | Readonly<{ status: "opened" | "invitation" | "closed" | "pending"
    | "superseded" | "attention" | "edit-mode" | "unavailable" }>
  | Readonly<{ status: "canceled"; revoked: boolean }>
  | Readonly<{ status: "saved"; publicationState: "target-published"
    | "pending-publication" | "conflict" }>
  | Readonly<{ status: "publication"; publicationState: "target-published"
    | "pending-publication" | "conflict" }>
  | Readonly<{ status: "publication-discarded" | "divergence-required" }>
  | Readonly<{ status: "unsaved-work" }>
  | Readonly<{ status: "backup"; created: boolean }>
  | Readonly<{ status: "export"; exported: boolean }>
  | Readonly<{ status: "recovery"; document: Doc & {
    readonly recoveredUnsaved: true; readonly cursor: WorkingCopySelection } }>
  | Readonly<{ status: "divergence"; draft: SessionMergeDraft }>
  | Readonly<{ status: "migration"; document: Doc;
    compatibilityCode: string }>
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

interface QueuedCommand<Doc extends SessionDocument> {
  run(): Promise<DocumentSessionOutcome<Doc>>;
  resolve(outcome: DocumentSessionOutcome<Doc>): void;
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
  private stopWorkingCopy: (() => void) | null = null;
  private leaseDecision: SessionLeaseDecision | null = null;
  private queuedLeaseOperation: "lease-confirm" | "lease-cancel" | null = null;
  private editFailureCode: SessionFailureCode | null = null;
  private publicationState: SessionPublicationState = "target-published";
  private publicationFailureCode: SessionFailureCode | null = null;
  private saveFailureCode: SessionFailureCode | null = null;
  private resolvingDivergence = false;
  private sealedRegularVersion: Readonly<{ journalScope: string; revision: number }> | null = null;
  private acceptedRegularVersion: Readonly<{ journalScope: string; revision: number }> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly queuedCommands: QueuedCommand<Doc>[] = [];
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
  adopt(result: Doc | Invite): DocumentSessionOutcome<Doc> {
    if (this.disposed) return Object.freeze({ status: "superseded" });
    if (result.invitationRequired === true) {
      // The host stages an invitation without replacing the current document.
      return Object.freeze({ status: "invitation" });
    }
    const document = frozenCopy(result as Doc);
    const targetName = document.targetName ?? (this.snapshot.kind === "closed"
      ? null : this.snapshot.targetName);
    this.clearWorkingCopy();
    this.leaseDecision = null;
    this.queuedLeaseOperation = null;
    this.editFailureCode = null;
    this.publicationFailureCode = null;
    this.saveFailureCode = null;
    this.resolvingDivergence = false;
    this.sealedRegularVersion = null;
    this.acceptedRegularVersion = null;
    this.publicationState = document.provisional ? "provisional"
      : document.publicationState ?? "target-published";
    this.workingCopy = new WorkingCopy(this.journalHost);
    this.workingCopy.adoptOpen(document.content, Boolean(document.provisional));
    if (!document.readOnly && document.provisional) {
      this.workingCopy.ensureJournalVersion();
    }
    this.stopWorkingCopy = this.workingCopy.subscribe(() => this.publishWorkingCopy());
    this.snapshot = this.openSnapshot(document, ++this.adoptionSequence, targetName);
    this.notify();
    return Object.freeze({ status: "opened" });
  }

  /** Applies a host-authorized metadata or mode update without replacing local edits. */
  refreshDocument(document: Doc): boolean {
    const current = this.snapshot;
    if (current.kind !== "read-only" && current.kind !== "edit") return false;
    const safeDocument = frozenCopy(document);
    if (safeDocument.publicationState !== current.document.publicationState
      || Boolean(safeDocument.provisional) !== Boolean(current.document.provisional)) {
      this.publicationState = safeDocument.provisional ? "provisional"
        : safeDocument.publicationState ?? "target-published";
      if (this.publicationState !== "conflict") this.resolvingDivergence = false;
      this.publicationFailureCode = null;
    }
    this.snapshot = this.openSnapshot(safeDocument, current.adoption,
      safeDocument.targetName ?? current.targetName, current.pending);
    this.notify();
    const copy = this.workingCopy;
    const working = copy?.getSnapshot();
    if (copy && current.kind === "read-only" && !safeDocument.readOnly
      && working?.kind === "ready" && working.dirty) {
      copy.ensureJournalVersion();
    }
    return true;
  }

  /** Requests host edit authority and represents a takeover challenge as safe attention. */
  enterEditMode(): Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(() => this.runEditOperation(generation, undefined, "edit", adoption));
  }

  /** Stages a challenge returned by another host operation for one-shot confirmation. */
  stageLeaseDecision(decision: SessionLeaseDecision, adoption: number): boolean {
    if ((this.snapshot.kind !== "read-only" && this.snapshot.kind !== "edit")
      || this.snapshot.adoption !== adoption) return false;
    this.leaseDecision = { ...decision };
    this.editFailureCode = null;
    this.publishWorkingCopy();
    return true;
  }

  /** Dismisses edit failure attention without changing host edit authority. */
  dismissEditFailure(): void {
    if (!this.editFailureCode) return;
    this.editFailureCode = null;
    this.publishWorkingCopy();
  }

  /** Dismisses a failed manual-save prompt while retaining the working copy. */
  dismissSaveFailure(): void {
    if (!this.saveFailureCode) return;
    this.saveFailureCode = null;
    this.publishWorkingCopy();
  }

  /** Consumes the edit challenge before invoking the host, including on fault. */
  confirmLeaseTakeover(): Promise<DocumentSessionOutcome<Doc>> {
    const decision = this.leaseDecision;
    if (!decision) {
      return Promise.resolve(Object.freeze({ status: "unavailable" }));
    }
    this.leaseDecision = null;
    this.queuedLeaseOperation = "lease-confirm";
    this.publishWorkingCopy();
    const generation = this.generation;
    const adoption = this.currentAdoption();
    const operation = decision.operation;
    let authorization = decision.authorization;
    return this.enqueue(() => {
      const used = authorization;
      authorization = "";
      return operation === "edit"
        ? this.runEditOperation(generation, used, "lease-confirm", adoption)
        : this.runOtherLeaseOperation(generation, operation, used, adoption);
    });
  }

  private async runOtherLeaseOperation(generation: number,
    operation: Exclude<SessionLeaseDecision["operation"], "edit">,
    authorization: string, adoption: number | null): Promise<DocumentSessionOutcome<Doc>> {
    if (!this.matchesAdoption(generation, adoption)) {
      return Object.freeze({ status: "superseded" });
    }
    this.publishPending("lease-confirm");
    try {
      if (operation === "recovery") {
        const result = await this.host.restoreRecoveredWork({ authorization });
        if (!this.matchesAdoption(generation, adoption)) return Object.freeze({ status: "superseded" });
        this.clearPending();
        if ("decisionRequired" in result) {
          this.stageLeaseDecision(result, adoption!);
          return Object.freeze({ status: "attention" });
        }
        this.publishWorkingCopy();
        return Object.freeze({ status: "recovery", document: frozenCopy(result) });
      }
      if (operation === "divergence") {
        const result = await this.host.beginDivergenceResolution({ authorization });
        if (!this.matchesAdoption(generation, adoption)) return Object.freeze({ status: "superseded" });
        if ("decisionRequired" in result) {
          this.clearPending();
          this.stageLeaseDecision(result, adoption!);
          return Object.freeze({ status: "attention" });
        }
        this.resolvingDivergence = true;
        this.clearPending();
        return Object.freeze({ status: "divergence", draft: frozenCopy(result) });
      }
      const result = await this.host.migrateDocument({ authorization });
      if (!this.matchesAdoption(generation, adoption)) return Object.freeze({ status: "superseded" });
      this.clearPending();
      if (!result) {
        this.publishWorkingCopy();
        return Object.freeze({ status: "unavailable" });
      }
      if ("decisionRequired" in result) {
        this.stageLeaseDecision(result, adoption!);
        return Object.freeze({ status: "attention" });
      }
      this.publishWorkingCopy();
      return Object.freeze({ status: "migration", document: frozenCopy(result.opened),
        compatibilityCode: result.compatibilityCode });
    } catch (error) {
      if (!this.matchesAdoption(generation, adoption)) return Object.freeze({ status: "superseded" });
      this.clearPending();
      this.publishWorkingCopy();
      return Object.freeze({ status: "failed", code: hostFailureCode(error) });
    }
  }

  /** Consumes a pending challenge even if host revocation fails. */
  cancelLeaseTakeover(): Promise<DocumentSessionOutcome<Doc>> {
    const decision = this.leaseDecision;
    if (!decision) return Promise.resolve(Object.freeze({ status: "unavailable" }));
    this.leaseDecision = null;
    this.queuedLeaseOperation = "lease-cancel";
    this.publishWorkingCopy();
    const generation = this.generation;
    const adoption = this.currentAdoption();
    let authorization = decision.authorization;
    return this.enqueue(async () => {
      if (!this.matchesAdoption(generation, adoption)) return Object.freeze({ status: "superseded" });
      this.publishPending("lease-cancel");
      const used = authorization;
      authorization = "";
      try {
        const revoked = await this.host.cancelLeaseTakeover(used);
        if (!this.matchesAdoption(generation, adoption)) return Object.freeze({ status: "superseded" });
        this.clearPending();
        this.publishWorkingCopy();
        return Object.freeze({ status: "canceled" as const, revoked });
      } catch (error) {
        if (!this.matchesAdoption(generation, adoption)) return Object.freeze({ status: "superseded" });
        this.clearPending();
        this.publishWorkingCopy();
        return Object.freeze({ status: "failed" as const, code: hostFailureCode(error) });
      }
    });
  }

  private async runEditOperation(generation: number, authorization?: string,
    pending: SessionPendingOperation = "edit", adoption = this.currentAdoption()):
    Promise<DocumentSessionOutcome<Doc>> {
    if (!this.matchesAdoption(generation, adoption) || this.snapshot.kind !== "read-only") {
      return Object.freeze({ status: "superseded" });
    }
    this.editFailureCode = null;
    this.publishPending(pending);
    try {
      const result = await this.host.enterEditMode(authorization
        ? { authorization } : {});
      if (!this.matchesAdoption(generation, adoption)) return Object.freeze({ status: "superseded" });
      this.clearPending();
      if ("decisionRequired" in result) {
        this.stageLeaseDecision(result, adoption!);
        return Object.freeze({ status: "attention" });
      }
      if (result.readOnly) {
        this.editFailureCode = "LIFECYCLE_FAILED";
        this.publishWorkingCopy();
        return Object.freeze({ status: "failed", code: "LIFECYCLE_FAILED" });
      }
      this.refreshDocument(result);
      return Object.freeze({ status: "edit-mode" });
    } catch (error) {
      if (!this.matchesAdoption(generation, adoption)) return Object.freeze({ status: "superseded" });
      this.clearPending();
      const code = hostFailureCode(error);
      this.editFailureCode = code;
      this.publishWorkingCopy();
      return Object.freeze({ status: "failed", code });
    }
  }

  /** Applies an editor change before any asynchronous journal acknowledgement. */
  edit(text: string, selection?: WorkingCopySelection): boolean {
    if (this.snapshot.kind !== "edit" || !this.workingCopy) return false;
    this.workingCopy.edit(text, selection);
    return true;
  }

  /** Saves the current working copy through the host's authoritative transaction. */
  save(): Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(async () => {
      if (!this.matchesAdoption(generation, adoption)
        || this.snapshot.kind !== "edit" || !this.workingCopy
        || !this.snapshot.commands.save) {
        return Object.freeze({ status: "unavailable" });
      }
      const content = this.snapshot.working.text;
      const submittedVersion = this.workingCopy.journalVersion();
      const divergence = this.publicationState === "conflict";
      this.saveFailureCode = null;
      this.publishPending("save");
      try {
        const result = await (divergence
          ? this.host.saveDivergenceResolution(content)
          : this.host.saveDocument(content));
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.publicationState = result.publicationState;
        if (result.publicationState !== "conflict") this.resolvingDivergence = false;
        this.publicationFailureCode = null;
        this.sealedRegularVersion = submittedVersion;
        this.workingCopy.sealPublication(result.content, content);
        const current: DocumentSessionSnapshot<Doc> = this.getSnapshot();
        if (current.kind !== "read-only" && current.kind !== "edit") {
          return Object.freeze({ status: "superseded" });
        }
        this.refreshDocument({ ...current.document, content: result.content,
          readOnly: result.publicationState !== "target-published",
          publicationState: result.publicationState, provisional: undefined } as Doc);
        this.clearPending();
        return Object.freeze({ status: "saved", publicationState: result.publicationState });
      } catch (error) {
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.saveFailureCode = hostFailureCode(error);
        this.clearPending();
        return Object.freeze({ status: "failed", code: this.saveFailureCode });
      }
    });
  }

  /** Reconnects the host's exact pending candidate without constructing a new one. */
  retryPublication(): Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(async () => {
      if (!this.matchesAdoption(generation, adoption)
        || (this.snapshot.kind !== "read-only" && this.snapshot.kind !== "edit")
        || !this.snapshot.commands.publicationRetry) {
        return Object.freeze({ status: "unavailable" });
      }
      if (this.publicationState === "conflict") {
        return Object.freeze({ status: "divergence-required" });
      }
      this.publicationFailureCode = null;
      this.publishPending("publication-retry");
      try {
        const result = await this.host.reconnectPendingPublication();
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.publicationState = result.publicationState;
        this.resolvingDivergence = false;
        const current = this.snapshot;
        if (current.kind !== "read-only" && current.kind !== "edit") {
          return Object.freeze({ status: "superseded" });
        }
        this.workingCopy?.sealPublication(result.content, current.document.content);
        this.refreshDocument({ ...current.document, content: result.content,
          readOnly: true,
          publicationState: result.publicationState } as Doc);
        this.clearPending();
        return Object.freeze({ status: "publication",
          publicationState: result.publicationState });
      } catch (error) {
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.publicationFailureCode = hostFailureCode(error);
        this.clearPending();
        return Object.freeze({ status: "failed", code: this.publicationFailureCode });
      }
    });
  }

  /** Starts conflict resolution under the same adoption and command ordering as publication. */
  beginDivergenceResolution(options: { readonly discardUnsaved?: boolean } = {}):
    Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(async () => {
      if (!this.matchesAdoption(generation, adoption)
        || this.publicationState !== "conflict" || this.resolvingDivergence) {
        return Object.freeze({ status: "unavailable" });
      }
      const current = this.snapshot;
      if (current.kind !== "read-only" && current.kind !== "edit") {
        return Object.freeze({ status: "unavailable" });
      }
      if (current.working.dirty) {
        if (!options.discardUnsaved) return Object.freeze({ status: "unsaved-work" });
        this.workingCopy?.adoptPublication(current.document.content);
      }
      this.publicationFailureCode = null;
      this.publishPending("divergence");
      try {
        const result = await this.host.beginDivergenceResolution();
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        if ("decisionRequired" in result) {
          this.clearPending();
          this.stageLeaseDecision(result, adoption!);
          return Object.freeze({ status: "attention" });
        }
        this.resolvingDivergence = true;
        this.clearPending();
        return Object.freeze({ status: "divergence", draft: frozenCopy(result) });
      } catch (error) {
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.publicationFailureCode = hostFailureCode(error);
        this.clearPending();
        return Object.freeze({ status: "failed", code: this.publicationFailureCode });
      }
    });
  }

  /** Explicitly abandons a locally saved candidate after host confirmation. */
  discardPublication(): Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(async () => {
      if (!this.matchesAdoption(generation, adoption)
        || (this.snapshot.kind !== "read-only" && this.snapshot.kind !== "edit")
        || !this.snapshot.commands.publicationDiscard) {
        return Object.freeze({ status: "unavailable" });
      }
      this.publicationFailureCode = null;
      this.publishPending("publication-discard");
      try {
        const document = await this.host.discardPendingPublication();
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.publicationState = document.provisional ? "provisional"
          : document.publicationState ?? "target-published";
        this.resolvingDivergence = false;
        if (document.provisional) this.workingCopy?.adoptOpen(document.content, true);
        else this.workingCopy?.adoptPublication(document.content);
        this.refreshDocument(document);
        this.clearPending();
        return Object.freeze({ status: "publication-discarded" });
      } catch (error) {
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.publicationFailureCode = hostFailureCode(error);
        this.clearPending();
        return Object.freeze({ status: "failed", code: this.publicationFailureCode });
      }
    });
  }

  /** Requests a host-verified backup only when the current document is eligible. */
  backup(): Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(async () => {
      if (!this.matchesAdoption(generation, adoption)
        || (this.snapshot.kind !== "read-only" && this.snapshot.kind !== "edit")
        || !this.snapshot.commands.backup) {
        return Object.freeze({ status: "unavailable" });
      }
      this.publishPending("backup");
      try {
        const result = await this.host.backupDocument();
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.clearPending();
        return Object.freeze({ status: "backup", created: result !== null });
      } catch (error) {
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.clearPending();
        return Object.freeze({ status: "failed", code: hostFailureCode(error) });
      }
    });
  }

  /** Exports the current text through the host's existing plaintext privacy policy. */
  exportPlaintext(lineEndings: "lf" | "native"): Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(async () => {
      if (!this.matchesAdoption(generation, adoption)
        || (this.snapshot.kind !== "read-only" && this.snapshot.kind !== "edit")
        || !this.snapshot.commands.export) {
        return Object.freeze({ status: "unavailable" });
      }
      const content = this.snapshot.working.text;
      this.publishPending("export");
      try {
        const result = await this.host.exportPlaintext({ content, lineEndings });
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.clearPending();
        return Object.freeze({ status: "export", exported: result !== null });
      } catch (error) {
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.clearPending();
        return Object.freeze({ status: "failed", code: hostFailureCode(error) });
      }
    });
  }

  setSelection(selection: WorkingCopySelection): boolean {
    if ((this.snapshot.kind !== "edit" && this.snapshot.kind !== "read-only")
      || !this.workingCopy) return false;
    this.workingCopy.setSelection(selection);
    return true;
  }

  undo(): boolean {
    return this.snapshot.kind === "edit" && this.workingCopy?.undo() === true;
  }

  redo(): boolean {
    return this.snapshot.kind === "edit" && this.workingCopy?.redo() === true;
  }

  findNext(query: string): WorkingCopyFindResult | null {
    if (this.snapshot.kind !== "edit" && this.snapshot.kind !== "read-only") return null;
    return this.workingCopy?.findNext(query) ?? null;
  }

  replaceSelection(query: string, replacement: string): WorkingCopyFindResult
    | Readonly<{ status: "replaced" }> | null {
    if (this.snapshot.kind !== "edit") return null;
    return this.workingCopy?.replaceSelection(query, replacement) ?? null;
  }

  replaceAll(query: string, replacement: string): Readonly<{ replacements: number }> | null {
    if (this.snapshot.kind !== "edit") return null;
    return this.workingCopy?.replaceAll(query, replacement) ?? null;
  }

  markProvisional(text?: string): boolean {
    if (!this.workingCopy) return false;
    this.workingCopy.markProvisional(text);
    return true;
  }

  /** Applies a host regular-save notification without sealing the manual baseline. */
  regularSavePublished(result: { readonly published: true; readonly provisional: true;
    readonly content: string; readonly journalScope: string;
    readonly revision: number }): boolean {
    const current = this.snapshot;
    const version = this.workingCopy?.journalVersion();
    if (current.kind !== "edit" || !this.workingCopy || !version
      || result.journalScope !== version.journalScope
      || !Number.isSafeInteger(result.revision) || result.revision < 1
      || result.revision > version.revision
      || (this.sealedRegularVersion?.journalScope === result.journalScope
        && result.revision <= this.sealedRegularVersion.revision)
      || (this.acceptedRegularVersion?.journalScope === result.journalScope
        && result.revision <= this.acceptedRegularVersion.revision)
      || this.publicationState === "pending-publication"
      || this.publicationState === "conflict") return false;
    this.acceptedRegularVersion = Object.freeze({ journalScope: result.journalScope,
      revision: result.revision });
    this.publicationState = "provisional";
    if (current.working.text === result.content) {
      this.workingCopy.markProvisional(result.content);
    } else {
      this.workingCopy.markProvisional();
    }
    this.refreshDocument({ ...current.document, content: result.content,
      provisional: true } as Doc);
    return true;
  }

  adoptPublication(text: string): boolean {
    if (!this.workingCopy) return false;
    this.publicationState = "target-published";
    this.resolvingDivergence = false;
    this.sealedRegularVersion = null;
    this.acceptedRegularVersion = null;
    this.publicationFailureCode = null;
    this.saveFailureCode = null;
    this.workingCopy.adoptPublication(text);
    return true;
  }

  adoptRecovery(text: string, selection: WorkingCopySelection): boolean {
    if (!this.workingCopy) return false;
    this.workingCopy.adoptRecovery(text, selection);
    this.workingCopy.ensureJournalVersion();
    return true;
  }

  adoptDivergence(text: string): boolean {
    if (!this.workingCopy) return false;
    this.publicationState = "conflict";
    this.resolvingDivergence = true;
    this.workingCopy.adoptDivergence(text);
    return true;
  }

  openSelected(password: string): Promise<DocumentSessionOutcome<Doc>> {
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

  unlock(password: string): Promise<DocumentSessionOutcome<Doc>> {
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
    this.leaseDecision = null;
    this.queuedLeaseOperation = null;
    this.editFailureCode = null;
    this.publicationFailureCode = null;
    this.saveFailureCode = null;
    this.resolvingDivergence = false;
    this.sealedRegularVersion = null;
    this.acceptedRegularVersion = null;
    this.cancelQueuedCommands();
    if (this.snapshot.kind === "closed") return;
    const targetName = this.snapshot.targetName;
    this.snapshot = Object.freeze({ kind: "locked", targetName,
      publication: Object.freeze({ state: this.publicationState,
        resolving: this.resolvingDivergence }) });
    this.clearWorkingCopy();
    this.notify();
  }

  lockCompleted(): void { this.lockStarted(); }

  closed(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.leaseDecision = null;
    this.queuedLeaseOperation = null;
    this.editFailureCode = null;
    this.publicationFailureCode = null;
    this.saveFailureCode = null;
    this.resolvingDivergence = false;
    this.sealedRegularVersion = null;
    this.acceptedRegularVersion = null;
    this.cancelQueuedCommands();
    this.snapshot = CLOSED;
    this.publicationState = "target-published";
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
    targetName: string | null, pending?: SessionPendingOperation): ReadOnlySessionSnapshot<Doc>
    | EditSessionSnapshot<Doc> {
    const working = this.workingCopy?.getSnapshot();
    if (!working || working.kind !== "ready") {
      throw new Error("unlocked document requires a working copy");
    }
    const commands: SessionCommands = Object.freeze({
      enterEdit: document.readOnly && document.canEdit === true
        && (document.publicationState === undefined
          || document.publicationState === "target-published")
        && !document.recovery && !document.headMismatch && !document.profileMismatch
        && !document.migrationRequired,
      write: !document.readOnly,
      undo: !document.readOnly && working.canUndo,
      redo: !document.readOnly && working.canRedo,
      save: !document.readOnly && working.dirty && pending === undefined,
      backup: !working.dirty && this.publicationState === "target-published"
        && !document.provisional && !document.recovery && !document.headMismatch
        && !document.profileMismatch && !document.migrationRequired && pending === undefined,
      export: pending === undefined,
      publicationRetry: (this.publicationState === "pending-publication"
        || this.publicationState === "conflict") && !this.resolvingDivergence
        && pending === undefined,
      publicationDiscard: (this.publicationState === "pending-publication"
        || this.publicationState === "conflict") && !this.resolvingDivergence
        && !working.dirty
        && pending === undefined,
    });
    const attention: SessionAttention | undefined = this.leaseDecision
      ? Object.freeze({ kind: "lease-takeover", operation: this.leaseDecision.operation,
        holderName: this.leaseDecision.holderName })
      : this.editFailureCode ? Object.freeze({ kind: "edit-unavailable",
        code: this.editFailureCode })
      : this.saveFailureCode ? Object.freeze({ kind: "save-failed",
        code: this.saveFailureCode })
      : (this.publicationState === "pending-publication"
        || this.publicationState === "conflict") && !this.resolvingDivergence
        ? Object.freeze({ kind: "publication-decision", state: this.publicationState,
          ...(this.publicationFailureCode
            ? { failureCode: this.publicationFailureCode } : {}) }) : undefined;
    return document.readOnly
      ? Object.freeze({ kind: "read-only", adoption, targetName, working, commands,
        publication: Object.freeze({ state: this.publicationState,
          resolving: this.resolvingDivergence }),
        ...(pending ? { pending } : {}),
        ...(attention ? { attention } : {}),
        ...(this.queuedLeaseOperation ? { queued: this.queuedLeaseOperation } : {}),
        document: document as Doc & { readOnly: true } })
      : Object.freeze({ kind: "edit", adoption, targetName, working, commands,
        publication: Object.freeze({ state: this.publicationState,
          resolving: this.resolvingDivergence }),
        ...(pending ? { pending } : {}),
        ...(attention ? { attention } : {}),
        ...(this.queuedLeaseOperation ? { queued: this.queuedLeaseOperation } : {}),
        document: document as Doc & { readOnly: false } });
  }

  private publishWorkingCopy(): void {
    const current = this.snapshot;
    if (current.kind !== "read-only" && current.kind !== "edit") return;
    this.snapshot = this.openSnapshot(current.document, current.adoption,
      current.targetName, current.pending);
    this.notify();
  }

  private notify(): void { for (const listener of this.listeners) listener(); }

  private publishPending(pending: SessionPendingOperation): void {
    this.queuedLeaseOperation = null;
    if (this.snapshot.kind === "read-only" || this.snapshot.kind === "edit") {
      this.snapshot = this.openSnapshot(this.snapshot.document, this.snapshot.adoption,
        this.snapshot.targetName, pending);
      this.notify();
      return;
    }
    const { queued: _queued, ...state } = this.snapshot as
      DocumentSessionSnapshot<Doc> & { queued?: "lease-confirm" | "lease-cancel" };
    this.snapshot = Object.freeze({ ...state, pending }) as DocumentSessionSnapshot<Doc>;
    this.notify();
  }

  private clearPending(): void {
    if (!("pending" in this.snapshot)) return;
    if (this.snapshot.kind === "read-only" || this.snapshot.kind === "edit") {
      this.snapshot = this.openSnapshot(this.snapshot.document, this.snapshot.adoption,
        this.snapshot.targetName);
      this.notify();
      return;
    }
    const { pending: _pending, ...state } = this.snapshot;
    this.snapshot = Object.freeze(state) as DocumentSessionSnapshot<Doc>;
    this.notify();
  }

  private clearWorkingCopy(): void {
    this.stopWorkingCopy?.();
    this.stopWorkingCopy = null;
    this.workingCopy?.dispose();
    this.workingCopy = null;
  }

  private currentAdoption(): number | null {
    return this.snapshot.kind === "read-only" || this.snapshot.kind === "edit"
      ? this.snapshot.adoption : null;
  }

  private matchesAdoption(generation: number, adoption: number | null): boolean {
    return generation === this.generation && adoption !== null
      && this.currentAdoption() === adoption;
  }

  private enqueue(run: () => Promise<DocumentSessionOutcome<Doc>>): Promise<DocumentSessionOutcome<Doc>> {
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
