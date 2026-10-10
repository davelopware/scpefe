import type { DocumentSession, DocumentSessionSnapshot } from "@scpefe/frontend-core";
import type { DocumentOpened, Opened, OpenedDialogName } from "./types.ts";

type FullSession = DocumentSession<DocumentOpened,
  Extract<Opened, { invitationRequired: true }>>;
type PresentationSession = Pick<FullSession,
  "getSnapshot" | "dismissEditFailure" | "enterEditMode" | "restoreRecovery"
  | "discardRecovery" | "acceptHeadMismatch" | "discardUnreadableJournal"
  | "confirmLeaseTakeover" | "cancelLeaseTakeover" | "migrate"
  | "confirmCompaction" | "cancelCompaction" | "save" | "dismissSaveFailure"
  | "retryPublication" | "discardPublication" | "beginDivergenceResolution"
  | "decideProtection" | "activateExternalOpen">;
type ProtectionAttention = Extract<NonNullable<
  DocumentSessionSnapshot<DocumentOpened>["attention"]>, { kind: "lifecycle-protection" }>;
const QUEUED_OPEN_WAITING_MESSAGE = "Another open request is waiting for the current dialog.";
const QUEUED_OPEN_ACTIVE_MESSAGE = "Another open request is waiting. Enter its document password to continue.";

/** Host lifecycle challenge that takes priority over every form and decision. */
export interface LifecycleProtectionDecision {
  readonly kind: "lifecycle-protection";
  readonly operation: ProtectionAttention["operation"];
  readonly state: ProtectionAttention["state"];
  readonly resolving: boolean;
  readonly failureMessage: string | null;
}

/** The single edit-failure decision exposed to graphical renderers. */
export interface EditUnavailableDecision {
  readonly kind: "edit-unavailable";
  readonly message: string;
}

/** A failed manual save whose working copy remains available. */
export interface SaveFailedDecision {
  readonly kind: "save-failed";
  readonly message: string;
}

/** A locally saved candidate awaiting publication or conflict resolution. */
export interface PublicationDecision {
  readonly kind: "publication-decision";
  readonly state: "pending-publication" | "conflict";
  readonly failureMessage: string | null;
}

/** Explicit choice before replacing newer working-copy edits with a merge draft. */
export interface NewerEditsDecision {
  readonly kind: "newer-edits-confirmation";
}

/** A document-session attention decision ready to render. */
export type DocumentAttentionDecision =
  | { readonly kind: "lease-takeover"; readonly holderName: string;
    readonly operation: "edit" | "recovery" | "divergence" | "migration";
    readonly reason?: "master";
    readonly errorMessage: string | null }
  | { readonly kind: "migration-decision"; readonly canMigrate: boolean;
    readonly canceled: boolean; readonly failureMessage: string | null }
  | { readonly kind: "compaction-decision"; readonly failureMessage: string | null }
  | { readonly kind: "recovery-decision"; readonly updateTime: number;
    readonly failureMessage: string | null }
  | { readonly kind: "head-mismatch"; readonly mismatchKind: "rollback"
    | "divergence" | "replacement" | "witness-error";
    readonly failureMessage: string | null }
  | { readonly kind: "unreadable-journal";
    readonly failureMessage: string | null };

/** Admission required before an invitation or claimed slot can be used normally. */
export type AdmissionDecision = { readonly kind: "invitation-claim" }
  | { readonly kind: "profile-mismatch" };

/** Observable graphical state for selected document attention. */
export interface SessionPresentationView {
  readonly selectedDecision: LifecycleProtectionDecision | EditUnavailableDecision | SaveFailedDecision | PublicationDecision
    | NewerEditsDecision
    | DocumentAttentionDecision | AdmissionDecision | null;
  readonly blocked: boolean;
  readonly openedDialog: OpenedDialogName;
  readonly safeMessage: string | null;
  readonly focusIntent: "edit-retry" | "save-retry" | "recovery-restore" | "decision-action"
    | "migration-retry" | "publication-retry" | "return" | null;
}

/** Selects document decisions and presents their actions, safe outcomes, and focus. */
export class SessionPresentation {
  private safeMessage: string | null = null;
  private focusIntent: SessionPresentationView["focusIntent"] = null;
  private leaseError: string | null = null;
  private leaseInFlight: { holderName: string;
    operation: "edit" | "recovery" | "divergence" | "migration";
    reason?: "master" } | null = null;
  private compactionInFlight = false;
  private confirmDivergenceDiscard = false;
  private adoption: number | null = null;
  private epoch = 0;
  private disposed = false;

  constructor(private readonly session: PresentationSession,
    private readonly catalogText: (code: string) => string) {}

  private current(): DocumentSessionSnapshot<DocumentOpened> {
    const snapshot = this.session.getSnapshot();
    const adoption = snapshot.kind === "read-only" || snapshot.kind === "edit"
      ? snapshot.adoption : null;
    if (this.adoption !== adoption) {
      this.adoption = adoption;
      this.clear();
    }
    return snapshot;
  }

  private clear(): void {
    this.epoch += 1;
    this.safeMessage = null;
    this.focusIntent = null;
    this.leaseError = null;
    this.leaseInFlight = null;
    this.compactionInFlight = false;
    this.confirmDivergenceDiscard = false;
  }

  /** Invalidates pending presentation work at the lock-start safety point. */
  lockStarted(): void { this.clear(); }

  /** Rejects pending outcomes after the graphical presentation unmounts. */
  dispose(): void { this.disposed = true; this.clear(); }

  /** Activates the next session-owned request only after current decisions clear. */
  activateQueuedExternalOpen({ formActive = false }: { formActive?: boolean } = {}): boolean {
    const snapshot = this.current();
    if (this.disposed || formActive || this.view().blocked
      || (snapshot.kind === "read-only" || snapshot.kind === "edit")
        && snapshot.publication.resolving) return false;
    const activated = this.session.activateExternalOpen();
    if (activated) this.safeMessage = QUEUED_OPEN_ACTIVE_MESSAGE;
    return activated;
  }

  /** Reports a queued open waiting behind the current graphical decision. */
  externalOpenQueued(waiting: boolean): string | null {
    const snapshot = this.current();
    if (!this.disposed && waiting && !snapshot.externalOpen?.active
      && !this.view().blocked) {
      this.safeMessage = QUEUED_OPEN_WAITING_MESSAGE;
      return this.safeMessage;
    }
    return null;
  }

  /** Keeps a queued-open status from contradicting a newly selected decision. */
  statusMessage(message: string): string {
    if (this.current().externalOpen?.active && !this.view().blocked)
      return QUEUED_OPEN_ACTIVE_MESSAGE;
    return this.view().blocked && (message === QUEUED_OPEN_WAITING_MESSAGE
      || message === QUEUED_OPEN_ACTIVE_MESSAGE) ? "" : message;
  }

  /** Presents the safe outcome after an active external request is canceled. */
  externalOpenCanceled(): Pick<SessionPresentationView, "safeMessage" | "focusIntent"> {
    this.current();
    if (!this.disposed) {
      const blocked = this.view().blocked;
      this.safeMessage = blocked ? null
        : "Open request canceled; the current document remains open.";
    }
    return this.view();
  }

  /** Presents admission after a candidate opens an invitation. */
  invitationStaged(): Pick<SessionPresentationView, "safeMessage" | "focusIntent"> {
    this.current();
    if (!this.disposed) {
      this.safeMessage = "Claim the invitation before its document replaces the current session.";
    }
    return this.view();
  }

  /** Expresses editor focus only when an adopted document has no decision to resolve. */
  documentOpened(): Pick<SessionPresentationView, "safeMessage" | "focusIntent"> {
    const snapshot = this.current();
    const view = this.view();
    return { safeMessage: view.safeMessage,
      focusIntent: !this.disposed && (snapshot.kind === "read-only" || snapshot.kind === "edit")
        && !view.blocked ? "return" : null };
  }

  view({ formActive = false }: { formActive?: boolean } = {}): SessionPresentationView {
    const snapshot = this.current();
    const attention = snapshot.kind === "read-only" || snapshot.kind === "edit"
      ? snapshot.attention : undefined;
    const selectedDecision = attention?.kind === "lifecycle-protection"
      ? { kind: "lifecycle-protection" as const, operation: attention.operation,
        state: attention.state, resolving: attention.resolving,
        failureMessage: attention.failureCode ? this.catalogText(attention.failureCode) : null }
      : formActive ? null
      : snapshot.invitationStaged ? { kind: "invitation-claim" as const }
      : attention?.kind === "edit-unavailable"
      ? { kind: "edit-unavailable" as const, message: this.catalogText(attention.code) }
      : attention?.kind === "save-failed"
        ? { kind: "save-failed" as const, message: this.catalogText(attention.code) }
      : this.compactionInFlight || snapshot.pending === "compaction"
        ? { kind: "compaction-decision" as const, failureMessage: null }
      : this.leaseInFlight
        ? { kind: "lease-takeover" as const, ...this.leaseInFlight, errorMessage: null }
      : attention?.kind === "lease-takeover"
        ? { kind: "lease-takeover" as const, holderName: attention.holderName,
          operation: attention.operation,
          ...(attention.reason ? { reason: attention.reason } : {}),
          errorMessage: this.leaseError }
      : (snapshot.kind === "read-only" || snapshot.kind === "edit")
        && snapshot.document.profileMismatch
        && (!attention || attention.kind === "migration-decision")
        ? { kind: "profile-mismatch" as const }
      : attention?.kind === "migration-decision"
        ? { kind: "migration-decision" as const, canMigrate: attention.canMigrate,
          canceled: attention.canceled === true,
          failureMessage: attention.failureCode ? this.catalogText(attention.failureCode) : null }
      : attention?.kind === "compaction-decision"
        ? { kind: "compaction-decision" as const,
          failureMessage: attention.failureCode ? this.catalogText(attention.failureCode) : null }
      : attention?.kind === "recovery-decision"
        ? { kind: "recovery-decision" as const, updateTime: attention.updateTime,
          failureMessage: attention.failureCode ? this.catalogText(attention.failureCode) : null }
      : attention?.kind === "head-mismatch"
        ? { kind: "head-mismatch" as const, mismatchKind: attention.mismatchKind,
          failureMessage: attention.failureCode ? this.catalogText(attention.failureCode) : null }
      : attention?.kind === "unreadable-journal"
        ? { kind: "unreadable-journal" as const,
          failureMessage: attention.failureCode ? this.catalogText(attention.failureCode) : null }
      : attention?.kind === "publication-decision"
        ? { kind: "publication-decision" as const, state: attention.state,
          failureMessage: attention.failureCode ? this.catalogText(attention.failureCode) : null }
      : null;
    const openedDialog: OpenedDialogName = selectedDecision?.kind === "invitation-claim" ? "claim"
      : selectedDecision?.kind === "profile-mismatch" ? "profile-mismatch"
      : selectedDecision?.kind === "head-mismatch" ? "head"
      : selectedDecision?.kind === "unreadable-journal" ? "unreadable"
      : selectedDecision?.kind === "recovery-decision" ? "recovery"
      : selectedDecision?.kind === "publication-decision" ? "publication"
      : selectedDecision?.kind === "migration-decision" ? "migration" : null;
    return { selectedDecision: selectedDecision?.kind === "lifecycle-protection"
      ? selectedDecision : this.confirmDivergenceDiscard
      ? { kind: "newer-edits-confirmation" } : selectedDecision,
      openedDialog: this.confirmDivergenceDiscard ? null : openedDialog,
      blocked: selectedDecision !== null || this.confirmDivergenceDiscard,
      safeMessage: selectedDecision?.kind === "lifecycle-protection"
        || selectedDecision !== null && this.safeMessage === QUEUED_OPEN_WAITING_MESSAGE
        ? null : snapshot.externalOpen?.active && selectedDecision === null
        ? QUEUED_OPEN_ACTIVE_MESSAGE : this.safeMessage,
      focusIntent: selectedDecision?.kind === "lifecycle-protection"
        ? (selectedDecision.failureMessage ? "decision-action" : null)
        : this.focusIntent ?? (selectedDecision?.kind === "invitation-claim"
        || selectedDecision?.kind === "profile-mismatch" ? "decision-action"
        : selectedDecision?.kind === "edit-unavailable" ? "edit-retry"
        : selectedDecision?.kind === "save-failed" ? "save-retry"
        : selectedDecision?.kind === "recovery-decision" && selectedDecision.failureMessage
          ? "recovery-restore"
        : selectedDecision?.kind === "migration-decision"
          && (selectedDecision.failureMessage || selectedDecision.canceled)
          ? "migration-retry"
        : selectedDecision?.kind === "publication-decision" && selectedDecision.failureMessage
          ? "publication-retry" : null) };
  }

  /** Presents the structured manual-save outcome for the current adoption. */
  async save(): Promise<void> {
    const snapshot = this.current();
    if (this.disposed || (snapshot.kind !== "read-only" && snapshot.kind !== "edit")) return;
    const adoption = snapshot.adoption;
    const epoch = this.epoch;
    const outcome = await this.session.save();
    const current = this.current();
    if (this.disposed || this.epoch !== epoch
      || (current.kind !== "read-only" && current.kind !== "edit")
      || current.adoption !== adoption) return;
    if (outcome.status === "saved") {
      this.safeMessage = outcome.publicationState === "pending-publication"
        ? "Manual save is pending publication; its exact candidate is stored locally."
        : outcome.publicationState === "conflict"
          ? "Manual save is local, but the target changed; divergence must be resolved."
          : "Manual save published and verified.";
      this.focusIntent = "return";
    } else if (outcome.status === "failed") {
      this.safeMessage = `Manual save failed; changes remain recoverable: ${this.catalogText(outcome.code)}`;
      this.focusIntent = "save-retry";
    }
  }

  /** Requests Edit mode and presents only an outcome for the current document. */
  async enterEditMode(): Promise<void> {
    const snapshot = this.current();
    if (this.disposed || (snapshot.kind !== "read-only" && snapshot.kind !== "edit")) return;
    const adoption = snapshot.adoption;
    const epoch = this.epoch;
    const outcome = await this.session.enterEditMode();
    const current = this.current();
    if (this.disposed || this.epoch !== epoch
      || (current.kind !== "read-only" && current.kind !== "edit")
      || current.adoption !== adoption) return;
    if (outcome.status === "attention") {
      this.safeMessage = "Editing requires a confirmed lease takeover.";
    } else if (outcome.status === "edit-mode") {
      this.safeMessage = "Edit mode entered.";
    }
  }

  /** Starts a merge draft only after the session permits discarding newer edits. */
  async beginDivergenceResolution(discardUnsaved = false): Promise<void> {
    const snapshot = this.current();
    if ((snapshot.kind !== "read-only" && snapshot.kind !== "edit")
      || snapshot.attention?.kind !== "publication-decision"
      || snapshot.attention.state !== "conflict") return;
    const adoption = snapshot.adoption;
    const epoch = this.epoch;
    const outcome = await this.session.beginDivergenceResolution({ discardUnsaved });
    const current = this.current();
    if (this.disposed || this.epoch !== epoch
      || (current.kind !== "read-only" && current.kind !== "edit")
      || current.adoption !== adoption) return;
    if (outcome.status === "unsaved-work") {
      this.confirmDivergenceDiscard = true;
      this.focusIntent = "decision-action";
    } else if (outcome.status === "attention") {
      this.confirmDivergenceDiscard = false;
      this.safeMessage = "Divergence resolution requires a confirmed lease takeover.";
      this.focusIntent = "decision-action";
    } else if (outcome.status === "divergence") {
      this.confirmDivergenceDiscard = false;
      this.safeMessage = outcome.hasConflicts
        ? "Resolve every local/current marker, then save the merge."
        : "The three-way merge is clean. Review it, then save the merge.";
      this.focusIntent = "return";
    } else if (outcome.status === "failed") {
      this.confirmDivergenceDiscard = false;
      this.safeMessage = `Divergence resolution needs attention: ${this.catalogText(outcome.code)}`;
      this.focusIntent = "publication-retry";
    }
  }

  async act(action: "continue-read-only" | "retry-edit" | "retry-save"
    | "protection-cancel" | "protection-save" | "protection-discard"
    | "continue-editing" | "restore-recovery"
    | "reconnect-publication" | "discard-publication"
    | "keep-newer-edits" | "export-newer-edits" | "discard-newer-edits"
    | "discard-recovery" | "accept-head" | "discard-unreadable"
    | "confirm-lease" | "cancel-lease" | "migrate" | "compact"
    | "compaction-canceled"): Promise<"passwords" | "export" | void> {
    const snapshot = this.current();
    if (this.disposed) return;
    if (action === "protection-cancel" || action === "protection-save"
      || action === "protection-discard") {
      if (snapshot.attention?.kind !== "lifecycle-protection") return;
      const epoch = this.epoch;
      const outcome = await this.session.decideProtection(action === "protection-cancel"
        ? "cancel" : action === "protection-save" ? "save" : "discard");
      this.current();
      if (this.disposed || this.epoch !== epoch) return;
      if (outcome.status === "protection-canceled") {
        this.safeMessage = "Action canceled; the current document remains open and usable.";
        this.focusIntent = "return";
      } else if (outcome.status === "failed") this.focusIntent = "decision-action";
      return;
    }
    if (action === "keep-newer-edits" || action === "export-newer-edits"
      || action === "discard-newer-edits") {
      if (!this.confirmDivergenceDiscard) return;
      if (action === "discard-newer-edits") await this.beginDivergenceResolution(true);
      else {
        this.confirmDivergenceDiscard = false;
        this.focusIntent = "return";
        if (action === "export-newer-edits") return "export";
      }
      return;
    }
    if ((snapshot.kind !== "read-only" && snapshot.kind !== "edit")
      || !snapshot.attention) return;
    if (action === "retry-save" || action === "continue-editing") {
      if (snapshot.attention.kind !== "save-failed") return;
      if (action === "retry-save") await this.save();
      else {
        this.session.dismissSaveFailure();
        this.safeMessage = null;
        this.focusIntent = "return";
      }
      return;
    }
    if (action === "reconnect-publication" || action === "discard-publication") {
      if (snapshot.attention.kind !== "publication-decision") return;
      const adoption = snapshot.adoption;
      const epoch = this.epoch;
      const outcome = await (action === "reconnect-publication"
        ? this.session.retryPublication() : this.session.discardPublication());
      const current = this.current();
      if (this.disposed || this.epoch !== epoch
        || (current.kind !== "read-only" && current.kind !== "edit")
        || current.adoption !== adoption) return;
      if (outcome.status === "divergence-required") {
        await this.beginDivergenceResolution();
      } else if (outcome.status === "publication") {
        this.safeMessage = outcome.publicationState === "target-published"
          ? "Pending manual save published and verified."
          : outcome.publicationState === "conflict"
            ? "The target changed; divergence must be resolved without overwriting it."
            : "The target is still unavailable; publication remains pending.";
        this.focusIntent = outcome.publicationState === "target-published"
          ? "return" : "publication-retry";
      } else if (outcome.status === "publication-discarded") {
        this.safeMessage = "Pending manual save explicitly discarded.";
        this.focusIntent = "return";
      } else if (outcome.status === "failed") {
        this.safeMessage = `${action === "reconnect-publication" ? "Publication retry"
          : "Publication discard"} needs attention: ${this.catalogText(outcome.code)}`;
        this.focusIntent = action === "discard-publication"
          ? "decision-action" : "publication-retry";
      }
      return;
    }
    if (action === "confirm-lease" || action === "cancel-lease"
      || action === "migrate" || action === "compact"
      || action === "compaction-canceled") {
      const attention = snapshot.attention;
      if ((action === "confirm-lease" || action === "cancel-lease")
        ? attention.kind !== "lease-takeover"
        : action === "migrate" ? attention.kind !== "migration-decision"
          : attention.kind !== "compaction-decision") return;
      const adoption = snapshot.adoption;
      const epoch = this.epoch;
      this.leaseError = null;
      if ((action === "confirm-lease" || action === "cancel-lease")
        && attention.kind === "lease-takeover") this.leaseInFlight = {
          holderName: attention.holderName, operation: attention.operation,
          ...(attention.reason ? { reason: attention.reason } : {}),
        };
      if (action === "compact") this.compactionInFlight = true;
      const outcome = await (action === "confirm-lease" ? this.session.confirmLeaseTakeover()
        : action === "cancel-lease" ? this.session.cancelLeaseTakeover()
        : action === "migrate" ? this.session.migrate()
        : action === "compact" ? this.session.confirmCompaction()
        : this.session.cancelCompaction());
      const current = this.current();
      if (this.disposed || this.epoch !== epoch
        || (current.kind !== "read-only" && current.kind !== "edit")
        || current.adoption !== adoption) return;
      this.leaseInFlight = null;
      this.compactionInFlight = false;
      if (outcome.status === "attention") {
        if (action === "confirm-lease") {
          this.leaseError = "The lease changed. Review the current holder before trying again.";
          this.focusIntent = "decision-action";
        } else this.safeMessage = action === "migrate"
          ? "Migration requires a confirmed lease takeover."
          : "Editing requires a confirmed lease takeover.";
      } else if (outcome.status === "canceled") {
        this.safeMessage = outcome.revoked
          ? "Lease takeover canceled; the document session is unchanged."
          : "Lease takeover was already inactive; the document session is unchanged.";
        this.focusIntent = "return";
      } else if (outcome.status === "migration-canceled") {
        this.safeMessage = "Migration was canceled before publication. Retry to acquire fresh lease authorization.";
        this.focusIntent = "migration-retry";
      } else if (outcome.status === "compaction-canceled") {
        this.safeMessage = "Compaction canceled; document history is unchanged.";
        this.focusIntent = "return";
      } else if (outcome.status === "migration") {
        this.safeMessage = this.catalogText(outcome.compatibilityCode);
        this.focusIntent = "return";
      } else if (outcome.status === "compaction") {
        this.safeMessage = "Verified backup created and document history compacted.";
        this.focusIntent = "return";
      } else if (outcome.status === "recovery") {
        this.safeMessage = "Recovered work restored as unsaved changes.";
        this.focusIntent = "return";
      } else if (outcome.status === "edit-mode") {
        this.safeMessage = "Edit mode entered after confirmed lease takeover.";
        this.focusIntent = "return";
      } else if (outcome.status === "divergence") {
        this.safeMessage = outcome.hasConflicts
          ? "Resolve every local/current marker, then save the merge."
          : "The three-way merge is clean. Review it, then save the merge.";
        this.focusIntent = "return";
      } else if (outcome.status === "failed") {
        const value = this.catalogText(outcome.code);
        if (action === "cancel-lease") this.safeMessage =
          `Lease takeover cancellation needs attention: ${value}`;
        else if (action === "confirm-lease") {
          const operation = attention.kind === "lease-takeover" ? attention.operation : "edit";
          const prefix = operation === "migration" ? "Migration"
            : operation === "recovery" ? "Recovery restore"
              : operation === "divergence" ? "Divergence resolution" : "Editing";
          this.safeMessage = `${prefix} needs attention: ${value}`;
          this.focusIntent = operation === "migration" ? "migration-retry"
            : operation === "divergence" ? "publication-retry"
            : operation === "edit" ? "edit-retry" : "recovery-restore";
        } else {
          this.safeMessage = value;
          this.focusIntent = action === "migrate" ? "migration-retry" : "decision-action";
        }
      }
      return;
    }
    if (action === "restore-recovery" || action === "discard-recovery"
      || action === "accept-head" || action === "discard-unreadable") {
      const expected = action === "accept-head" ? "head-mismatch"
        : action === "discard-unreadable" ? "unreadable-journal" : "recovery-decision";
      if (snapshot.attention.kind !== expected) return;
      const adoption = snapshot.adoption;
      const epoch = this.epoch;
      const outcome = await (action === "restore-recovery" ? this.session.restoreRecovery()
        : action === "discard-recovery" ? this.session.discardRecovery()
        : action === "accept-head" ? this.session.acceptHeadMismatch()
        : this.session.discardUnreadableJournal());
      const current = this.current();
      if (this.disposed || this.epoch !== epoch
        || (current.kind !== "read-only" && current.kind !== "edit")
        || current.adoption !== adoption) return;
      if (outcome.status === "recovery") {
        this.safeMessage = "Recovered work restored as unsaved changes.";
      } else if (outcome.status === "recovery-discarded") {
        this.safeMessage = "Recovered work discarded.";
      } else if (outcome.status === "head-accepted") {
        this.safeMessage = "Current authenticated head accepted. Editing may now be enabled.";
      } else if (outcome.status === "unreadable-discarded") {
        this.safeMessage = "Unreadable recovery journal discarded. Editing may now be enabled.";
      } else if (outcome.status === "attention") {
        this.safeMessage = "Restoring recovered work requires a confirmed lease takeover.";
      } else if (outcome.status === "failed") {
        const prefix = action === "restore-recovery" ? "Recovery restore"
          : action === "discard-recovery" ? "Recovery discard"
          : action === "accept-head" ? "Authenticated-head acceptance"
          : "Unreadable journal discard";
        this.safeMessage = `${prefix} needs attention: ${this.catalogText(outcome.code)}`;
      } else return;
      this.focusIntent = outcome.status === "failed" ? "decision-action" : "return";
      return;
    }
    if (snapshot.attention.kind !== "edit-unavailable") return;
    const adoption = snapshot.adoption;
    const epoch = this.epoch;
    this.session.dismissEditFailure();
    if (action === "continue-read-only") {
      this.safeMessage = null;
      this.focusIntent = "return";
      return;
    }
    const outcome = await this.session.enterEditMode();
    const current = this.current();
    if (this.disposed || this.epoch !== epoch
      || (current.kind !== "read-only" && current.kind !== "edit")
      || current.adoption !== adoption) return;
    if (outcome.status === "attention") {
      this.safeMessage = "Editing requires a confirmed lease takeover.";
    } else if (outcome.status === "edit-mode") {
      this.safeMessage = "Edit mode entered.";
    }
    this.focusIntent = "return";
  }
}
