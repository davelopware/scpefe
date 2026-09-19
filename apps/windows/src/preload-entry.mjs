import { contextBridge, ipcRenderer } from "electron";
import { validateCreateRequest, validateCreationResult, validatePassword,
  validateProfile, validateOpenedDocument, validateEditMode, validateSaveResult,
  validatePlaintextExportRequest, validatePlaintextExportResult,
  canonicalizeDocumentText } from "./contracts.mjs";

contextBridge.exposeInMainWorld("scpefe", Object.freeze({
  getProfile: async () => {
    const value = await ipcRenderer.invoke("profile:get");
    return value === null ? null : validateProfile(value);
  },
  saveProfile: (profile) => ipcRenderer.invoke("profile:save", validateProfile(profile)),
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
  exportPlaintext: async (request) => {
    const value = await ipcRenderer.invoke(
      "document:export-plaintext", validatePlaintextExportRequest(request));
    return value === null ? null : validatePlaintextExportResult(value);
  },
}));
