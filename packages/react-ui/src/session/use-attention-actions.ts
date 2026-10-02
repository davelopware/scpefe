import { useState } from "react";
import type { DocumentSession } from "@scpefe/frontend-core";
import type { DialogAction } from "../dialogs/dialog-host.tsx";
import type { DialogName, DocumentOpened, Opened } from "./types.ts";

type FullSession = DocumentSession<DocumentOpened,
  Extract<Opened, { invitationRequired: true }>>;
type AttentionSession = Pick<FullSession, "getSnapshot" | "decideProtection" | "enterEditMode"
    | "lock" | "save" | "beginDivergenceResolution"
    | "retryPublication" | "discardPublication" | "backup"
    | "undo" | "redo">;

type LockResult = { locked: true; journalSaved: boolean; warningCode: string | null };

/** Owns graphical attention state and maps structured session outcomes to safe UI messages. */
export function useAttentionActions({ session, completion, catalogText,
  onMessage: setMessage, onDialog, onExport, onLocked }: {
  session: AttentionSession;
  completion: { track<T>(operation: () => T | Promise<T>): Promise<T> };
  catalogText(code: string): string;
  onMessage(message: string): void;
  onDialog(dialog: DialogName): void;
  onExport(): void;
  onLocked(result: LockResult, closed?: boolean): void;
}) {
  const [openedDialogError, setOpenedDialogError] = useState("");
  const [confirmDivergenceDiscard, setConfirmDivergenceDiscard] = useState(false);
  function reset() {
    setOpenedDialogError("");
    setConfirmDivergenceDiscard(false);
  }
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

  async function save() {
    const outcome = await session.save();
    if (outcome.status === "saved") {
      setMessage(outcome.publicationState === "pending-publication"
        ? "Manual save is pending publication; its exact candidate is stored locally."
        : outcome.publicationState === "conflict"
          ? "Manual save is local, but the target changed; divergence must be resolved."
          : "Manual save published and verified.");
    } else if (outcome.status === "failed") {
      setMessage(`Manual save failed; changes remain recoverable: ${catalogText(outcome.code)}`);
    }
  }

  function showDivergenceDraft(hasConflicts: boolean) {
    setOpenedDialogError("");
    setMessage(hasConflicts
      ? "Resolve every local/current marker, then save the merge."
      : "The three-way merge is clean. Review it, then save the merge.");
  }

  async function beginDivergenceResolution(discardUnsaved = false) {
    const action = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    setOpenedDialogError("");
    const outcome = await session.beginDivergenceResolution({ discardUnsaved });
    if (outcome.status === "attention") {
      setConfirmDivergenceDiscard(false);
      setMessage("Divergence resolution requires a confirmed lease takeover.");
    } else if (outcome.status === "divergence") {
      setConfirmDivergenceDiscard(false);
      showDivergenceDraft(outcome.hasConflicts);
    } else if (outcome.status === "unsaved-work") {
      setConfirmDivergenceDiscard(true);
    } else if (outcome.status === "failed") {
      setConfirmDivergenceDiscard(false);
      setMessage(`Divergence resolution needs attention: ${catalogText(outcome.code)}`);
      requestAnimationFrame(() => action?.focus());
    }
  }

  async function reconnectPublication() {
    const action = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    const outcome = await session.retryPublication();
    if (outcome.status === "divergence-required") {
      await beginDivergenceResolution();
    } else if (outcome.status === "publication") {
      setMessage(outcome.publicationState === "target-published"
        ? "Pending manual save published and verified."
        : outcome.publicationState === "conflict"
          ? "The target changed; divergence must be resolved without overwriting it."
          : "The target is still unavailable; publication remains pending.");
    } else if (outcome.status === "failed") {
      setMessage(`Publication retry needs attention: ${catalogText(outcome.code)}`);
      requestAnimationFrame(() => action?.focus());
    }
  }

  async function discardPublication() {
    const action = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    const outcome = await session.discardPublication();
    if (outcome.status === "publication-discarded") {
      setMessage("Pending manual save explicitly discarded.");
    } else if (outcome.status === "failed") {
      setMessage(`Publication discard needs attention: ${catalogText(outcome.code)}`);
      requestAnimationFrame(() => action?.focus());
    }
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
      case "retry-save": return save();
      case "lock": lock(); return;
      case "open-passwords": onDialog("passwords"); return;
      case "discard-publication": return discardPublication();
      case "reconnect-publication": return reconnectPublication();
      case "keep-newer-edits": setConfirmDivergenceDiscard(false); return;
      case "export-newer-edits": setConfirmDivergenceDiscard(false); onExport(); return;
      case "discard-newer-edits": return beginDivergenceResolution(true);
      case "protection-cancel": return completion.track(() => decideProtection("cancel"));
      case "protection-save": return completion.track(() => decideProtection("save"));
      case "protection-discard": return completion.track(() => decideProtection("discard"));
    }
  }
  return { openedDialogError, confirmDivergenceDiscard,
    reset, run: handleDialogAction, enterEditMode, save, backup, lock,
    moveHistory, beginDivergenceResolution };
}
