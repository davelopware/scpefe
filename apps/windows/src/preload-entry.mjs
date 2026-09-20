import { contextBridge, ipcRenderer } from "electron";
import { validateCreateRequest, validateCreationResult, validatePassword,
  validateProfile, validateOpenedDocument, validateEditMode, validateSaveResult,
  validatePlaintextExportRequest, validatePlaintextExportResult, validateBackupResult,
  canonicalizeDocumentText, validateWorkingCopy, validateLockResult,
  validateClientSettings,
  validatePublicationResult, validateRecoveredWork, validateMergeDraft } from "./contracts.mjs";

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
  createDocument: async (request) => {
    const value = await ipcRenderer.invoke(
      "document:create", validateCreateRequest(request));
    return value === null ? null : validateCreationResult(value);
  },
  openDocument: async (password) => {
    const value = await ipcRenderer.invoke("document:open", validatePassword(password));
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
  createInvitation: (request) => ipcRenderer.invoke("document:create-invitation", request),
  claimInvitation: async (password) => validateOpenedDocument(
    await ipcRenderer.invoke("document:claim-invitation", validatePassword(password))),
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
}));
