import { needsCloseDecision } from "./close-document.mjs";

function switchError(message, code = "DOCUMENT_SWITCH_BLOCKED") {
  const error = new Error(message);
  error.code = code;
  return error;
}

/* Applies an explicit switch choice without discarding unresolved state implicitly. */
export async function applySwitchDecision(service, decision) {
  if (decision === "cancel") return Object.freeze({ proceed: false });
  const active = service.active;
  if (!active) return Object.freeze({ proceed: true, pendingPublication: false });
  if (!needsCloseDecision(active)) {
    return Object.freeze({ proceed: true, pendingPublication: false });
  }
  if (decision === "discard") {
    if (service.active.unreadableJournal) {
      throw switchError(
        "The unreadable recovery journal requires explicit destructive confirmation",
        "DOCUMENT_SWITCH_UNREADABLE_JOURNAL");
    }
    if (service.active.pendingPublication) {
      await service.discardPendingPublication();
    }
    if (needsCloseDecision(service.active)) await service.discardUnsavedForClose();
    if (needsCloseDecision(service.active)) {
      throw switchError("Unresolved recovery state must be handled before opening another document");
    }
    return Object.freeze({ proceed: true, pendingPublication: false });
  }
  if (decision !== "save") throw new TypeError("invalid switch decision");
  if (active.unresolvedJournal && !active.pendingPublication && !active.recovery
      && !active.dirty && active.manuallySealed) {
    throw switchError(
      "An unreadable work journal must be resolved before opening another document");
  }
  if (service.active.pendingPublication) {
    const regularSave = service.active.pendingRecord?.publication?.purpose
      === "regular-save";
    const resumed = await service.reconnectPendingPublication();
    if (resumed.publicationState === "conflict") {
      throw switchError(
        "Resolve the divergent pending publication before opening another document",
        "DOCUMENT_SWITCH_CONFLICT");
    }
    if (resumed.publicationState === "pending-publication") {
      if (regularSave) {
        throw switchError(
          "The provisional save cannot be sealed while its target is unavailable",
          "DOCUMENT_SWITCH_PROVISIONAL_PENDING");
      }
      return Object.freeze({ proceed: true, pendingPublication: true });
    }
    if (!regularSave) {
      return Object.freeze({ proceed: true, pendingPublication: false });
    }
  }
  if (service.active.recovery) await service.restoreRecoveredWork();
  else if (!service.active.editMode) await service.enterEditMode();
  const result = await service.saveDocument(service.active.working.content);
  if (result.publicationState === "conflict") {
    throw switchError(
      "Resolve the divergent pending publication before opening another document",
      "DOCUMENT_SWITCH_CONFLICT");
  }
  return Object.freeze({ proceed: true,
    pendingPublication: result.publicationState === "pending-publication" });
}

/* Finishes a switch by releasing edit mode and locking the old session safely. */
export async function finishDocumentSwitch(service) {
  if (!service.active) return Object.freeze({ switched: true });
  if (service.active.editMode && !service.active.pendingPublication) {
    await service.exitEditMode();
  }
  const result = await service.lock("open-another");
  if (!result.journalSaved) {
    throw switchError(result.warning
      ?? "The current document could not be checkpointed before switching");
  }
  return Object.freeze({ switched: true });
}

/* Serializes open operations so concurrent shell requests cannot race session state. */
export class OpenRequestQueue {
  constructor() { this.tail = Promise.resolve(); }

  run(operation) {
    const result = this.tail.catch(() => {}).then(operation);
    this.tail = result;
    return result;
  }
}
