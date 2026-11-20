const ENVELOPE_PREFIX = "SCPEFE_SAFE_ERROR:";

export const ERROR_CATALOG = Object.freeze({
  OPERATION_FAILED: ["The operation could not be completed safely.", "Try again or cancel without changing the current document."],
  PROFILE_FAILED: ["The local profile operation could not be completed.", "Review the fields and try again."],
  CREATE_FAILED: ["The encrypted document could not be created.", "Review the security details and try again, or cancel."],
  OPEN_FAILED: ["The document could not be opened.", "Check the password and try again, or cancel."],
  UNLOCK_FAILED: ["The document could not be unlocked.", "Check the password and try again."],
  SAVE_FAILED: ["The document could not be saved.", "The working copy remains available; retry or cancel."],
  PUBLICATION_FAILED: ["The pending publication could not be completed.", "Keep the document open and retry when the target is available."],
  BACKUP_FAILED: ["The verified backup could not be created.", "Choose another destination or cancel."],
  COMPACTION_FAILED: ["Document compaction could not be completed.", "The document remains unchanged; retry or cancel."],
  EXPORT_FAILED: ["The plaintext copy could not be exported.", "Choose another destination or cancel."],
  PASSWORD_CHANGE_FAILED: ["The password operation could not be completed.", "Review the passwords and try again."],
  WEAK_PASSWORD: ["The proposed password is too predictable.", "Choose a passphrase that is harder to guess."],
  OWNER_PASSWORD_WEAK: ["The owner password is too predictable.", "Choose a passphrase that is harder to guess."],
  RECOVERY_PASSWORD_WEAK: ["The recovery password is too predictable.", "Choose an independent passphrase that is harder to guess."],
  PASSWORD_ALREADY_IN_USE: ["The proposed password already unlocks another slot in this document.", "Choose a different password."],
  INVITATION_FAILED: ["The invitation operation could not be completed.", "Review the details and try again, or cancel."],
  LIFECYCLE_FAILED: ["The document protection choice could not be completed.", "The current session remains open; retry or cancel."],
  JOURNAL_WARNING: ["Local recovery needs attention.", "Keep the document open and review its recovery state."],
  LOCK_CHECKPOINT_FAILED: ["Latest changes could not be checkpointed.", "The document was locked; review recovery status before continuing."],
  SLOT_REMOVED: ["Password slot removed.", "Removal affects only this updated document and cannot revoke older copies."],
  PUBLICATION_RECOVERED: ["Interrupted publication was completed and verified.", ""],
  PUBLICATION_CONFLICT: ["The target changed while publication was pending; divergence must be resolved.", "Review the authenticated conflict before editing."],
  PUBLICATION_CONFIRMATION_REQUIRED: ["Interrupted publication needs confirmation; recovery data was preserved.", "Review the pending publication before continuing."],
  RECOVERY_READ_FAILED: ["Recovered work could not be read safely.", "The document remains protected; review recovery options."],
  REGULAR_SAVE_TARGET_UNAVAILABLE: ["The target is unavailable; regular save was skipped and work remains unsaved locally.", "Retry when the target is available."],
  LEASE_REFRESH_FAILED: ["Editing lease refresh failed; the lease could not be verified, so the document was locked.", "Restore target access, unlock, inspect recovered work and the authenticated current target and lease, then resume editing only when allowed."],
  PUBLICATION_AUTH_CONFLICT: ["The target was replaced or failed authentication; the pending candidate was preserved as a conflict.", "Review the authenticated conflict before continuing."],
  PUBLICATION_PENDING_TARGET_UNAVAILABLE: ["The target is unavailable; the manual save remains pending locally.", "Retry publication when the target is available."],
  REGULAR_SAVE_CONFLICT: ["The target changed before regular save; unsaved work was preserved for divergence resolution.", "Resolve the authenticated conflict before continuing."],
  MERGE_TARGET_REAUTHENTICATION: ["The target no longer accepts this password wrapper.", "Enter the current target password to authenticate access before resolving the saved conflict."],
  MERGE_ACCESS_REVOKED: ["This password slot was removed from the current target.", "Keep the encrypted local work and ask a current administrator to review access."],
  MERGE_PERMISSION_DENIED: ["This password slot no longer permits editing the current target.", "Keep the encrypted local work and ask a current administrator to review permissions."],
  MERGE_BASE_UNAVAILABLE: ["The common merge base is unavailable.", "Use a verified backup for the base, or compare the two available versions manually."],
  MERGE_UNRELATED_TARGET: ["The current target belongs to another document.", "Review the replacement before deciding where to save local work."],
  MERGE_TARGET_ROLLBACK: ["The current target has rolled back.", "Review the older replica before deciding where to save local work."],
  RECOVERY_CHECKPOINT_FAILED: ["Recovery checkpoint failed.", "Keep the document open and retry before closing."],
  REGULAR_SAVE_FAILED: ["Regular save failed.", "The working copy remains unsaved; retry or save manually."],
  STALE_OPERATION: ["The edit checkpoint belongs to an earlier save or edit.", "Keep the document open while its current checkpoint settles before retrying."],
  LEASE_ACTIVE: ["Another editing session holds this document's editing lease.", "That session must release the lease before this copy can edit."],
  LEASE_CHANGED: ["The document's editing lease changed.", "Keep your work open and review the current target before retrying."],
  EDIT_DENIED: ["This password slot cannot edit the document.", "Open with a password that has editing rights."],
  TARGET_UNAVAILABLE: ["The selected document cannot be read from its provider.", "Restore access to the file and retry."],
  TARGET_CHANGED: ["The selected document changed outside this editing session.", "Review the current target before trying to save."],
  PRIVATE_STATE_UNAVAILABLE: ["Local recovery state cannot be written.", "Check available device storage and keep the document open until recovery is saved."],
  RECOVERY_REQUIRED: ["Unsaved recovered work needs a decision.", "Restore or discard that work before editing."],
  PUBLICATION_PENDING: ["An earlier write still needs confirmation.", "Review the pending publication before editing or saving."],
  PUBLICATION_FAILED: ["The document provider refused the write.", "The working copy and recovery journal remain available; check write access before retrying."],
  PUBLICATION_AMBIGUOUS: ["The provider write could not be confirmed.", "Keep the document open and retry reconciliation when the target is available."],
  PROFILE_REQUIRED: ["A local profile is required for editing.", "Complete profile setup before trying again."],
  PROFILE_UNAVAILABLE: ["The local profile cannot be read.", "Check app storage access and retry."],
});

const OPERATIONS = Object.freeze({
  "profile:get": "PROFILE_FAILED", "profile:save": "PROFILE_FAILED",
  "document:create": "CREATE_FAILED", "document:open-selected": "OPEN_FAILED",
  "document:open-external": "OPEN_FAILED", "document:unlock": "UNLOCK_FAILED",
  "document:save": "SAVE_FAILED", "document:save-divergence-resolution": "SAVE_FAILED",
  "document:reconnect-publication": "PUBLICATION_FAILED", "document:backup": "BACKUP_FAILED",
  "document:compact": "COMPACTION_FAILED",
  "document:export-plaintext": "EXPORT_FAILED", "document:change-password": "PASSWORD_CHANGE_FAILED",
  "document:create-invitation": "INVITATION_FAILED", "document:claim-invitation": "INVITATION_FAILED",
  "document:resolve-protection": "LIFECYCLE_FAILED", "document:close": "LIFECYCLE_FAILED",
  "application:exit": "LIFECYCLE_FAILED", "document:lock": "LOCK_CHECKPOINT_FAILED",
  "journal:summary": "JOURNAL_WARNING",
});

const INTERNAL_CODES = Object.freeze({
  OWNER_PASSWORD_WEAK: "OWNER_PASSWORD_WEAK", RECOVERY_PASSWORD_WEAK: "RECOVERY_PASSWORD_WEAK",
  DOCUMENT_PROTECTION_BUSY: "LIFECYCLE_FAILED", DOCUMENT_PROTECTION_LOCKED: "LIFECYCLE_FAILED",
  DOCUMENT_PROTECTION_STALE: "LIFECYCLE_FAILED", DOCUMENT_SESSION_INVALIDATED: "LIFECYCLE_FAILED",
  DOCUMENT_REPLACEMENT_CANCELED: "LIFECYCLE_FAILED", DOCUMENT_REPLACEMENT_TARGET_CHANGED: "OPEN_FAILED",
  CLOSE_DISCARD_BLOCKED: "LIFECYCLE_FAILED",
  MERGE_TARGET_REAUTHENTICATION: "MERGE_TARGET_REAUTHENTICATION",
  MERGE_ACCESS_REVOKED: "MERGE_ACCESS_REVOKED",
  MERGE_PERMISSION_DENIED: "MERGE_PERMISSION_DENIED",
  MERGE_BASE_UNAVAILABLE: "MERGE_BASE_UNAVAILABLE",
  MERGE_UNRELATED_TARGET: "MERGE_UNRELATED_TARGET",
  MERGE_TARGET_ROLLBACK: "MERGE_TARGET_ROLLBACK",
  STALE_OPERATION: "STALE_OPERATION", LEASE_ACTIVE: "LEASE_ACTIVE",
  LEASE_CHANGED: "LEASE_CHANGED", EDIT_DENIED: "EDIT_DENIED",
  TARGET_UNAVAILABLE: "TARGET_UNAVAILABLE", TARGET_CHANGED: "TARGET_CHANGED",
  PRIVATE_STATE_UNAVAILABLE: "PRIVATE_STATE_UNAVAILABLE",
  RECOVERY_CHECKPOINT_FAILED: "RECOVERY_CHECKPOINT_FAILED",
  RECOVERY_REQUIRED: "RECOVERY_REQUIRED",
  PUBLICATION_PENDING: "PUBLICATION_PENDING",
  PUBLICATION_FAILED: "PUBLICATION_FAILED",
  PUBLICATION_AMBIGUOUS: "PUBLICATION_AMBIGUOUS",
  PROFILE_REQUIRED: "PROFILE_REQUIRED", PROFILE_UNAVAILABLE: "PROFILE_UNAVAILABLE",
});

export function operationErrorCode(operation = "operation") {
  if (OPERATIONS[operation]) return OPERATIONS[operation];
  if (operation?.startsWith("profile:")) return "PROFILE_FAILED";
  if (operation?.includes("password") || operation?.includes("slot")) return "PASSWORD_CHANGE_FAILED";
  if (operation?.includes("invitation")) return "INVITATION_FAILED";
  if (operation?.includes("open")) return "OPEN_FAILED";
  return "OPERATION_FAILED";
}

export function isCatalogCode(code) {
  return typeof code === "string" && Object.hasOwn(ERROR_CATALOG, code);
}

export function catalogDetails(code, operation = "operation") {
  const safeCode = isCatalogCode(code) ? code : operationErrorCode(operation);
  const [message, nextAction] = ERROR_CATALOG[safeCode];
  return Object.freeze({ code: safeCode, message, nextAction });
}

export function catalogText(code, operation = "operation") {
  const { message, nextAction } = catalogDetails(code, operation);
  return nextAction ? `${message} ${nextAction}` : message;
}

export class SafeBoundaryError extends Error {
  constructor(code, operation = "operation") {
    const details = catalogDetails(code, operation);
    super(details.message);
    this.name = "SafeBoundaryError";
    this.code = details.code;
    this.nextAction = details.nextAction;
  }
}

export function safeErrorDetails(error, operation = "operation") {
  const nativeStatus = typeof error?.message === "string"
    ? /status (12|13)\b/.exec(error.message)?.[1] : undefined;
  const code = error instanceof SafeBoundaryError && isCatalogCode(error.code)
    ? error.code : nativeStatus === "12" ? "WEAK_PASSWORD"
      : nativeStatus === "13" ? "PASSWORD_ALREADY_IN_USE"
      : INTERNAL_CODES[error?.code] ?? operationErrorCode(operation);
  return catalogDetails(code, operation);
}

export function boundaryError(error, operation) {
  return new SafeBoundaryError(safeErrorDetails(error, operation).code, operation);
}

export function encodeBoundaryError(error, operation) {
  return new Error(`${ENVELOPE_PREFIX}${JSON.stringify({ code: safeErrorDetails(error, operation).code })}`);
}

export function decodeBoundaryError(error, operation = "operation") {
  const raw = typeof error?.message === "string" ? error.message : "";
  const offset = raw.indexOf(ENVELOPE_PREFIX);
  if (offset >= 0) {
    try {
      const value = JSON.parse(raw.slice(offset + ENVELOPE_PREFIX.length));
      if (value && isCatalogCode(value.code)) return new SafeBoundaryError(value.code);
    } catch {}
  }
  return new SafeBoundaryError(operationErrorCode(operation));
}

export function safeRendererErrorMessage(error, operation = "operation") {
  return error instanceof SafeBoundaryError && isCatalogCode(error.code)
    ? catalogText(error.code) : catalogText(operationErrorCode(operation));
}

export function safeEventCode(error, operation = "operation") {
  if (typeof error === "string" && isCatalogCode(error)) return error;
  return safeErrorDetails(error, operation).code;
}

export function safeEventWarning(error, operation = "operation") {
  return catalogText(safeEventCode(error, operation));
}

export function createSafeIpc(ipc) {
  return Object.freeze({ handle(channel, handler) {
    ipc.handle(channel, async (...args) => {
      try { return await handler(...args); }
      catch (error) { throw encodeBoundaryError(error, channel); }
    });
  } });
}
