import { contextBridge, ipcRenderer } from "electron";
import { validateCreateFormRequest, validateCreationResult,
  validateCreationTargetResult, validatePassword,
  validateOpenTargetResult,
  validateProfile, validateOpenedDocument, validateEditMode, validateSaveResult,
  validatePlaintextExportRequest, validatePlaintextExportResult, validateBackupResult,
  validateCompactionResult,
  validateMigrationResult,
  validateLeaseDecisionResult, validateTakeoverRequest, validateTakeoverCancellation,
  validateCompactionRequest,
  canonicalizeDocumentText, validateWorkingCopy, validateLockResult,
  validateClientSettings,
  validatePublicationResult, validateRecoveredWork, validateMergeDraft,
  validateUnresolvedJournalSummary, validateExternalOpenRequest,
  validatePasswordChangeRequest, validateInvitationCreateRequest,
  validateInvitationResult, validateInvitationClaimRequest,
  validateSlotPermissionsRequest,
  validateSlotId } from "./contracts.mjs";

contextBridge.exposeInMainWorld("scpefe", Object.freeze({
  getProfile: async () => {
    const value = await ipcRenderer.invoke("profile:get");
    return value === null ? null : validateProfile(value);
  },
  saveProfile: (profile) => ipcRenderer.invoke("profile:save", validateProfile(profile)),
  reconcileProfile: async () => {
    const value = await ipcRenderer.invoke("profile:reconcile-active");
    return value === null ? null : validateOpenedDocument(value);
  },
  getClientSettings: async () => validateClientSettings(
    await ipcRenderer.invoke("settings:get")),
  saveClientSettings: async (settings) => validateClientSettings(
    await ipcRenderer.invoke("settings:save", validateClientSettings(settings))),
  getUnresolvedJournalSummary: async () => validateUnresolvedJournalSummary(
    await ipcRenderer.invoke("journal:summary")),
  chooseCreateTarget: async () => {
    const value = await ipcRenderer.invoke("document:choose-create-target");
    return value === null ? null : validateCreationTargetResult(value);
  },
  cancelCreateTarget: () => ipcRenderer.invoke("document:cancel-create-target"),
  createDocument: async (request) => {
    const value = await ipcRenderer.invoke(
      "document:create", validateCreateFormRequest(request));
    return value === null ? null : validateCreationResult(value);
  },
  chooseOpenTarget: async () => {
    const value = await ipcRenderer.invoke("document:choose-open-target");
    return value === null ? null : validateOpenTargetResult(value);
  },
  cancelOpenTarget: () => ipcRenderer.invoke("document:cancel-open-target"),
  openSelectedDocument: async (password) => validateOpenedDocument(
    await ipcRenderer.invoke("document:open-selected", validatePassword(password))),
  unlockDocument: async (password) => validateOpenedDocument(
    await ipcRenderer.invoke("document:unlock", validatePassword(password))),
  openExternalDocument: async (request) => {
    const value = await ipcRenderer.invoke("document:open-external", {
      token: validateExternalOpenRequest(request).token,
      password: validatePassword(request?.password),
    });
    return value === null ? null : validateOpenedDocument(value);
  },
  enterEditMode: async (request = {}) => {
    const value = await ipcRenderer.invoke("document:enter-edit-mode",
      validateTakeoverRequest(request));
    return value?.decisionRequired === "lease-takeover"
      ? validateLeaseDecisionResult(value) : validateEditMode(value);
  },
  saveDocument: async (content) => validateSaveResult(
    await ipcRenderer.invoke("document:save", canonicalizeDocumentText(content))),
  reconnectPendingPublication: async () => validatePublicationResult(
    await ipcRenderer.invoke("document:reconnect-publication")),
  beginDivergenceResolution: async (request = {}) => {
    const value = await ipcRenderer.invoke("document:begin-divergence-resolution",
      validateTakeoverRequest(request));
    return value?.decisionRequired === "lease-takeover"
      ? validateLeaseDecisionResult(value) : validateMergeDraft(value);
  },
  saveDivergenceResolution: async (content) => validateSaveResult(
    await ipcRenderer.invoke("document:save-divergence-resolution",
      canonicalizeDocumentText(content))),
  discardPendingPublication: async () => validateOpenedDocument(
    await ipcRenderer.invoke("document:discard-publication")),
  backupDocument: async () => {
    const value = await ipcRenderer.invoke("document:backup");
    return value === null ? null : validateBackupResult(value);
  },
  compactDocument: async (request) => {
    const value = await ipcRenderer.invoke("document:compact",
      validateCompactionRequest(request));
    return value === null ? null : validateCompactionResult(value);
  },
  migrateDocument: async (request = {}) => {
    const value = await ipcRenderer.invoke("document:migrate",
      validateTakeoverRequest(request));
    return value === null ? null : value?.decisionRequired === "lease-takeover"
      ? validateLeaseDecisionResult(value) : validateMigrationResult(value);
  },
  changePassword: async (request) => validateOpenedDocument(
    await ipcRenderer.invoke("document:change-password",
      validatePasswordChangeRequest(request))),
  createInvitation: async (request) => validateInvitationResult(
    await ipcRenderer.invoke("document:create-invitation",
      validateInvitationCreateRequest(request))),
  copyInvitationPassphrase: async (password) => {
    const value = await ipcRenderer.invoke("document:copy-invitation-passphrase",
      validatePassword(password));
    if (value !== true) throw new TypeError("host did not copy the invitation passphrase");
    return true;
  },
  claimInvitation: async (request) => {
    const validated = validateInvitationClaimRequest(request);
    return validateOpenedDocument(await ipcRenderer.invoke(
      "document:claim-invitation", validated.newPassword));
  },
  cancelInvitationClaim: async () => {
    const value = await ipcRenderer.invoke("document:cancel-invitation-claim");
    if (typeof value !== "boolean") throw new TypeError("host returned invalid claim cancellation");
    return value;
  },
  reconcileIdentity: async () => validateOpenedDocument(
    await ipcRenderer.invoke("document:reconcile-identity")),
  updateSlotPermissions: async (request) => validateOpenedDocument(
    await ipcRenderer.invoke("document:update-slot-permissions",
      validateSlotPermissionsRequest(request))),
  removeSlot: (slotId) => ipcRenderer.invoke("document:remove-slot",
    validateSlotId(slotId)),
  exportPlaintext: async (request) => {
    const value = await ipcRenderer.invoke(
      "document:export-plaintext", validatePlaintextExportRequest(request));
    return value === null ? null : validatePlaintextExportResult(value);
  },
  updateWorkingCopy: (working) => ipcRenderer.invoke(
    "document:update-working-copy", validateWorkingCopy(working)),
  activity: () => ipcRenderer.invoke("document:activity"),
  restoreRecoveredWork: async (request = {}) => {
    const value = await ipcRenderer.invoke("document:restore-recovery",
      validateTakeoverRequest(request));
    return value?.decisionRequired === "lease-takeover"
      ? validateLeaseDecisionResult(value) : validateRecoveredWork(value);
  },
  cancelLeaseTakeover: async (authorization) => {
    const value = await ipcRenderer.invoke("document:cancel-lease-takeover",
      validateTakeoverCancellation(authorization));
    if (typeof value !== "boolean") {
      throw new TypeError("host returned invalid lease takeover cancellation");
    }
    return value;
  },
  discardRecoveredWork: async () => validateOpenedDocument(
    await ipcRenderer.invoke("document:discard-recovery")),
  acceptHeadMismatch: async () => validateOpenedDocument(
    await ipcRenderer.invoke("document:accept-head-mismatch")),
  lock: async () => validateLockResult(await ipcRenderer.invoke("document:lock")),
  onLocked: (listener) => {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const handler = (_event, value) => listener(validateLockResult(value));
    ipcRenderer.on("document:locked", handler);
    return () => ipcRenderer.removeListener("document:locked", handler);
  },
  onJournalWarning: (listener) => {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const handler = (_event, value) => {
      if (typeof value === "string") listener(value);
    };
    ipcRenderer.on("document:journal-warning", handler);
    return () => ipcRenderer.removeListener("document:journal-warning", handler);
  },
  onRegularSave: (listener) => {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const handler = (_event, value) => {
      if (value?.published === true && value?.provisional === true
          && typeof value.content === "string") listener(Object.freeze({ ...value }));
    };
    ipcRenderer.on("document:regular-saved", handler);
    return () => ipcRenderer.removeListener("document:regular-saved", handler);
  },
  onExternalOpenRequested: (listener) => {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const handler = (_event, value) => {
      const request = validateExternalOpenRequest(value);
      listener(request);
      if (request.smokeCompleteAfterMs !== undefined) {
        setTimeout(() => {
          void ipcRenderer.invoke("document:open-external", {
            token: request.token, password: "single-instance-smoke",
          });
        }, request.smokeCompleteAfterMs);
      }
    };
    ipcRenderer.on("document:external-open-requested", handler);
    return () => ipcRenderer.removeListener("document:external-open-requested", handler);
  },
  onUnresolvedJournalSummary: (listener) => {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const handler = (_event, value) => listener(validateUnresolvedJournalSummary(value));
    ipcRenderer.on("journal:summary", handler);
    return () => ipcRenderer.removeListener("journal:summary", handler);
  },
  onSwitchRetained: (listener) => {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const handler = (_event, value) => listener(validateOpenedDocument(value));
    ipcRenderer.on("document:switch-retained", handler);
    return () => ipcRenderer.removeListener("document:switch-retained", handler);
  },
}));
