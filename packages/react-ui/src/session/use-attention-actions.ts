import { useEffect, useRef } from "react";
import type { DocumentSession } from "@scpefe/frontend-core";
import type { DialogAction } from "../dialogs/dialog-host.tsx";
import type { DialogName, DocumentOpened, Opened } from "./types.ts";

type FullSession = DocumentSession<DocumentOpened,
  Extract<Opened, { invitationRequired: true }>>;
type AttentionSession = Pick<FullSession, "getSnapshot" | "enterEditMode"
    | "lock" | "backup"
    | "undo" | "redo">;

type LockResult = { locked: true; journalSaved: boolean; warningCode: string | null };

/** Handles remaining shell and lifecycle actions outside session presentation. */
export function useAttentionActions({ session, catalogText,
  onMessage: setMessage, onDialog, onLocked }: {
  session: AttentionSession;
  catalogText(code: string): string;
  onMessage(message: string): void;
  onDialog(dialog: DialogName): void;
  onLocked(result: LockResult, closed?: boolean): void;
}) {
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  function currentAdoption(): number | null {
    const snapshot = session.getSnapshot();
    return snapshot.kind === "read-only" || snapshot.kind === "edit"
      ? snapshot.adoption : null;
  }

  async function enterEditMode() {
    const adoption = currentAdoption();
    const outcome = await session.enterEditMode();
    if (!mounted.current || adoption !== currentAdoption()) return;
    if (outcome.status === "attention") {
      setMessage("Editing requires a confirmed lease takeover.");
    } else if (outcome.status === "edit-mode") setMessage("Edit mode entered.");
  }

  async function lock() {
    const outcome = await session.lock();
    if (!mounted.current) return;
    if (outcome.status === "locked") onLocked({
      locked: true, journalSaved: true, warningCode: outcome.warningCode,
    });
    else if (outcome.status === "failed") setMessage(catalogText(outcome.code));
  }

  async function backup() {
    const adoption = currentAdoption();
    const outcome = await session.backup();
    if (!mounted.current || adoption !== currentAdoption()) return;
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
    }
  }
  return { run: handleDialogAction, enterEditMode, backup, lock, moveHistory };
}
