import type { DocumentSession, DocumentSessionSnapshot } from "@scpefe/frontend-core";
import type { DocumentOpened, Opened } from "./types.ts";

type FullSession = DocumentSession<DocumentOpened,
  Extract<Opened, { invitationRequired: true }>>;
type PresentationSession = Pick<FullSession,
  "getSnapshot" | "dismissEditFailure" | "enterEditMode">;

/** The single edit-failure decision exposed to graphical renderers. */
export interface EditUnavailableDecision {
  readonly kind: "edit-unavailable";
  readonly message: string;
}

/** Observable graphical state for the first document-attention cutover. */
export interface SessionPresentationView {
  readonly selectedDecision: EditUnavailableDecision | null;
  readonly blocked: boolean;
  readonly safeMessage: string | null;
  readonly focusIntent: "edit-retry" | "return" | null;
}

/** Owns edit-failure selection, action, and safe outcome presentation for one app mount. */
export class SessionPresentation {
  private safeMessage: string | null = null;
  private focusIntent: "return" | null = null;
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

  view(): SessionPresentationView {
    const snapshot = this.current();
    const attention = snapshot.kind === "read-only" || snapshot.kind === "edit"
      ? snapshot.attention : undefined;
    const selectedDecision = attention?.kind === "edit-unavailable"
      ? { kind: "edit-unavailable" as const, message: this.catalogText(attention.code) }
      : null;
    return { selectedDecision, blocked: selectedDecision !== null,
      safeMessage: this.safeMessage,
      focusIntent: selectedDecision ? "edit-retry" : this.focusIntent };
  }

  async act(action: "continue-read-only" | "retry-edit"): Promise<void> {
    const snapshot = this.current();
    if ((snapshot.kind !== "read-only" && snapshot.kind !== "edit")
      || snapshot.attention?.kind !== "edit-unavailable") return;
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
