import { contextBridge, ipcRenderer } from "electron";
import { validateCreateFormRequest, validateCreationResult,
  validateCreationTargetResult, validatePassword,
  validateOpenTargetResult,
  validateProfile, validateOpenedDocument, validateEditMode, validateSaveResult,
  validatePlaintextExportRequest, validatePlaintextExportResult, validateBackupResult,
  validateCompactionResult,
  validateMigrationResult,
  canonicalizeDocumentText, validateWorkingCopy, validateLockResult,
  validateClientSettings,
  validatePublicationResult, validateRecoveredWork, validateMergeDraft,
  validateUnresolvedJournalSummary, validateExternalOpenRequest } from "./contracts.mjs";

contextBridge.exposeInMainWorld("scpefe", Object.freeze({
  getProfile: async () => {
    const value = await ipcRenderer.invoke("profile:get");
    return value === null ? null : validateProfile(value);
  },
  saveProfile: (profile) => ipcRenderer.invoke("profile:save", validateProfile(profile)),
  getClientSettings: async () => validateClientSettings(
    await ipcRenderer.invoke("settings:get")),
  saveClientSettings: async (settings) => validateClientSettings(
    await ipcRenderer.invoke("settings:save", validateClientSettings(settings))),
  getUnresolvedJournalSummary: async () => validateUnresolvedJournalSummary(
    await ipcRenderer.invoke("journal:summary")),
  prepareReplacement: async () => (await ipcRenderer.invoke(
    "document:prepare-replacement")) === true,
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
  openDocument: async (password) => {
    const value = await ipcRenderer.invoke("document:open", validatePassword(password));
    return value === null ? null : validateOpenedDocument(value);
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
  closeDocument: () => ipcRenderer.invoke("document:close"),
  exitApplication: () => ipcRenderer.invoke("application:exit"),
  setWindowTitle: (title) => ipcRenderer.invoke("window:set-title", String(title)),
  openExternalDocument: async (request) => {
    const value = await ipcRenderer.invoke("document:open-external", {
      token: validateExternalOpenRequest(request).token,
      password: validatePassword(request?.password),
    });
    return value === null ? null : validateOpenedDocument(value);
  },
  enterEditMode: async () => validateEditMode(
    await ipcRenderer.invoke("document:enter-edit-mode")),
  saveDocument: async (content) => validateSaveResult(
    await ipcRenderer.invoke("document:save", canonicalizeDocumentText(content))),
  reconnectPendingPublication: async () => validatePublicationResult(
    await ipcRenderer.invoke("document:reconnect-publication")),
  beginDivergenceResolution: async () => validateMergeDraft(
    await ipcRenderer.invoke("document:begin-divergence-resolution")),
  saveDivergenceResolution: async (content) => validateSaveResult(
    await ipcRenderer.invoke("document:save-divergence-resolution",
      canonicalizeDocumentText(content))),
  discardPendingPublication: async () => validateOpenedDocument(
    await ipcRenderer.invoke("document:discard-publication")),
  backupDocument: async () => {
    const value = await ipcRenderer.invoke("document:backup");
    return value === null ? null : validateBackupResult(value);
  },
  compactDocument: async () => {
    const value = await ipcRenderer.invoke("document:compact");
    return value === null ? null : validateCompactionResult(value);
  },
  migrateDocument: async () => {
    const value = await ipcRenderer.invoke("document:migrate");
    return value === null ? null : validateMigrationResult(value);
  },
  createInvitation: (request) => ipcRenderer.invoke("document:create-invitation", request),
  claimInvitation: async (password) => validateOpenedDocument(
    await ipcRenderer.invoke("document:claim-invitation", validatePassword(password))),
  reconcileIdentity: async () => validateOpenedDocument(
    await ipcRenderer.invoke("document:reconcile-identity")),
  updateSlotPermissions: async (request) => validateOpenedDocument(
    await ipcRenderer.invoke("document:update-slot-permissions", request)),
  removeSlot: (slotId) => ipcRenderer.invoke("document:remove-slot", slotId),
  exportPlaintext: async (request) => {
    const value = await ipcRenderer.invoke(
      "document:export-plaintext", validatePlaintextExportRequest(request));
    return value === null ? null : validatePlaintextExportResult(value);
  },
  updateWorkingCopy: (working) => ipcRenderer.invoke(
    "document:update-working-copy", validateWorkingCopy(working)),
  activity: () => ipcRenderer.invoke("document:activity"),
  restoreRecoveredWork: async () => validateRecoveredWork(
    await ipcRenderer.invoke("document:restore-recovery")),
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
