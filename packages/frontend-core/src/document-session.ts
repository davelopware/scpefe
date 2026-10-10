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
  readonly migrationCanEdit?: boolean;
  readonly recovery?: SessionRecoveryRecord;
  readonly headMismatch?: { readonly kind: "rollback" | "divergence"
    | "replacement" | "witness-error"; readonly title?: string;
    readonly explanation?: string; readonly editingBlocked?: true };
  readonly profileMismatch?: object;
  readonly unreadableJournal?: true;
  readonly canAddPasswords?: boolean;
  readonly canRemovePasswords?: boolean;
  readonly recoverySlot?: boolean;
  readonly managedSlots?: ReadonlyArray<{ readonly slotId: string }>;
}

/** Host-validated recovery evidence; content remains in the document, not attention. */
export interface SessionRecoveryRecord {
  readonly content: string;
  readonly state: "unsaved";
  readonly updateTime: number;
  readonly cursor: WorkingCopySelection;
  readonly authorName?: string;
  readonly deviceName?: string;
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
  readonly recoveryRestore: boolean;
  readonly recoveryDiscard: boolean;
  readonly acceptHeadMismatch: boolean;
  readonly unreadableDiscard: boolean;
  readonly changePassword: boolean;
  readonly createInvitation: boolean;
  readonly reconcileIdentity: boolean;
  readonly updateSlotPermissions: boolean;
  readonly removeSlot: boolean;
  readonly migrate: boolean;
  readonly compact: boolean;
}

/** A password slot's requested permissions; the host remains the final authority. */
export interface SessionSlotPermissions {
  readonly slotId: string;
  readonly canEdit: boolean;
  readonly canAddPasswords: boolean;
  readonly canRemovePasswords: boolean;
}

/** An invitation request without the one-time passphrase returned by the host. */
export interface SessionInvitationRequest {
  readonly temporaryLabel: string;
  readonly temporaryPassword?: string;
  readonly canEdit: boolean;
  readonly canAddPasswords: boolean;
  readonly canRemovePasswords: boolean;
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

/** Opaque host-issued request retained until the presentation adapter can open it. */
export interface SessionExternalOpenRequest {
  readonly token: string;
}

/** Secret-free external-open ordering visible in every lifecycle state. */
export interface SessionExternalOpenSnapshot {
  readonly active: boolean;
  readonly queued: number;
}

/** Host evidence retained privately while frontend state projects protection. */
export interface SessionProtectionState {
  readonly dirty: boolean;
  readonly provisional: boolean;
  readonly pendingPublication: boolean;
  readonly recovered: boolean;
  readonly conflict: boolean;
  readonly unresolvedJournal: boolean;
  readonly activePublication: boolean;
}

/** A host barrier challenge for one replacing or terminating operation. */
export interface SessionProtectionRequest {
  readonly token: string;
  readonly operation: "new" | "open" | "external-open" | "close" | "exit";
  readonly state: SessionProtectionState;
}

/** Presentation-safe lifecycle choice derived from the current session. */
export interface SessionProtectionAttention {
  readonly kind: "lifecycle-protection";
  readonly operation: SessionProtectionRequest["operation"];
  readonly state: SessionProtectionState;
  readonly resolving: boolean;
  readonly failureCode?: SessionFailureCode;
}

/** Host-issued one-shot lease challenge; authorization stays inside the session. */
export interface SessionLeaseDecision {
  readonly decisionRequired: "lease-takeover";
  readonly operation: "edit" | "recovery" | "divergence" | "migration";
  readonly holderName: string;
  readonly authorization: string;
  readonly reason?: "master";
}

/** Safe identity context a presentation adapter may show to its user. */
export interface SessionLeaseAttention {
  readonly kind: "lease-takeover";
  readonly operation: SessionLeaseDecision["operation"];
  readonly holderName: string;
  readonly reason?: "master";
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

/** Safe recovery context and retry state for any presentation adapter. */
export interface SessionRecoveryAttention {
  readonly kind: "recovery-decision";
  readonly updateTime: number;
  readonly authorName?: string;
  readonly deviceName?: string;
  readonly canRestore: boolean;
  readonly failureCode?: SessionFailureCode;
}

/** Safe authenticated-head decision without host prose or paths. */
export interface SessionHeadAttention {
  readonly kind: "head-mismatch";
  readonly mismatchKind: NonNullable<SessionDocument["headMismatch"]>["kind"];
  readonly failureCode?: SessionFailureCode;
}

/** An unreadable protected journal requiring explicit disposal before editing. */
export interface SessionUnreadableJournalAttention {
  readonly kind: "unreadable-journal";
  readonly failureCode?: SessionFailureCode;
}

/** Migration needs a verified backup and may require a fresh lease decision. */
export interface SessionMigrationAttention {
  readonly kind: "migration-decision";
  readonly canMigrate: boolean;
  readonly canceled?: true;
  readonly failureCode?: SessionFailureCode;
}

/** A full administrator's one-time acknowledgement of irreversible compaction. */
export interface SessionCompactionAttention {
  readonly kind: "compaction-decision";
  readonly failureCode?: SessionFailureCode;
}

/** Bounded count of unresolved journals visible without their paths or contents. */
export interface SessionRecoveryDiscoveryAttention {
  readonly kind: "recovery-discovery";
  readonly total: number;
  readonly pendingPublications: number;
}

/** Validated recovery discovery summary retained across document transitions. */
export interface SessionRecoveryDiscovery {
  readonly total: number;
  readonly pendingPublications: number;
}

/** Semantic attention projected independently of a graphical dialog. */
export type SessionAttention = SessionLeaseAttention | SessionEditAttention
  | SessionPublicationAttention | SessionSaveAttention | SessionRecoveryAttention
  | SessionHeadAttention | SessionUnreadableJournalAttention
  | SessionRecoveryDiscoveryAttention | SessionMigrationAttention
  | SessionCompactionAttention | SessionProtectionAttention;

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
  createDocument?(request: object): Promise<{ readonly created: true;
    readonly opened: Doc; readonly name: string } | null>;
  openSelectedDocument(password: string): Promise<Doc | Invite>;
  openExternalDocument?(request: SessionExternalOpenRequest & { readonly password: string }):
    Promise<Doc | Invite | null>;
  cancelExternalOpen?(request: SessionExternalOpenRequest): Promise<boolean>;
  resolveProtection?(request: { readonly token: string;
    readonly decision: "cancel" | "save" | "discard" }): Promise<{
      readonly completed: boolean; readonly proceed: boolean;
      readonly retryToken?: string; readonly errorCode?: string }>;
  unlockDocument(password: string): Promise<Doc | Invite>;
  lock(): Promise<{ readonly locked: true; readonly journalSaved: boolean;
    readonly warningCode: string | null }>;
  closeDocument(): Promise<boolean>;
  exitApplication?(): Promise<boolean>;
  enterEditMode(request?: { readonly authorization?: string }):
    Promise<Doc | SessionLeaseDecision>;
  cancelLeaseTakeover(authorization: string): Promise<boolean>;
  restoreRecoveredWork(request?: { readonly authorization?: string }): Promise<
    (Doc & { readonly recoveredUnsaved: true; readonly cursor: WorkingCopySelection })
    | SessionLeaseDecision>;
  beginDivergenceResolution(request?: { readonly authorization?: string }):
    Promise<SessionMergeDraft | SessionLeaseDecision>;
  migrateDocument(request?: { readonly authorization?: string }): Promise<
    { readonly opened: Doc; readonly compatibilityCode: string }
    | SessionLeaseDecision | null>;
  compactDocument?(request: { readonly confirmed: true }): Promise<{
    readonly opened: Doc; readonly previousHead: string; readonly head: string } | null>;
  saveDocument(content: string): Promise<{ readonly saved: true; readonly content: string;
    readonly publicationState: "target-published" | "pending-publication" | "conflict" }>;
  saveDivergenceResolution(content: string): Promise<{ readonly saved: true;
    readonly content: string;
    readonly publicationState: "target-published" | "pending-publication" | "conflict" }>;
  reconnectPendingPublication(): Promise<{ readonly content: string;
    readonly publicationState: "target-published" | "pending-publication" | "conflict" }>;
  discardPendingPublication(): Promise<Doc>;
  discardRecoveredWork(): Promise<Doc>;
  acceptHeadMismatch(): Promise<Doc>;
  discardUnreadableJournal(): Promise<Doc>;
  backupDocument(): Promise<{ readonly backedUp: true } | null>;
  exportPlaintext(request: { readonly content: string;
    readonly lineEndings: "lf" | "native" }): Promise<{ readonly exported: true } | null>;
  changePassword?(request: { readonly currentPassword: string; readonly newPassword: string;
    readonly newPasswordConfirmation: string }): Promise<Doc>;
  createInvitation?(request: SessionInvitationRequest): Promise<{
    readonly created: true; readonly temporaryPassword: string; readonly opened: Doc }>;
  claimInvitation?(request: { readonly newPassword: string;
    readonly newPasswordConfirmation: string }): Promise<Doc>;
  cancelInvitationClaim?(): Promise<boolean>;
  reconcileIdentity?(): Promise<Doc>;
  updateSlotPermissions?(request: SessionSlotPermissions): Promise<Doc>;
  removeSlot?(slotId: string): Promise<{ readonly removed: true;
    readonly warningCode: "SLOT_REMOVED"; readonly opened: Doc }>;
}

/** The active frontend command, without arguments or secrets. */
export type SessionPendingOperation = "open" | "unlock" | "lock" | "close"
  | "external-open" | "external-cancel"
  | "create" | "exit"
  | "edit" | "lease-confirm" | "lease-cancel" | "save"
  | "recovery-restore" | "recovery-discard"
  | "head-accept"
  | "unreadable-discard"
  | "publication-retry" | "publication-discard" | "backup" | "export"
  | "divergence"
  | "password-change" | "invitation-create" | "invitation-claim"
  | "invitation-cancel" | "identity-reconcile" | "permissions-update"
  | "slot-remove" | "migration" | "compaction";

/** A secret-free closed application state. */
export interface ClosedSessionSnapshot {
  readonly kind: "closed";
  readonly invitationStaged?: true;
  readonly pending?: SessionPendingOperation;
  readonly attention?: SessionRecoveryDiscoveryAttention | SessionProtectionAttention;
  readonly discovery?: SessionRecoveryDiscovery;
  readonly externalOpen?: SessionExternalOpenSnapshot;
}

/** A locked target with no reachable document or editing state. */
export interface LockedSessionSnapshot {
  readonly kind: "locked";
  readonly invitationStaged?: true;
  readonly targetName: string | null;
  readonly pending?: SessionPendingOperation;
  readonly publication: SessionPublicationSnapshot;
  readonly attention?: SessionRecoveryDiscoveryAttention | SessionProtectionAttention;
  readonly discovery?: SessionRecoveryDiscovery;
  readonly externalOpen?: SessionExternalOpenSnapshot;
}

/** Unlocked viewing state; host edit authority is absent. */
export interface ReadOnlySessionSnapshot<Doc extends SessionDocument> {
  readonly kind: "read-only";
  readonly invitationStaged?: true;
  readonly adoption: number;
  readonly targetName: string | null;
  readonly document: Readonly<Doc & { readonly readOnly: true }>;
  readonly working: ReadyWorkingCopySnapshot;
  readonly commands: SessionCommands;
  readonly publication: SessionPublicationSnapshot;
  readonly discovery?: SessionRecoveryDiscovery;
  readonly externalOpen?: SessionExternalOpenSnapshot;
  readonly attention?: SessionAttention;
  readonly pending?: SessionPendingOperation;
  readonly queued?: "lease-confirm" | "lease-cancel";
}

/** Unlocked state after the host has granted edit authority. */
export interface EditSessionSnapshot<Doc extends SessionDocument> {
  readonly kind: "edit";
  readonly invitationStaged?: true;
  readonly adoption: number;
  readonly targetName: string | null;
  readonly document: Readonly<Doc & { readonly readOnly: false }>;
  readonly working: ReadyWorkingCopySnapshot;
  readonly commands: SessionCommands;
  readonly publication: SessionPublicationSnapshot;
  readonly discovery?: SessionRecoveryDiscovery;
  readonly externalOpen?: SessionExternalOpenSnapshot;
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
    | "superseded" | "attention" | "edit-mode" | "unavailable" | "created" }>
  | Readonly<{ status: "canceled"; revoked: boolean }>
  | Readonly<{ status: "saved"; publicationState: "target-published"
    | "pending-publication" | "conflict" }>
  | Readonly<{ status: "publication"; publicationState: "target-published"
    | "pending-publication" | "conflict" }>
  | Readonly<{ status: "publication-discarded" | "divergence-required" }>
  | Readonly<{ status: "unsaved-work" }>
  | Readonly<{ status: "backup"; created: boolean }>
  | Readonly<{ status: "export"; exported: boolean }>
  | Readonly<{ status: "recovery" | "recovery-discarded" }>
  | Readonly<{ status: "head-accepted" }>
  | Readonly<{ status: "unreadable-discarded" }>
  | Readonly<{ status: "divergence"; hasConflicts: boolean }>
  | Readonly<{ status: "migration"; compatibilityCode: string }>
  | Readonly<{ status: "migration-canceled" | "compaction-canceled" }>
  | Readonly<{ status: "external-canceled" }>
  | Readonly<{ status: "protection-canceled" | "protection-resolved" }>
  | Readonly<{ status: "compaction"; previousHead: string; head: string }>
  | Readonly<{ status: "locked"; warningCode: SessionLockWarningCode | null }>
  | Readonly<{ status: "password-changed" | "invitation-created"
    | "identity-reconciled" | "permissions-updated" | "claim-canceled"
    | "invitation-claimed" }>
  | Readonly<{ status: "slot-removed"; warningCode: "SLOT_REMOVED" }>
  | Readonly<{ status: "failed"; code: SessionFailureCode }>;

/** Codes that the platform message catalogue may safely present. */
export type SessionFailureCode = "OPERATION_FAILED" | "OPEN_FAILED"
  | "UNLOCK_FAILED" | "LOCK_CHECKPOINT_FAILED" | "LIFECYCLE_FAILED"
  | "WEAK_PASSWORD" | "PASSWORD_ALREADY_IN_USE"
  | "MIGRATION_FAILED" | "COMPACTION_FAILED";

/** Lock warnings with an intentionally bounded presentation vocabulary. */
export type SessionLockWarningCode = "LOCK_CHECKPOINT_FAILED" | "OPERATION_FAILED";

const CLOSED: ClosedSessionSnapshot = Object.freeze({ kind: "closed" });
const SAFE_HOST_CODES = new Set<SessionFailureCode>([
  "OPERATION_FAILED", "OPEN_FAILED", "UNLOCK_FAILED", "LOCK_CHECKPOINT_FAILED",
  "LIFECYCLE_FAILED", "WEAK_PASSWORD", "PASSWORD_ALREADY_IN_USE",
  "MIGRATION_FAILED", "COMPACTION_FAILED",
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
  private recoveryFailureCode: SessionFailureCode | null = null;
  private headFailureCode: SessionFailureCode | null = null;
  private unreadableFailureCode: SessionFailureCode | null = null;
  private migrationFailureCode: SessionFailureCode | null = null;
  private migrationCanceled = false;
  private compactionFailureCode: SessionFailureCode | null = null;
  private compactionConfirmation = false;
  private resolvingDivergence = false;
  private discovery: SessionRecoveryDiscovery = Object.freeze({ total: 0,
    pendingPublications: 0 });
  private sealedRegularVersion: Readonly<{ journalScope: string; revision: number }> | null = null;
  private acceptedRegularVersion: Readonly<{ journalScope: string; revision: number }> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly workListeners = new Set<() => void>();
  private readonly queuedCommands: QueuedCommand<Doc>[] = [];
  private commandRunning = false;
  private generation = 0;
  private adoptionSequence = 0;
  private invitationStaged = false;
  private invitationEpoch = 0;
  private disposed = false;
  private readonly externalOpenQueue: SessionExternalOpenRequest[] = [];
  private activeExternalOpen: SessionExternalOpenRequest | null = null;
  private protectionRequest: { token: string;
    operation: SessionProtectionRequest["operation"]; state: SessionProtectionState;
    generation: number; resolving: boolean; failureCode: SessionFailureCode | null } | null = null;

  constructor(private readonly host: DocumentSessionHost<Doc, Invite>,
    private readonly journalHost: WorkingCopyJournalHost) {}

  getSnapshot = (): DocumentSessionSnapshot<Doc> => this.snapshot;

  /** Host teardown waits for commands and current-journal writes that can still settle. */
  getPendingWorkCount = (): number => {
    const current = this.snapshot;
    const journal = current.kind === "read-only" || current.kind === "edit"
      ? current.working.journal.pending : 0;
    return this.queuedCommands.length + Number(this.commandRunning) + journal;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  subscribeWork = (listener: () => void): (() => void) => {
    this.workListeners.add(listener);
    return () => { this.workListeners.delete(listener); };
  };

  /** Updates safe recovery discovery shared by all presentation adapters. */
  observeRecoveryDiscovery(summary: SessionRecoveryDiscovery): boolean {
    if (!Number.isSafeInteger(summary.total) || summary.total < 0
      || !Number.isSafeInteger(summary.pendingPublications)
      || summary.pendingPublications < 0
      || summary.pendingPublications > summary.total) return false;
    this.discovery = Object.freeze({ total: summary.total,
      pendingPublications: summary.pendingPublications });
    if (this.snapshot.kind === "read-only" || this.snapshot.kind === "edit") {
      this.publishWorkingCopy();
    } else {
      const { attention: _attention, discovery: _discovery, ...current } = this.snapshot;
      this.snapshot = Object.freeze({ ...current,
        ...(summary.total > 0 ? { discovery: this.discovery,
          attention: this.discoveryAttention() } : {}) }) as DocumentSessionSnapshot<Doc>;
      this.notify();
    }
    return true;
  }

  private discoveryAttention(): SessionRecoveryDiscoveryAttention {
    return Object.freeze({ kind: "recovery-discovery", ...this.discovery });
  }

  /** Adopts a host-validated open result, replacing the previous frontend session. */
  adopt(result: Doc | Invite): DocumentSessionOutcome<Doc> {
    if (this.disposed) return Object.freeze({ status: "superseded" });
    if (result.invitationRequired === true) {
      // The host stages an invitation without replacing the current document.
      this.invitationStaged = true;
      this.invitationEpoch += 1;
      if (this.snapshot.kind === "read-only" || this.snapshot.kind === "edit") {
        this.publishWorkingCopy();
      } else {
        this.snapshot = Object.freeze({ ...this.snapshot, invitationStaged: true });
        this.notify();
      }
      return Object.freeze({ status: "invitation" });
    }
    this.invitationStaged = false;
    this.protectionRequest = null;
    this.activeExternalOpen = null;
    this.invitationEpoch += 1;
    const document = frozenCopy(result as Doc);
    const targetName = document.targetName ?? (this.snapshot.kind === "closed"
      ? null : this.snapshot.targetName);
    this.clearWorkingCopy();
    this.leaseDecision = null;
    this.queuedLeaseOperation = null;
    this.editFailureCode = null;
    this.publicationFailureCode = null;
    this.saveFailureCode = null;
    this.recoveryFailureCode = null;
    this.headFailureCode = null;
    this.unreadableFailureCode = null;
    this.migrationFailureCode = null;
    this.migrationCanceled = false;
    this.compactionFailureCode = null;
    this.compactionConfirmation = false;
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

  /** Tries the normal lease transition once for a newly authenticated document. */
  private async adoptAuthenticated(result: Doc | Invite): Promise<DocumentSessionOutcome<Doc>> {
    const outcome = this.adopt(result);
    if (outcome.status !== "opened" || this.snapshot.kind !== "read-only"
      || !this.snapshot.commands.enterEdit) return outcome;
    const generation = this.generation;
    const adoption = this.snapshot.adoption;
    const edit = await this.runEditOperation(generation, undefined, "edit", adoption);
    return edit.status === "superseded" ? edit : outcome;
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
    if (safeDocument.recovery?.updateTime !== current.document.recovery?.updateTime
      || safeDocument.recovery?.content !== current.document.recovery?.content) {
      this.recoveryFailureCode = null;
    }
    if (safeDocument.headMismatch?.kind !== current.document.headMismatch?.kind) {
      this.headFailureCode = null;
    }
    if (safeDocument.unreadableJournal !== current.document.unreadableJournal) {
      this.unreadableFailureCode = null;
    }
    if (safeDocument.migrationRequired !== current.document.migrationRequired) {
      this.migrationFailureCode = null;
      this.migrationCanceled = false;
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

  /** Applies an asynchronous profile update only to its original adoption. */
  refreshDocumentForAdoption(document: Doc, adoption: number): boolean {
    return this.currentAdoption() === adoption && this.refreshDocument(document);
  }

  /** Changes the active slot password, then projects the host's verified document. */
  changePassword(request: { readonly currentPassword: string;
    readonly newPassword: string; readonly newPasswordConfirmation: string }):
    Promise<DocumentSessionOutcome<Doc>> {
    return this.runSecurityDocumentCommand("changePassword", "password-change",
      "password-changed", () => this.host.changePassword?.(request));
  }

  /** Publishes an invitation; its one-time passphrase is delivered only to presentation. */
  createInvitation(request: SessionInvitationRequest,
    showPassphrase: (passphrase: string) => void): Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(async () => {
      if (!this.matchesAdoption(generation, adoption)) {
        return Object.freeze({ status: "superseded" });
      }
      if ((this.snapshot.kind !== "read-only" && this.snapshot.kind !== "edit")
        || !this.snapshot.commands.createInvitation || !this.host.createInvitation) {
        return Object.freeze({ status: "unavailable" });
      }
      this.publishPending("invitation-create");
      try {
        const result = await this.host.createInvitation(request);
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.refreshDocument(result.opened);
        this.clearPending();
        showPassphrase(result.temporaryPassword);
        return Object.freeze({ status: "invitation-created" });
      } catch (error) {
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.clearPending();
        return Object.freeze({ status: "failed", code: hostFailureCode(error) });
      }
    });
  }

  /** Claims a staged invitation only while its original session generation survives. */
  claimInvitation(request: { readonly newPassword: string;
    readonly newPasswordConfirmation: string }): Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const epoch = this.invitationEpoch;
    return this.enqueue(async () => {
      if (generation !== this.generation || epoch !== this.invitationEpoch) {
        return Object.freeze({ status: "superseded" });
      }
      if (!this.invitationStaged || !this.host.claimInvitation) {
        return Object.freeze({ status: "unavailable" });
      }
      this.publishPending("invitation-claim");
      try {
        const document = await this.host.claimInvitation(request);
        if (generation !== this.generation || epoch !== this.invitationEpoch) {
          return Object.freeze({ status: "superseded" });
        }
        this.adopt(document);
        return Object.freeze({ status: "invitation-claimed" });
      } catch (error) {
        if (generation !== this.generation || epoch !== this.invitationEpoch) {
          return Object.freeze({ status: "superseded" });
        }
        this.clearPending();
        return Object.freeze({ status: "failed", code: hostFailureCode(error) });
      }
    });
  }

  /** Cancels a staged invitation while retaining the authoritative prior document. */
  cancelInvitationClaim(): Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const epoch = this.invitationEpoch;
    return this.enqueue(async () => {
      if (generation !== this.generation || epoch !== this.invitationEpoch) {
        return Object.freeze({ status: "superseded" });
      }
      if (!this.invitationStaged || !this.host.cancelInvitationClaim) {
        return Object.freeze({ status: "unavailable" });
      }
      this.publishPending("invitation-cancel");
      try {
        const canceled = await this.host.cancelInvitationClaim();
        if (generation !== this.generation || epoch !== this.invitationEpoch) {
          return Object.freeze({ status: "superseded" });
        }
        if (!canceled) {
          this.clearPending();
          return Object.freeze({ status: "failed", code: "LIFECYCLE_FAILED" });
        }
        this.invitationStaged = false;
        this.invitationEpoch += 1;
        this.clearPending();
        this.publishInvitationState();
        return Object.freeze({ status: "claim-canceled" });
      } catch (error) {
        if (generation !== this.generation || epoch !== this.invitationEpoch) {
          return Object.freeze({ status: "superseded" });
        }
        this.clearPending();
        return Object.freeze({ status: "failed", code: hostFailureCode(error) });
      }
    });
  }

  /** Reconciles the active slot against the protected local profile. */
  reconcileIdentity(): Promise<DocumentSessionOutcome<Doc>> {
    return this.runSecurityDocumentCommand("reconcileIdentity", "identity-reconcile",
      "identity-reconciled", () => this.host.reconcileIdentity?.());
  }

  /** Publishes permissions and adopts the host's canonical slot list. */
  updateSlotPermissions(request: SessionSlotPermissions): Promise<DocumentSessionOutcome<Doc>> {
    return this.runSecurityDocumentCommand("updateSlotPermissions", "permissions-update",
      "permissions-updated", () => this.host.updateSlotPermissions?.(request));
  }

  /** Removes a slot and adopts the host's canonical slot list. */
  removeSlot(slotId: string): Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(async () => {
      if (!this.matchesAdoption(generation, adoption)) {
        return Object.freeze({ status: "superseded" });
      }
      if ((this.snapshot.kind !== "read-only" && this.snapshot.kind !== "edit")
        || !this.snapshot.commands.removeSlot || !this.host.removeSlot) {
        return Object.freeze({ status: "unavailable" });
      }
      this.publishPending("slot-remove");
      try {
        const result = await this.host.removeSlot(slotId);
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.refreshDocument(result.opened);
        this.clearPending();
        return Object.freeze({ status: "slot-removed", warningCode: "SLOT_REMOVED" });
      } catch (error) {
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.clearPending();
        return Object.freeze({ status: "failed", code: hostFailureCode(error) });
      }
    });
  }

  private runSecurityDocumentCommand(command: "changePassword" | "reconcileIdentity"
    | "updateSlotPermissions", pending: SessionPendingOperation,
    status: "password-changed" | "identity-reconciled" | "permissions-updated",
    invoke: () => Promise<Doc> | undefined): Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(async () => {
      if (!this.matchesAdoption(generation, adoption)) {
        return Object.freeze({ status: "superseded" });
      }
      if ((this.snapshot.kind !== "read-only" && this.snapshot.kind !== "edit")
        || !this.snapshot.commands[command]) {
        return Object.freeze({ status: "unavailable" });
      }
      this.publishPending(pending);
      try {
        const operation = invoke();
        if (!operation) {
          this.clearPending();
          return Object.freeze({ status: "unavailable" });
        }
        const document = await operation;
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.refreshDocument(document);
        this.clearPending();
        return Object.freeze({ status });
      } catch (error) {
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.clearPending();
        return Object.freeze({ status: "failed", code: hostFailureCode(error) });
      }
    });
  }

  private publishInvitationState(): void {
    if (this.snapshot.kind === "read-only" || this.snapshot.kind === "edit") {
      this.publishWorkingCopy();
    } else {
      const { invitationStaged: _staged, ...current } = this.snapshot;
      this.snapshot = Object.freeze({ ...current,
        ...(this.invitationStaged ? { invitationStaged: true } : {}) });
      this.notify();
    }
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
    if (decision.operation === "recovery") this.recoveryFailureCode = null;
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

  /** Restores host-verified recovery into the session-owned working copy. */
  restoreRecovery(): Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(async () => {
      if (!this.matchesAdoption(generation, adoption)
        || (this.snapshot.kind !== "read-only" && this.snapshot.kind !== "edit")
        || !this.snapshot.commands.recoveryRestore) {
        return Object.freeze({ status: "unavailable" });
      }
      this.recoveryFailureCode = null;
      this.publishPending("recovery-restore");
      try {
        const result = await this.host.restoreRecoveredWork();
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        if ("decisionRequired" in result) {
          this.clearPending();
          this.stageLeaseDecision(result, adoption!);
          return Object.freeze({ status: "attention" });
        }
        this.replaceWorkingDocument(result as Doc, "recovery", result.cursor);
        return Object.freeze({ status: "recovery" });
      } catch (error) {
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.recoveryFailureCode = hostFailureCode(error);
        this.clearPending();
        return Object.freeze({ status: "failed", code: this.recoveryFailureCode });
      }
    });
  }

  /** Discards host recovery and re-adopts its returned authenticated target. */
  discardRecovery(): Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(async () => {
      if (!this.matchesAdoption(generation, adoption)
        || (this.snapshot.kind !== "read-only" && this.snapshot.kind !== "edit")
        || !this.snapshot.commands.recoveryDiscard) {
        return Object.freeze({ status: "unavailable" });
      }
      this.recoveryFailureCode = null;
      this.publishPending("recovery-discard");
      try {
        const result = await this.host.discardRecoveredWork();
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.replaceWorkingDocument(result, "open");
        return Object.freeze({ status: "recovery-discarded" });
      } catch (error) {
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.recoveryFailureCode = hostFailureCode(error);
        this.clearPending();
        return Object.freeze({ status: "failed", code: this.recoveryFailureCode });
      }
    });
  }

  /** Accepts only the currently adopted host-observed authenticated head. */
  acceptHeadMismatch(): Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(async () => {
      if (!this.matchesAdoption(generation, adoption)
        || (this.snapshot.kind !== "read-only" && this.snapshot.kind !== "edit")
        || !this.snapshot.commands.acceptHeadMismatch) {
        return Object.freeze({ status: "unavailable" });
      }
      this.headFailureCode = null;
      this.publishPending("head-accept");
      try {
        const document = await this.host.acceptHeadMismatch();
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.replaceWorkingDocument(document, "open");
        return Object.freeze({ status: "head-accepted" });
      } catch (error) {
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.headFailureCode = hostFailureCode(error);
        this.clearPending();
        return Object.freeze({ status: "failed", code: this.headFailureCode });
      }
    });
  }

  /** Discards only host-confirmed unreadable journal evidence for this adoption. */
  discardUnreadableJournal(): Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(async () => {
      if (!this.matchesAdoption(generation, adoption)
        || (this.snapshot.kind !== "read-only" && this.snapshot.kind !== "edit")
        || !this.snapshot.commands.unreadableDiscard) {
        return Object.freeze({ status: "unavailable" });
      }
      this.unreadableFailureCode = null;
      this.publishPending("unreadable-discard");
      try {
        const document = await this.host.discardUnreadableJournal();
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.replaceWorkingDocument(document, "open");
        return Object.freeze({ status: "unreadable-discarded" });
      } catch (error) {
        if (!this.matchesAdoption(generation, adoption)) {
          return Object.freeze({ status: "superseded" });
        }
        this.unreadableFailureCode = hostFailureCode(error);
        this.clearPending();
        return Object.freeze({ status: "failed", code: this.unreadableFailureCode });
      }
    });
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

  /** Begins migration only for the current, host-authorized legacy document. */
  migrate(): Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(() => this.runMigration(generation, adoption));
  }

  private async runMigration(generation: number, adoption: number | null,
    authorization?: string): Promise<DocumentSessionOutcome<Doc>> {
    if (!this.matchesAdoption(generation, adoption)
      || (this.snapshot.kind !== "read-only" && this.snapshot.kind !== "edit")
      || !this.snapshot.commands.migrate) return Object.freeze({ status: "unavailable" });
    this.migrationFailureCode = null;
    this.migrationCanceled = false;
    this.publishPending(authorization ? "lease-confirm" : "migration");
    try {
      const result = await this.host.migrateDocument(authorization ? { authorization } : {});
      if (!this.matchesAdoption(generation, adoption)) return Object.freeze({ status: "superseded" });
      if (result !== null && "decisionRequired" in result) {
        this.clearPending();
        this.stageLeaseDecision(result, adoption!);
        return Object.freeze({ status: "attention" });
      }
      if (result === null) {
        this.migrationCanceled = true;
        this.clearPending();
        return Object.freeze({ status: "migration-canceled" });
      }
      this.replaceWorkingDocument(result.opened, "open");
      return Object.freeze({ status: "migration",
        compatibilityCode: result.compatibilityCode });
    } catch (error) {
      if (!this.matchesAdoption(generation, adoption)) return Object.freeze({ status: "superseded" });
      this.migrationFailureCode = hostFailureCode(error);
      this.clearPending();
      return Object.freeze({ status: "failed", code: this.migrationFailureCode });
    }
  }

  /** Stages a per-adoption irreversible compaction decision. */
  requestCompaction(): DocumentSessionOutcome<Doc> {
    if (this.snapshot.kind !== "edit" || !this.snapshot.commands.compact) {
      return Object.freeze({ status: "unavailable" });
    }
    this.compactionConfirmation = true;
    this.compactionFailureCode = null;
    this.publishWorkingCopy();
    return Object.freeze({ status: "attention" });
  }

  /** Dismisses an unconsumed compaction acknowledgement. */
  cancelCompaction(): DocumentSessionOutcome<Doc> {
    if (!this.compactionConfirmation) return Object.freeze({ status: "unavailable" });
    this.compactionConfirmation = false;
    this.compactionFailureCode = null;
    this.publishWorkingCopy();
    return Object.freeze({ status: "compaction-canceled" });
  }

  /** Consumes confirmation before the serialized host call starts. */
  confirmCompaction(): Promise<DocumentSessionOutcome<Doc>> {
    if (!this.compactionConfirmation) {
      return Promise.resolve(Object.freeze({ status: "unavailable" }));
    }
    this.compactionConfirmation = false;
    this.publishWorkingCopy();
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(async () => {
      if (!this.matchesAdoption(generation, adoption)
        || this.snapshot.kind !== "edit" || !this.snapshot.commands.compact
        || !this.host.compactDocument) return Object.freeze({ status: "unavailable" });
      this.compactionFailureCode = null;
      this.publishPending("compaction");
      try {
        const result = await this.host.compactDocument({ confirmed: true });
        if (!this.matchesAdoption(generation, adoption)) return Object.freeze({ status: "superseded" });
        if (result === null) {
          this.compactionConfirmation = true;
          this.clearPending();
          return Object.freeze({ status: "compaction-canceled" });
        }
        this.replaceWorkingDocument(result.opened, "open");
        return Object.freeze({ status: "compaction",
          previousHead: result.previousHead, head: result.head });
      } catch (error) {
        if (!this.matchesAdoption(generation, adoption)) return Object.freeze({ status: "superseded" });
        this.compactionConfirmation = true;
        this.compactionFailureCode = hostFailureCode(error);
        this.clearPending();
        return Object.freeze({ status: "failed", code: this.compactionFailureCode });
      }
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
        if ("decisionRequired" in result) {
          this.clearPending();
          this.stageLeaseDecision(result, adoption!);
          return Object.freeze({ status: "attention" });
        }
        this.replaceWorkingDocument(result as Doc, "recovery", result.cursor);
        return Object.freeze({ status: "recovery" });
      }
      if (operation === "divergence") {
        const result = await this.host.beginDivergenceResolution({ authorization });
        if (!this.matchesAdoption(generation, adoption)) return Object.freeze({ status: "superseded" });
        if ("decisionRequired" in result) {
          this.clearPending();
          this.stageLeaseDecision(result, adoption!);
          return Object.freeze({ status: "attention" });
        }
        this.adoptMergeDraft(result);
        return Object.freeze({ status: "divergence", hasConflicts: result.hasConflicts });
      }
      this.clearPending();
      return this.runMigration(generation, adoption, authorization);
    } catch (error) {
      if (!this.matchesAdoption(generation, adoption)) return Object.freeze({ status: "superseded" });
      if (operation === "recovery") this.recoveryFailureCode = hostFailureCode(error);
      if (operation === "divergence") this.publicationFailureCode = hostFailureCode(error);
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
    if (!this.snapshot.commands.enterEdit) {
      return Object.freeze({ status: "unavailable" });
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
    if (this.snapshot.kind !== "edit" || !this.snapshot.commands.write
      || !this.workingCopy) return false;
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
        this.adoptMergeDraft(result);
        return Object.freeze({ status: "divergence", hasConflicts: result.hasConflicts });
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
    return this.snapshot.kind === "edit" && this.snapshot.commands.undo
      && this.workingCopy?.undo() === true;
  }

  redo(): boolean {
    return this.snapshot.kind === "edit" && this.snapshot.commands.redo
      && this.workingCopy?.redo() === true;
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

  /** Retains each host request until modal attention permits presentation. */
  queueExternalOpen(request: SessionExternalOpenRequest): boolean {
    if (this.disposed || typeof request.token !== "string" || request.token.length === 0
      || this.activeExternalOpen?.token === request.token
      || this.externalOpenQueue.some((item) => item.token === request.token)) return false;
    this.externalOpenQueue.push(Object.freeze({ token: request.token }));
    this.publishExternalOpen();
    return true;
  }

  /** Adopts the active command's challenge or a native Exit challenge for this open session. */
  stageProtection(request: SessionProtectionRequest): boolean {
    const expected: Record<SessionProtectionRequest["operation"], SessionPendingOperation> = {
      new: "create", open: "open", "external-open": "external-open",
      close: "close", exit: "exit",
    };
    if (this.disposed || this.protectionRequest || typeof request?.token !== "string"
      || request.token.length === 0 || !request.state
      || !Object.hasOwn(expected, request.operation)
      || (this.snapshot.pending !== expected[request.operation]
        && !(request.operation === "exit" && (this.snapshot.kind === "read-only"
          || this.snapshot.kind === "edit")))
      || !["dirty", "provisional", "pendingPublication", "recovered", "conflict",
        "unresolvedJournal", "activePublication"].every((key) =>
        typeof request.state[key as keyof SessionProtectionState] === "boolean")) return false;
    this.protectionRequest = { token: request.token, operation: request.operation,
      state: Object.freeze({ dirty: request.state.dirty,
        provisional: request.state.provisional,
        pendingPublication: request.state.pendingPublication,
        recovered: request.state.recovered, conflict: request.state.conflict,
        unresolvedJournal: request.state.unresolvedJournal,
        activePublication: request.state.activePublication }),
      generation: this.generation, resolving: false, failureCode: null };
    this.publishProtection();
    return true;
  }

  /** Resolves a nested host protection choice without deadlocking its waiting command. */
  async decideProtection(decision: "cancel" | "save" | "discard"):
    Promise<DocumentSessionOutcome<Doc>> {
    const pending = this.protectionRequest;
    if (!pending || pending.resolving || !this.host.resolveProtection) {
      return Object.freeze({ status: "unavailable" });
    }
    pending.resolving = true;
    pending.failureCode = null;
    this.publishProtection();
    try {
      const result = await this.host.resolveProtection({ token: pending.token, decision });
      if (pending !== this.protectionRequest || pending.generation !== this.generation) {
        return Object.freeze({ status: "superseded" });
      }
      if (!result.completed) {
        if (result.retryToken) pending.token = result.retryToken;
        pending.resolving = false;
        pending.failureCode = result.errorCode === "LIFECYCLE_FAILED"
          ? "LIFECYCLE_FAILED" : "OPERATION_FAILED";
        this.publishProtection();
        return Object.freeze({ status: "failed", code: pending.failureCode });
      }
      this.protectionRequest = null;
      this.publishProtection();
      return Object.freeze({ status: !result.proceed || decision === "cancel"
        ? "protection-canceled" : "protection-resolved" });
    } catch (error) {
      if (pending !== this.protectionRequest || pending.generation !== this.generation) {
        return Object.freeze({ status: "superseded" });
      }
      pending.resolving = false;
      pending.failureCode = hostFailureCode(error);
      this.publishProtection();
      return Object.freeze({ status: "failed", code: pending.failureCode });
    }
  }

  /** Selects the oldest retained request for password entry. */
  activateExternalOpen(): boolean {
    if (this.activeExternalOpen || this.externalOpenQueue.length === 0) return false;
    this.activeExternalOpen = this.externalOpenQueue.shift()!;
    this.publishExternalOpen();
    return true;
  }

  /** Authenticates the active request; the host alone commits the candidate. */
  openExternal(password: string): Promise<DocumentSessionOutcome<Doc>> {
    const request = this.activeExternalOpen;
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(async () => {
      if (!request || request !== this.activeExternalOpen
        || generation !== this.generation || adoption !== this.currentAdoption()
        || !this.host.openExternalDocument) {
        password = "";
        return Object.freeze({ status: "superseded" });
      }
      this.publishPending("external-open");
      try {
        const result = await this.host.openExternalDocument({ ...request, password });
        password = "";
        if (generation !== this.generation || adoption !== this.currentAdoption()
          || request !== this.activeExternalOpen) {
          return Object.freeze({ status: "superseded" });
        }
        this.activeExternalOpen = null;
        this.clearPending();
        if (result === null) {
          this.publishExternalOpen();
          return Object.freeze({ status: "external-canceled" });
        }
        return this.adoptAuthenticated(result);
      } catch (error) {
        password = "";
        if (generation !== this.generation || adoption !== this.currentAdoption()
          || request !== this.activeExternalOpen) {
          return Object.freeze({ status: "superseded" });
        }
        this.clearPending();
        return Object.freeze({ status: "failed", code: hostFailureCode(error) });
      }
    });
  }

  /** Acknowledges cancellation without replacing the current document. */
  cancelExternalOpen(): Promise<DocumentSessionOutcome<Doc>> {
    const request = this.activeExternalOpen;
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(async () => {
      if (!request || request !== this.activeExternalOpen
        || generation !== this.generation || adoption !== this.currentAdoption()
        || !this.host.cancelExternalOpen) {
        return Object.freeze({ status: "superseded" });
      }
      this.publishPending("external-cancel");
      try {
        const canceled = await this.host.cancelExternalOpen(request);
        if (generation !== this.generation || adoption !== this.currentAdoption()
          || request !== this.activeExternalOpen) {
          return Object.freeze({ status: "superseded" });
        }
        this.clearPending();
        if (!canceled) return Object.freeze({ status: "unavailable" });
        this.activeExternalOpen = null;
        this.publishExternalOpen();
        return Object.freeze({ status: "external-canceled" });
      } catch (error) {
        if (generation !== this.generation || adoption !== this.currentAdoption()
          || request !== this.activeExternalOpen) {
          return Object.freeze({ status: "superseded" });
        }
        this.clearPending();
        return Object.freeze({ status: "failed", code: hostFailureCode(error) });
      }
    });
  }

  /** Commits the host-authorized new candidate only to its originating session generation. */
  create(request: object): Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(async () => {
      if (generation !== this.generation || adoption !== this.currentAdoption()) {
        return Object.freeze({ status: "superseded" });
      }
      if (!this.host.createDocument) return Object.freeze({ status: "unavailable" });
      this.publishPending("create");
      try {
        const result = await this.host.createDocument(request);
        if (generation !== this.generation || adoption !== this.currentAdoption()) {
          return Object.freeze({ status: "superseded" });
        }
        this.clearPending();
        if (!result) return Object.freeze({ status: "pending" });
        this.adopt({ ...result.opened, targetName: result.name } as Doc);
        return Object.freeze({ status: "created" });
      } catch (error) {
        if (generation !== this.generation || adoption !== this.currentAdoption()) {
          return Object.freeze({ status: "superseded" });
        }
        this.clearPending();
        return Object.freeze({ status: "failed", code: hostFailureCode(error) });
      }
    });
  }

  openSelected(password: string): Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(() => {
      if (generation !== this.generation || adoption !== this.currentAdoption()) {
        password = "";
        return Promise.resolve(Object.freeze({ status: "superseded" }));
      }
      let operation: Promise<Doc | Invite>;
      try {
        this.publishPending("open");
        operation = this.host.openSelectedDocument(password);
      } catch (error) {
        password = "";
        if (generation !== this.generation || adoption !== this.currentAdoption()) {
          return Promise.resolve(Object.freeze({ status: "superseded" }));
        }
        this.clearPending();
        return Promise.resolve(Object.freeze({ status: "failed",
          code: hostFailureCode(error) }));
      }
      password = "";
      return operation.then(async (result) => {
        if (generation !== this.generation || adoption !== this.currentAdoption()) {
          return Object.freeze({ status: "superseded" });
        }
        if (result.invitationRequired === true) this.clearPending();
        return this.adoptAuthenticated(result);
      }, (error) => {
        if (generation !== this.generation || adoption !== this.currentAdoption()) {
          return Object.freeze({ status: "superseded" });
        }
        this.clearPending();
        return Object.freeze({ status: "failed" as const, code: hostFailureCode(error) });
      });
    });
  }

  unlock(password: string): Promise<DocumentSessionOutcome<Doc>> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(() => {
      if (generation !== this.generation || adoption !== this.currentAdoption()) {
        password = "";
        return Promise.resolve(Object.freeze({ status: "superseded" }));
      }
      let operation: Promise<Doc | Invite>;
      try {
        this.publishPending("unlock");
        operation = this.host.unlockDocument(password);
      } catch (error) {
        password = "";
        if (generation !== this.generation || adoption !== this.currentAdoption()) {
          return Promise.resolve(Object.freeze({ status: "superseded" }));
        }
        this.clearPending();
        return Promise.resolve(Object.freeze({ status: "failed",
          code: hostFailureCode(error) }));
      }
      password = "";
      return operation.then(async (result) => {
        if (generation !== this.generation || adoption !== this.currentAdoption()) {
          return Object.freeze({ status: "superseded" });
        }
        if (result.invitationRequired === true) this.clearPending();
        return this.adoptAuthenticated(result);
      }, (error) => {
        if (generation !== this.generation || adoption !== this.currentAdoption()) {
          return Object.freeze({ status: "superseded" });
        }
        this.clearPending();
        return Object.freeze({ status: "failed" as const, code: hostFailureCode(error) });
      });
    });
  }

  /** Clears reachable frontend state at the host's lock-start safety point. */
  lockStarted(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.externalOpenQueue.length = 0;
    this.activeExternalOpen = null;
    this.protectionRequest = null;
    this.invitationStaged = false;
    this.invitationEpoch += 1;
    this.leaseDecision = null;
    this.queuedLeaseOperation = null;
    this.editFailureCode = null;
    this.publicationFailureCode = null;
    this.saveFailureCode = null;
    this.recoveryFailureCode = null;
    this.headFailureCode = null;
    this.unreadableFailureCode = null;
    this.migrationFailureCode = null;
    this.migrationCanceled = false;
    this.compactionFailureCode = null;
    this.compactionConfirmation = false;
    this.resolvingDivergence = false;
    this.sealedRegularVersion = null;
    this.acceptedRegularVersion = null;
    this.cancelQueuedCommands();
    if (this.snapshot.kind === "closed") {
      const { invitationStaged: _staged, externalOpen: _external, ...current } = this.snapshot;
      this.snapshot = Object.freeze(current);
      this.notify();
      return;
    }
    const targetName = this.snapshot.targetName;
    this.snapshot = Object.freeze({ kind: "locked", targetName,
      publication: Object.freeze({ state: this.publicationState,
        resolving: this.resolvingDivergence }),
      ...(this.discovery.total > 0 ? { discovery: this.discovery,
        attention: this.discoveryAttention() } : {}) });
    this.clearWorkingCopy();
    this.notify();
  }

  lockCompleted(): void { this.lockStarted(); }

  closed(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.externalOpenQueue.length = 0;
    this.activeExternalOpen = null;
    this.protectionRequest = null;
    this.invitationStaged = false;
    this.invitationEpoch += 1;
    this.leaseDecision = null;
    this.queuedLeaseOperation = null;
    this.editFailureCode = null;
    this.publicationFailureCode = null;
    this.saveFailureCode = null;
    this.recoveryFailureCode = null;
    this.headFailureCode = null;
    this.unreadableFailureCode = null;
    this.migrationFailureCode = null;
    this.migrationCanceled = false;
    this.compactionFailureCode = null;
    this.compactionConfirmation = false;
    this.resolvingDivergence = false;
    this.sealedRegularVersion = null;
    this.acceptedRegularVersion = null;
    this.cancelQueuedCommands();
    this.snapshot = this.discovery.total > 0
      ? Object.freeze({ kind: "closed", discovery: this.discovery,
        attention: this.discoveryAttention() }) : CLOSED;
    this.publicationState = "target-published";
    this.clearWorkingCopy();
    this.notify();
  }

  lock(): Promise<DocumentSessionOutcome> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    const adoptionSequence = this.adoptionSequence;
    return this.enqueue(async () => {
      if (generation !== this.generation || adoption !== this.currentAdoption()) {
        return Object.freeze({ status: "superseded" });
      }
      try {
        this.publishPending("lock");
        const result = await this.host.lock();
        if (adoptionSequence !== this.adoptionSequence || this.snapshot.kind === "closed") {
          return Object.freeze({ status: "superseded" });
        }
        if (this.snapshot.kind !== "locked") {
          if (generation !== this.generation) return Object.freeze({ status: "superseded" });
          this.lockCompleted();
        }
        const warningCode: SessionLockWarningCode | null = result.warningCode === null
          || result.warningCode === undefined ? null
            : result.warningCode === "LOCK_CHECKPOINT_FAILED"
              ? "LOCK_CHECKPOINT_FAILED" : "OPERATION_FAILED";
        return Object.freeze({ status: "locked" as const, warningCode });
      } catch (error) {
        if (generation !== this.generation || adoption !== this.currentAdoption()) {
          return Object.freeze({ status: "superseded" });
        }
        this.clearPending();
        return Object.freeze({ status: "failed" as const,
          code: hostFailureCode(error) });
      }
    });
  }

  close(): Promise<DocumentSessionOutcome> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(async () => {
      if (generation !== this.generation || adoption !== this.currentAdoption()) {
        return Object.freeze({ status: "superseded" });
      }
      try {
        this.publishPending("close");
        const completed = await this.host.closeDocument();
        if (generation !== this.generation || adoption !== this.currentAdoption()) {
          return Object.freeze({ status: "superseded" });
        }
        if (!completed) {
          this.clearPending();
          return Object.freeze({ status: "pending" as const });
        }
        this.closed();
        return Object.freeze({ status: "closed" as const });
      } catch (error) {
        if (generation !== this.generation || adoption !== this.currentAdoption()) {
          return Object.freeze({ status: "superseded" });
        }
        this.clearPending();
        return Object.freeze({ status: "failed" as const,
          code: hostFailureCode(error) });
      }
    });
  }

  /** Waits for the native termination barrier before dropping frontend state. */
  exit(): Promise<DocumentSessionOutcome> {
    const generation = this.generation;
    const adoption = this.currentAdoption();
    return this.enqueue(async () => {
      if (generation !== this.generation || adoption !== this.currentAdoption()) {
        return Object.freeze({ status: "superseded" });
      }
      if (!this.host.exitApplication) return Object.freeze({ status: "unavailable" });
      this.publishPending("exit");
      try {
        const completed = await this.host.exitApplication();
        if (generation !== this.generation || adoption !== this.currentAdoption()) {
          return Object.freeze({ status: "superseded" });
        }
        if (!completed) {
          this.clearPending();
          return Object.freeze({ status: "pending" });
        }
        // Native quit owns the final window teardown. Keep the current adoption
        // until its lock-start/closed notification so a simulated or deferred quit
        // cannot make the mounted session appear destroyed early.
        this.clearPending();
        return Object.freeze({ status: "pending" });
      } catch (error) {
        if (generation !== this.generation || adoption !== this.currentAdoption()) {
          return Object.freeze({ status: "superseded" });
        }
        this.clearPending();
        return Object.freeze({ status: "failed", code: hostFailureCode(error) });
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.closed();
    this.listeners.clear();
    this.disposed = true;
  }

  private adoptMergeDraft(draft: SessionMergeDraft): void {
    const current = this.snapshot;
    if (current.kind !== "read-only" && current.kind !== "edit") return;
    this.generation += 1;
    this.cancelQueuedCommands();
    const nextDocument = frozenCopy({ ...current.document, content: draft.content,
      readOnly: false, canEdit: true, publicationState: "conflict" } as Doc);
    this.stopWorkingCopy?.();
    this.workingCopy?.dispose();
    const copy = new WorkingCopy(this.journalHost);
    copy.adoptDivergence(draft.content);
    this.workingCopy = copy;
    this.stopWorkingCopy = copy.subscribe(() => this.publishWorkingCopy());
    this.leaseDecision = null;
    this.queuedLeaseOperation = null;
    this.publicationFailureCode = null;
    this.saveFailureCode = null;
    this.sealedRegularVersion = null;
    this.acceptedRegularVersion = null;
    this.publicationState = "conflict";
    this.resolvingDivergence = true;
    this.snapshot = this.openSnapshot(nextDocument, current.adoption,
      nextDocument.targetName ?? current.targetName);
    this.notify();
  }

  private replaceWorkingDocument(document: Doc, mode: "open" | "recovery",
    selection?: WorkingCopySelection): void {
    const current = this.snapshot;
    if (current.kind !== "read-only" && current.kind !== "edit") return;
    this.generation += 1;
    this.cancelQueuedCommands();
    const nextDocument = frozenCopy(mode === "recovery"
      ? { ...current.document, ...document, recovery: undefined } as Doc : document);
    this.stopWorkingCopy?.();
    this.workingCopy?.dispose();
    const copy = new WorkingCopy(this.journalHost);
    if (mode === "recovery") {
      copy.adoptRecovery(nextDocument.content, selection ?? { start: 0, end: 0 });
      copy.ensureJournalVersion();
    } else {
      copy.adoptOpen(nextDocument.content, Boolean(nextDocument.provisional));
      if (!nextDocument.readOnly && nextDocument.provisional) copy.ensureJournalVersion();
    }
    this.workingCopy = copy;
    this.stopWorkingCopy = copy.subscribe(() => this.publishWorkingCopy());
    this.leaseDecision = null;
    this.queuedLeaseOperation = null;
    this.editFailureCode = null;
    this.publicationFailureCode = null;
    this.saveFailureCode = null;
    this.sealedRegularVersion = null;
    this.acceptedRegularVersion = null;
    this.publicationState = nextDocument.provisional ? "provisional"
      : nextDocument.publicationState ?? "target-published";
    this.resolvingDivergence = false;
    this.recoveryFailureCode = null;
    this.headFailureCode = null;
    this.unreadableFailureCode = null;
    this.migrationFailureCode = null;
    this.migrationCanceled = false;
    this.compactionFailureCode = null;
    this.compactionConfirmation = false;
    this.snapshot = this.openSnapshot(nextDocument, current.adoption,
      nextDocument.targetName ?? current.targetName);
    this.notify();
  }

  private openSnapshot(document: Doc, adoption: number,
    targetName: string | null, pending?: SessionPendingOperation): ReadOnlySessionSnapshot<Doc>
    | EditSessionSnapshot<Doc> {
    const working = this.workingCopy?.getSnapshot();
    if (!working || working.kind !== "ready") {
      throw new Error("unlocked document requires a working copy");
    }
    const securityReady = !this.invitationStaged && !working.dirty
      && !document.recovery && !document.headMismatch
      && !document.unreadableJournal && !document.migrationRequired
      && this.publicationState === "target-published" && pending === undefined;
    const administrationReady = securityReady && !document.readOnly
      && !document.profileMismatch;
    const commands: SessionCommands = Object.freeze({
      enterEdit: document.readOnly && document.canEdit === true
        && pending === undefined
        && (document.publicationState === undefined
          || document.publicationState === "target-published")
        && !document.recovery && !document.headMismatch && !document.profileMismatch
        && !document.unreadableJournal
        && !document.migrationRequired,
      write: !document.readOnly && !document.recovery && !document.headMismatch
        && !document.unreadableJournal && pending !== "compaction",
      undo: !document.readOnly && !document.recovery && !document.headMismatch
        && !document.unreadableJournal && pending !== "compaction" && working.canUndo,
      redo: !document.readOnly && !document.recovery && !document.headMismatch
        && !document.unreadableJournal && pending !== "compaction" && working.canRedo,
      save: !document.readOnly && !document.recovery && !document.headMismatch
        && !document.unreadableJournal && working.dirty && pending === undefined,
      backup: !working.dirty && this.publicationState === "target-published"
        && !document.provisional && !document.recovery && !document.headMismatch
        && !document.profileMismatch && !document.migrationRequired
        && !document.unreadableJournal && pending === undefined,
      export: pending === undefined,
      publicationRetry: (this.publicationState === "pending-publication"
        || this.publicationState === "conflict") && !this.resolvingDivergence
        && !document.recovery && !document.headMismatch && !document.unreadableJournal
        && pending === undefined,
      publicationDiscard: (this.publicationState === "pending-publication"
        || this.publicationState === "conflict") && !this.resolvingDivergence
        && !document.recovery && !document.headMismatch && !document.unreadableJournal
        && !working.dirty
        && pending === undefined,
      recoveryRestore: Boolean(document.recovery) && document.canEdit === true
        && !document.headMismatch && !document.profileMismatch
        && !document.unreadableJournal && !document.migrationRequired
        && this.publicationState === "target-published" && pending === undefined,
      recoveryDiscard: Boolean(document.recovery) && !document.headMismatch
        && !document.unreadableJournal && pending === undefined,
      acceptHeadMismatch: Boolean(document.headMismatch) && pending === undefined,
      unreadableDiscard: Boolean(document.unreadableJournal) && !document.headMismatch
        && pending === undefined,
      changePassword: securityReady && !document.profileMismatch,
      createInvitation: administrationReady && document.canAddPasswords === true
        && (document.managedSlots?.length ?? 0) < 7,
      reconcileIdentity: securityReady && Boolean(document.profileMismatch),
      updateSlotPermissions: administrationReady && document.canAddPasswords === true
        && document.canRemovePasswords === true,
      removeSlot: administrationReady && document.canRemovePasswords === true,
      migrate: document.readOnly && document.migrationRequired === true
        && document.migrationCanEdit === true && !working.dirty
        && !document.recovery && !document.headMismatch && !document.profileMismatch
        && !document.unreadableJournal && this.publicationState === "target-published"
        && pending === undefined,
      compact: administrationReady && document.canAddPasswords === true
        && document.canRemovePasswords === true && this.host.compactDocument !== undefined,
    });
    const attention: SessionAttention | undefined = this.protectionRequest
      ? this.protectionAttention()
      : this.leaseDecision
      ? Object.freeze({ kind: "lease-takeover", operation: this.leaseDecision.operation,
        holderName: this.leaseDecision.holderName,
        ...(this.leaseDecision.reason ? { reason: this.leaseDecision.reason } : {}) })
      : this.editFailureCode ? Object.freeze({ kind: "edit-unavailable",
        code: this.editFailureCode })
      : this.saveFailureCode ? Object.freeze({ kind: "save-failed",
        code: this.saveFailureCode })
      : document.headMismatch ? Object.freeze({ kind: "head-mismatch",
        mismatchKind: document.headMismatch.kind,
        ...(this.headFailureCode ? { failureCode: this.headFailureCode } : {}) })
      : document.unreadableJournal ? Object.freeze({ kind: "unreadable-journal",
        ...(this.unreadableFailureCode
          ? { failureCode: this.unreadableFailureCode } : {}) })
      : document.recovery ? Object.freeze({ kind: "recovery-decision",
        updateTime: document.recovery.updateTime,
        ...(document.recovery.authorName
          ? { authorName: document.recovery.authorName } : {}),
        ...(document.recovery.deviceName
          ? { deviceName: document.recovery.deviceName } : {}),
        canRestore: commands.recoveryRestore,
        ...(this.recoveryFailureCode
          ? { failureCode: this.recoveryFailureCode } : {}) })
      : document.migrationRequired ? Object.freeze({ kind: "migration-decision",
        canMigrate: commands.migrate,
        ...(this.migrationCanceled ? { canceled: true } : {}),
        ...(this.migrationFailureCode ? { failureCode: this.migrationFailureCode } : {}) })
      : this.compactionConfirmation ? Object.freeze({ kind: "compaction-decision",
        ...(this.compactionFailureCode ? { failureCode: this.compactionFailureCode } : {}) })
      : (this.publicationState === "pending-publication"
        || this.publicationState === "conflict") && !this.resolvingDivergence
        ? Object.freeze({ kind: "publication-decision", state: this.publicationState,
          ...(this.publicationFailureCode
            ? { failureCode: this.publicationFailureCode } : {}) })
        : this.discovery.total > 0 ? this.discoveryAttention() : undefined;
    return document.readOnly
      ? Object.freeze({ kind: "read-only", adoption, targetName, working, commands,
        ...(this.externalOpenProjection()
          ? { externalOpen: this.externalOpenProjection() } : {}),
        ...(this.invitationStaged ? { invitationStaged: true } : {}),
        publication: Object.freeze({ state: this.publicationState,
          resolving: this.resolvingDivergence }),
        ...(this.discovery.total > 0 ? { discovery: this.discovery } : {}),
        ...(pending ? { pending } : {}),
        ...(attention ? { attention } : {}),
        ...(this.queuedLeaseOperation ? { queued: this.queuedLeaseOperation } : {}),
        document: document as Doc & { readOnly: true } })
      : Object.freeze({ kind: "edit", adoption, targetName, working, commands,
        ...(this.externalOpenProjection()
          ? { externalOpen: this.externalOpenProjection() } : {}),
        ...(this.invitationStaged ? { invitationStaged: true } : {}),
        publication: Object.freeze({ state: this.publicationState,
          resolving: this.resolvingDivergence }),
        ...(this.discovery.total > 0 ? { discovery: this.discovery } : {}),
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

  private externalOpenProjection(): SessionExternalOpenSnapshot | undefined {
    if (!this.activeExternalOpen && this.externalOpenQueue.length === 0) return undefined;
    return Object.freeze({ active: this.activeExternalOpen !== null,
      queued: this.externalOpenQueue.length });
  }

  private protectionAttention(): SessionProtectionAttention | undefined {
    const pending = this.protectionRequest;
    if (!pending) return undefined;
    const current = this.snapshot;
    const document = current.kind === "read-only" || current.kind === "edit"
      ? current.document : null;
    const working = current.kind === "read-only" || current.kind === "edit"
      ? current.working : null;
    const evidence = pending.state;
    const state: SessionProtectionState = Object.freeze({
      dirty: Boolean(evidence.dirty || working?.dirty),
      provisional: Boolean(evidence.provisional || document?.provisional
        || this.publicationState === "provisional"),
      pendingPublication: Boolean(evidence.pendingPublication
        || this.publicationState === "pending-publication"),
      recovered: Boolean(evidence.recovered || document?.recovery),
      conflict: Boolean(evidence.conflict || this.publicationState === "conflict"),
      unresolvedJournal: Boolean(evidence.unresolvedJournal || document?.unreadableJournal
        || document?.recovery || working?.journal.failed),
      activePublication: evidence.activePublication,
    });
    return Object.freeze({ kind: "lifecycle-protection", operation: pending.operation,
      state, resolving: pending.resolving,
      ...(pending.failureCode ? { failureCode: pending.failureCode } : {}) });
  }

  private publishProtection(): void {
    const current = this.snapshot;
    if (current.kind === "read-only" || current.kind === "edit") {
      this.publishWorkingCopy();
      return;
    }
    const { attention: _attention, ...state } = current;
    this.snapshot = Object.freeze({ ...state,
      ...(this.protectionAttention()
        ? { attention: this.protectionAttention() }
        : this.discovery.total > 0 ? { attention: this.discoveryAttention() } : {}) }) as
      DocumentSessionSnapshot<Doc>;
    this.notify();
  }

  private publishExternalOpen(): void {
    const current = this.snapshot;
    if (current.kind === "read-only" || current.kind === "edit") {
      this.publishWorkingCopy();
      return;
    }
    const { externalOpen: _externalOpen, ...state } = current;
    const projected = this.externalOpenProjection();
    this.snapshot = Object.freeze({ ...state,
      ...(projected ? { externalOpen: projected } : {}) }) as DocumentSessionSnapshot<Doc>;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
    this.notifyWork();
  }

  private notifyWork(): void { for (const listener of this.workListeners) listener(); }

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
      this.notifyWork();
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
      this.notifyWork();
    });
  }

  private cancelQueuedCommands(): void {
    for (const command of this.queuedCommands.splice(0)) {
      command.resolve(Object.freeze({ status: "superseded" }));
    }
    this.notifyWork();
  }
}
