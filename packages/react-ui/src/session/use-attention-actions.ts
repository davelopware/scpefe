import { useState, type RefObject } from "react";
import type { DocumentSession, DocumentSessionSnapshot, SnapshotSource } from "@scpefe/frontend-core";
import { useSessionSnapshot } from "../use-session-snapshot.ts";
import type { DialogAction, DialogHostHandle } from "../dialogs/dialog-host.tsx";
import type { DialogName, DocumentOpened, LeaseOperation, Opened } from "./types.ts";

type FullSession = DocumentSession<DocumentOpened,
  Extract<Opened, { invitationRequired: true }>>;
type AttentionSession = SnapshotSource<DocumentSessionSnapshot<DocumentOpened>>
  & Pick<FullSession, "getSnapshot" | "decideProtection" | "enterEditMode"
    | "migrate" | "confirmLeaseTakeover" | "cancelLeaseTakeover"
    | "restoreRecovery" | "discardRecovery" | "acceptHeadMismatch"
    | "discardUnreadableJournal" | "lock" | "save" | "beginDivergenceResolution"
    | "retryPublication" | "discardPublication" | "backup"
    | "confirmCompaction" | "undo" | "redo">;

type LockResult = { locked: true; journalSaved: boolean; warningCode: string | null };

/** Owns graphical attention state and maps structured session outcomes to safe UI messages. */
export function useAttentionActions({ session, completion, catalogText,
  onMessage: setMessage, onDialog, onExport, onLocked, dialogHost }: {
  session: AttentionSession;
  completion: { track<T>(operation: () => T | Promise<T>): Promise<T> };
  catalogText(code: string): string;
  onMessage(message: string): void;
  onDialog(dialog: DialogName): void;
  onExport(): void;
  onLocked(result: LockResult, closed?: boolean): void;
  dialogHost: RefObject<DialogHostHandle | null>;
}) {
  const snapshot = useSessionSnapshot(session);
  const attention = snapshot.kind === "read-only" || snapshot.kind === "edit"
    ? snapshot.attention : undefined;
  const leaseDecision = attention?.kind === "lease-takeover" ? attention : null;
  const [decisionError, setDecisionError] = useState("");
  const [openedDialogError, setOpenedDialogError] = useState("");
  const [confirmDivergenceDiscard, setConfirmDivergenceDiscard] = useState(false);
  function reset() {
    setDecisionError(""); setOpenedDialogError("");
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
      setDecisionError("");
      setMessage("Editing requires a confirmed lease takeover.");
    } else if (outcome.status === "edit-mode") setMessage("Edit mode entered.");
  }

  function leaveConsumedTakeover(operation: LeaseOperation, value: string) {
    setDecisionError("");
    if (operation === "edit") {
      setMessage(`Editing needs attention: ${value}`);
      requestAnimationFrame(() => dialogHost.current?.focus("edit"));
      return;
    }
    setOpenedDialogError(value);
    setMessage(`${operation === "migration" ? "Migration"
      : operation === "recovery" ? "Recovery restore"
      : "Divergence resolution"} needs attention: ${value}`);
    requestAnimationFrame(() => {
      dialogHost.current?.focus(operation === "migration" ? "migration"
        : operation === "recovery" ? "recovery" : "publication");
    });
  }

  async function migrate() {
    setDecisionError("");
    const outcome = await session.migrate();
    if (outcome.status === "migration") setMessage(catalogText(outcome.compatibilityCode));
    else if (outcome.status === "attention")
      setMessage("Migration requires a confirmed lease takeover.");
    else if (outcome.status === "migration-canceled")
      setMessage("Migration was canceled before publication. Retry to acquire fresh lease authorization.");
    else if (outcome.status === "failed") setMessage(catalogText(outcome.code));
  }

  async function confirmLeaseTakeover() {
    if (!leaseDecision) return;
    setDecisionError("");
    const outcome = await session.confirmLeaseTakeover();
    if (outcome.status === "attention") {
      setDecisionError("The lease changed. Review the current holder before trying again.");
    } else if (outcome.status === "recovery") {
      setMessage("Recovered work restored as unsaved changes.");
    } else if (outcome.status === "divergence") {
      showDivergenceDraft(outcome.hasConflicts);
    } else if (outcome.status === "migration") {
      setMessage(catalogText(outcome.compatibilityCode));
    } else if (outcome.status === "edit-mode") {
      setMessage("Edit mode entered after confirmed lease takeover.");
    } else if (outcome.status === "failed") {
      leaveConsumedTakeover(leaseDecision.operation, catalogText(outcome.code));
    } else if (outcome.status === "migration-canceled") {
      setMessage("Migration was canceled before publication. Retry to acquire fresh lease authorization.");
      requestAnimationFrame(() => dialogHost.current?.focus("migration"));
    }
  }

  async function cancelLeaseDecision() {
    if (!leaseDecision) return;
    setDecisionError("");
    const outcome = await session.cancelLeaseTakeover();
    if (outcome.status === "canceled") {
      setMessage(outcome.revoked
        ? "Lease takeover canceled; the document session is unchanged."
        : "Lease takeover was already inactive; the document session is unchanged.");
    } else if (outcome.status === "failed") {
      const value = catalogText(outcome.code);
      setMessage(`Lease takeover cancellation needs attention: ${value}`);
    }
  }

  async function restoreRecovery() {
    const action = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    const outcome = await session.restoreRecovery();
    if (outcome.status === "attention") {
      setDecisionError("");
      setMessage("Restoring recovered work requires a confirmed lease takeover.");
    } else if (outcome.status === "recovery") {
      setMessage("Recovered work restored as unsaved changes.");
    } else if (outcome.status === "failed") {
      setMessage(`Recovery restore needs attention: ${catalogText(outcome.code)}`);
      requestAnimationFrame(() => action?.focus());
    }
  }

  async function discardRecovery() {
    const action = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    const outcome = await session.discardRecovery();
    if (outcome.status === "recovery-discarded") {
      setMessage("Recovered work discarded.");
    } else if (outcome.status === "failed") {
      setMessage(`Recovery discard needs attention: ${catalogText(outcome.code)}`);
      requestAnimationFrame(() => action?.focus());
    }
  }

  async function acceptHeadMismatch() {
    const action = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    const outcome = await session.acceptHeadMismatch();
    if (outcome.status === "head-accepted") {
      setMessage("Current authenticated head accepted. Editing may now be enabled.");
    } else if (outcome.status === "failed") {
      setMessage(`Authenticated-head acceptance needs attention: ${catalogText(outcome.code)}`);
      requestAnimationFrame(() => action?.focus());
    }
  }

  async function discardUnreadableJournal() {
    const action = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    const outcome = await session.discardUnreadableJournal();
    if (outcome.status === "unreadable-discarded") {
      setMessage("Unreadable recovery journal discarded. Editing may now be enabled.");
    } else if (outcome.status === "failed") {
      setMessage(`Unreadable journal discard needs attention: ${catalogText(outcome.code)}`);
      requestAnimationFrame(() => action?.focus());
    }
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
      setDecisionError("");
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

  async function compact() {
    const outcome = await session.confirmCompaction();
    if (outcome.status === "compaction") {
      onDialog("passwords");
      setMessage("Verified backup created and document history compacted.");
    } else if (outcome.status === "compaction-canceled") {
      setMessage("Compaction canceled; document history is unchanged.");
    } else if (outcome.status === "failed") setMessage(catalogText(outcome.code));
  }

  function moveHistory(offset: number) {
    if (offset < 0) session.undo();
    else session.redo();
  }

  function handleDialogAction(action: DialogAction): void | Promise<void> {
    switch (action) {
      case "retry-edit": return enterEditMode();
      case "cancel-lease": return cancelLeaseDecision();
      case "confirm-lease": return confirmLeaseTakeover();
      case "retry-save": return save();
      case "lock": lock(); return;
      case "migrate": return migrate();
      case "open-passwords": onDialog("passwords"); return;
      case "accept-head": return acceptHeadMismatch();
      case "discard-recovery": return discardRecovery();
      case "restore-recovery": return restoreRecovery();
      case "discard-unreadable": return discardUnreadableJournal();
      case "discard-publication": return discardPublication();
      case "reconnect-publication": return reconnectPublication();
      case "compact": return compact();
      case "compaction-canceled": setMessage("Compaction canceled; document history is unchanged."); return;
      case "keep-newer-edits": setConfirmDivergenceDiscard(false); return;
      case "export-newer-edits": setConfirmDivergenceDiscard(false); onExport(); return;
      case "discard-newer-edits": return beginDivergenceResolution(true);
      case "protection-cancel": return completion.track(() => decideProtection("cancel"));
      case "protection-save": return completion.track(() => decideProtection("save"));
      case "protection-discard": return completion.track(() => decideProtection("discard"));
    }
  }
  return { decisionError, openedDialogError, confirmDivergenceDiscard,
    reset, run: handleDialogAction, enterEditMode, save, backup, lock,
    moveHistory, beginDivergenceResolution };
}
