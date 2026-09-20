import { app, BrowserWindow, dialog, ipcMain, powerMonitor } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DocumentService } from "./document-service.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const native = require(path.join(here, "..", "native", "scpefe_electron_native.node"));
let window;

app.whenReady().then(async () => {
  const service = new DocumentService({
    native,
    fs,
    profilePath: path.join(app.getPath("userData"), "profile.json"),
    settingsPath: path.join(app.getPath("userData"), "settings.json"),
    journalDirectory: path.join(app.getPath("userData"), "work-journals"),
    publicationCapabilities: {
      sameFilesystemTransaction: true,
      replacementGuarantee: "best-effort-replace",
    },
    witnessDirectory: path.join(app.getPath("userData"), "head-witnesses"),
    onLocked: (result) => window?.webContents.send("document:locked", result),
    onJournalWarning: (warning) =>
      window?.webContents.send("document:journal-warning", warning),
    onRegularSave: (result) =>
      window?.webContents.send("document:regular-saved", result),
  });
  await service.loadClientSettings();
  ipcMain.handle("profile:get", () => service.loadProfile());
  ipcMain.handle("profile:save", (_event, profile) => service.saveProfile(profile));
  ipcMain.handle("settings:get", () => service.loadClientSettings());
  ipcMain.handle("settings:save", (_event, settings) =>
    service.saveClientSettings(settings));
  ipcMain.handle("document:create", async (_event, request) => {
    const chosen = await dialog.showSaveDialog(window, {
      title: "Create encrypted document",
      filters: [{ name: "SCPEFE document", extensions: ["scpefe"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (chosen.canceled || !chosen.filePath) return null;
    return service.createDocument(chosen.filePath, request);
  });
  ipcMain.handle("document:open", async (_event, password) => {
    await service.lock("open-another");
    const chosen = await dialog.showOpenDialog(window, {
      title: "Open encrypted document",
      filters: [{ name: "SCPEFE document", extensions: ["scpefe"] }],
      properties: ["openFile"],
    });
    if (chosen.canceled || chosen.filePaths.length !== 1) return null;
    return service.openDocument(chosen.filePaths[0], password);
  });
  ipcMain.handle("document:enter-edit-mode", async () => {
    try {
      return await service.enterEditMode();
    } catch (error) {
      if (error?.code !== "LEASE_CLOCK_UNCERTAIN") throw error;
      const confirmation = await dialog.showMessageBox(window, {
        type: "warning", title: "Force editing-lease takeover?",
        message: "The current lease cannot be proved expired because the clocks disagree.",
        detail: "Force takeover only after confirming the named holder is no longer editing.",
        buttons: ["Cancel", "Force takeover"], defaultId: 0, cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) throw error;
      return service.enterEditMode({ forceTakeover: true });
    }
  });
  ipcMain.handle("document:save", (_event, content) => service.saveDocument(content));
  ipcMain.handle("document:reconnect-publication", () =>
    service.reconnectPendingPublication());
  ipcMain.handle("document:begin-divergence-resolution", () =>
    service.beginDivergenceResolution());
  ipcMain.handle("document:save-divergence-resolution", (_event, content) =>
    service.saveDivergenceResolution(content));
  ipcMain.handle("document:discard-publication", () =>
    service.discardPendingPublication());
  ipcMain.handle("document:backup", async () => {
    const chosen = await dialog.showSaveDialog(window, {
      title: "Create verified backup replica",
      defaultPath: service.suggestedBackupTarget(),
      filters: [{ name: "SCPEFE document", extensions: ["scpefe"] }],
      properties: ["createDirectory"],
    });
    if (chosen.canceled || !chosen.filePath) return null;
    return service.backupDocument(chosen.filePath);
  });
  ipcMain.handle("document:create-invitation", (_event, request) =>
    service.createInvitation(request));
  ipcMain.handle("document:claim-invitation", (_event, password) =>
    service.claimInvitation(password));
  ipcMain.handle("document:export-plaintext", async (_event, request) => {
    const warning = await dialog.showMessageBox(window, {
      type: "warning",
      title: "Export unprotected plaintext?",
      message: "The exported copy will not be password protected.",
      detail: "It contains only the current text, but may persist in backups or storage history.",
      buttons: ["Cancel", "Export plaintext…"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (warning.response !== 1) return null;
    const chosen = await dialog.showSaveDialog(window, {
      title: "Export unprotected plaintext",
      filters: [{ name: "Plain text", extensions: ["txt"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (chosen.canceled || !chosen.filePath) return null;
    return service.exportPlaintext(chosen.filePath, request);
  });
  ipcMain.handle("document:update-working-copy", (_event, working) =>
    service.updateWorkingCopy(working));
  ipcMain.handle("document:activity", () => service.notifyActivity());
  ipcMain.handle("document:restore-recovery", () => service.restoreRecoveredWork());
  ipcMain.handle("document:discard-recovery", () => service.discardRecoveredWork());
  ipcMain.handle("document:accept-head-mismatch", () => service.acceptHeadMismatch());
  ipcMain.handle("document:lock", () => service.lock("app-lock"));
  window = new BrowserWindow({
    width: 920,
    height: 700,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(here, "..", "dist", "preload.cjs"),
    },
  });
  let closingAfterRelease = false;
  let closeOperation = null;
  window.on("close", (event) => {
    if (closingAfterRelease || !service.active?.editMode) return;
    event.preventDefault();
    if (closeOperation) return;
    closeOperation = (async () => {
      if (service.active?.dirty) {
        const choice = await dialog.showMessageBox(window, {
          type: "warning", title: "Unsaved changes",
          message: service.active.manuallySealed
            ? "This document has unsaved changes."
            : "This document is only provisionally saved.",
          detail: "Manual save seals the changes. Discard restores the last manually saved content.",
          buttons: ["Cancel", "Manual save and exit", "Discard and exit"],
          defaultId: 0, cancelId: 0, noLink: true,
        });
        if (choice.response === 0) return;
        if (choice.response === 1) {
          await service.saveDocument(service.active.working.content);
        } else {
          await service.discardWorkingCopy();
        }
      }
      if (service.active?.editMode) {
        try { await service.exitEditMode(); }
        catch { await service.lock("app-exit"); }
      }
      closingAfterRelease = true;
      window.close();
    })().catch((error) => {
      window?.webContents.send("document:journal-warning",
        `Could not finish exit: ${error.message}`);
    }).finally(() => { closeOperation = null; });
  });
  powerMonitor.on("lock-screen", () => { void service.lock("screen-lock"); });
  window.on("blur", () => { void service.lock("background"); });
  window.on("minimize", () => { void service.lock("background"); });
  window.loadFile(path.join(here, "..", "dist", "index.html"));
});

app.on("window-all-closed", () => app.quit());
