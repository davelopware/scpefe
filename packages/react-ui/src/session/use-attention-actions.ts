import type { DocumentSession } from "@scpefe/frontend-core";
import type { DialogAction } from "../dialogs/dialog-host.tsx";
import type { DialogName, DocumentOpened, Opened } from "./types.ts";

type FullSession = DocumentSession<DocumentOpened,
  Extract<Opened, { invitationRequired: true }>>;
type AttentionSession = Pick<FullSession, "getSnapshot" | "decideProtection" | "enterEditMode"
    | "lock" | "backup"
    | "undo" | "redo">;

type LockResult = { locked: true; journalSaved: boolean; warningCode: string | null };

/** Handles remaining shell and lifecycle actions outside session presentation. */
export function useAttentionActions({ session, completion, catalogText,
  onMessage: setMessage, onDialog, onLocked }: {
  session: AttentionSession;
  completion: { track<T>(operation: () => T | Promise<T>): Promise<T> };
  catalogText(code: string): string;
  onMessage(message: string): void;
  onDialog(dialog: DialogName): void;
  onLocked(result: LockResult, closed?: boolean): void;
}) {
  async function decideProtection(decision: "cancel" | "save" | "discard") {
    const snapshot = session.getSnapshot();
    if (snapshot.attention?.kind !== "lifecycle-protection") return;
    const outcome = await session.decideProtection(decision);
    if (outcome.status === "protection-canceled") {
      setMessage("Action canceled; the current document remains open and usable.");
    }
  }

  async function enterEditMode() {
    const outcome = await session.enterEditMode();
    if (outcome.status === "attention") {
      setMessage("Editing requires a confirmed lease takeover.");
    } else if (outcome.status === "edit-mode") setMessage("Edit mode entered.");
  }

  async function lock() {
    const outcome = await session.lock();
    if (outcome.status === "locked") onLocked({
      locked: true, journalSaved: true, warningCode: outcome.warningCode,
    });
    else if (outcome.status === "failed") setMessage(catalogText(outcome.code));
  }

  async function backup() {
    const outcome = await session.backup();
    if (outcome.status === "backup") setMessage(outcome.created
      ? "Verified byte-identical backup replica created."
      : "Backup canceled; the document and destination are unchanged.");
    else if (outcome.status === "failed") setMessage(catalogText(outcome.code));
  }

  function moveHistory(offset: number) {
    if (offset < 0) session.undo();
    else session.redo();
  }

  function handleDialogAction(action: DialogAction): void | Promise<void> {
    switch (action) {
      case "lock": lock(); return;
      case "open-passwords": onDialog("passwords"); return;
      case "protection-cancel": return completion.track(() => decideProtection("cancel"));
      case "protection-save": return completion.track(() => decideProtection("save"));
      case "protection-discard": return completion.track(() => decideProtection("discard"));
    }
  }
  return { run: handleDialogAction, enterEditMode, backup, lock, moveHistory };
}
