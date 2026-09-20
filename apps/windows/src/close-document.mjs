/* Reports whether closing the active document needs an explicit unsaved-work choice. */
export function needsCloseDecision(active) {
  const regularSavePending = active?.pendingRecord?.publication?.purpose
    === "regular-save";
  return Boolean(active && (active.dirty || active.recovery
    || !active.manuallySealed || active.pendingPublication
    || active.unresolvedJournal || regularSavePending));
}

/* Applies one explicit close choice while preserving service lease and publication checks. */
export async function applyCloseDecision(service, decision) {
  if (decision === "cancel") return false;
  if (decision === "save") {
    if (service.active.pendingPublication) {
      const resumed = await service.reconnectPendingPublication();
      if (resumed.publicationState !== "target-published") {
        throw new Error("Resolve the saved divergence in the app before exiting");
      }
    }
    if (service.active.recovery) await service.restoreRecoveredWork();
    else if (!service.active.editMode) await service.enterEditMode();
    await service.saveDocument(service.active.working.content);
    return true;
  }
  if (decision !== "discard") throw new TypeError("invalid close decision");
  await service.discardUnsavedForClose();
  if (needsCloseDecision(service.active)) {
    const error = new Error("Discard did not restore a manually sealed close state");
    error.code = "CLOSE_DISCARD_BLOCKED";
    throw error;
  }
  return true;
}
