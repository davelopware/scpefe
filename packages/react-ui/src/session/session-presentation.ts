import type { DocumentSession, DocumentSessionSnapshot } from "@scpefe/frontend-core";
import type { DocumentOpened, Opened } from "./types.ts";

type FullSession = DocumentSession<DocumentOpened,
  Extract<Opened, { invitationRequired: true }>>;
type PresentationSession = Pick<FullSession,
  "getSnapshot" | "dismissEditFailure" | "enterEditMode" | "restoreRecovery"
  | "discardRecovery" | "acceptHeadMismatch" | "discardUnreadableJournal">;

/** The single edit-failure decision exposed to graphical renderers. */
export interface EditUnavailableDecision {
  readonly kind: "edit-unavailable";
  readonly message: string;
}

/** A recovery, authenticated-head, or unreadable-journal decision ready to render. */
export type DocumentAttentionDecision =
  | { readonly kind: "recovery-decision"; readonly updateTime: number;
    readonly failureMessage: string | null }
  | { readonly kind: "head-mismatch"; readonly mismatchKind: "rollback"
    | "divergence" | "replacement" | "witness-error";
    readonly failureMessage: string | null }
  | { readonly kind: "unreadable-journal";
    readonly failureMessage: string | null };

/** Observable graphical state for selected document attention. */
export interface SessionPresentationView {
  readonly selectedDecision: EditUnavailableDecision | DocumentAttentionDecision | null;
  readonly blocked: boolean;
  readonly safeMessage: string | null;
  readonly focusIntent: "edit-retry" | "recovery-restore" | "decision-action"
    | "return" | null;
}

/** Selects document decisions and presents their actions, safe outcomes, and focus. */
export class SessionPresentation {
  private safeMessage: string | null = null;
  private focusIntent: "decision-action" | "return" | null = null;
  private adoption: number | null = null;

  constructor(private readonly session: PresentationSession,
    private readonly catalogText: (code: string) => string) {}

  private current(): DocumentSessionSnapshot<DocumentOpened> {
    const snapshot = this.session.getSnapshot();
    const adoption = snapshot.kind === "read-only" || snapshot.kind === "edit"
      ? snapshot.adoption : null;
    if (this.adoption !== adoption) {
      this.adoption = adoption;
      this.safeMessage = null;
      this.focusIntent = null;
    }
    return snapshot;
  }

  view({ formActive = false }: { formActive?: boolean } = {}): SessionPresentationView {
    const snapshot = this.current();
    const attention = snapshot.kind === "read-only" || snapshot.kind === "edit"
      ? snapshot.attention : undefined;
    const selectedDecision = attention?.kind === "edit-unavailable"
      ? { kind: "edit-unavailable" as const, message: this.catalogText(attention.code) }
      : formActive ? null
      : attention?.kind === "recovery-decision"
        ? { kind: "recovery-decision" as const, updateTime: attention.updateTime,
          failureMessage: attention.failureCode ? this.catalogText(attention.failureCode) : null }
      : attention?.kind === "head-mismatch"
        ? { kind: "head-mismatch" as const, mismatchKind: attention.mismatchKind,
          failureMessage: attention.failureCode ? this.catalogText(attention.failureCode) : null }
      : attention?.kind === "unreadable-journal"
        ? { kind: "unreadable-journal" as const,
          failureMessage: attention.failureCode ? this.catalogText(attention.failureCode) : null }
      : null;
    return { selectedDecision, blocked: selectedDecision !== null,
      safeMessage: this.safeMessage,
      focusIntent: selectedDecision?.kind === "edit-unavailable" ? "edit-retry"
        : selectedDecision?.kind === "recovery-decision" && selectedDecision.failureMessage
          ? "recovery-restore" : this.focusIntent };
  }

  async act(action: "continue-read-only" | "retry-edit" | "restore-recovery"
    | "discard-recovery" | "accept-head" | "discard-unreadable"): Promise<void> {
    const snapshot = this.current();
    if ((snapshot.kind !== "read-only" && snapshot.kind !== "edit")
      || !snapshot.attention) return;
    if (action === "restore-recovery" || action === "discard-recovery"
      || action === "accept-head" || action === "discard-unreadable") {
      const expected = action === "accept-head" ? "head-mismatch"
        : action === "discard-unreadable" ? "unreadable-journal" : "recovery-decision";
      if (snapshot.attention.kind !== expected) return;
      const adoption = snapshot.adoption;
      const outcome = await (action === "restore-recovery" ? this.session.restoreRecovery()
        : action === "discard-recovery" ? this.session.discardRecovery()
        : action === "accept-head" ? this.session.acceptHeadMismatch()
        : this.session.discardUnreadableJournal());
      const current = this.current();
      if ((current.kind !== "read-only" && current.kind !== "edit")
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
    this.session.dismissEditFailure();
    if (action === "continue-read-only") {
      this.safeMessage = null;
      this.focusIntent = "return";
      return;
    }
    const outcome = await this.session.enterEditMode();
    const current = this.current();
    if ((current.kind !== "read-only" && current.kind !== "edit")
      || current.adoption !== adoption) return;
    if (outcome.status === "attention") {
      this.safeMessage = "Editing requires a confirmed lease takeover.";
    } else if (outcome.status === "edit-mode") {
      this.safeMessage = "Edit mode entered.";
    }
    this.focusIntent = "return";
  }
}
