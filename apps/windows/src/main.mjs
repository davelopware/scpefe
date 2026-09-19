import { app, BrowserWindow, dialog, ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DocumentService } from "./document-service.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const native = require(path.join(here, "..", "native", "scpefe_electron_native.node"));
let window;

app.whenReady().then(() => {
  const service = new DocumentService({
    native,
    fs,
    profilePath: path.join(app.getPath("userData"), "profile.json"),
  });
  ipcMain.handle("profile:get", () => service.loadProfile());
  ipcMain.handle("profile:save", (_event, profile) => service.saveProfile(profile));
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
    const chosen = await dialog.showOpenDialog(window, {
      title: "Open encrypted document",
      filters: [{ name: "SCPEFE document", extensions: ["scpefe"] }],
      properties: ["openFile"],
    });
    if (chosen.canceled || chosen.filePaths.length !== 1) return null;
    return service.openDocument(chosen.filePaths[0], password);
  });
  ipcMain.handle("document:enter-edit-mode", () => service.enterEditMode());
  ipcMain.handle("document:save", (_event, content) => service.saveDocument(content));
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
  window.loadFile(path.join(here, "..", "dist", "index.html"));
});

app.on("window-all-closed", () => app.quit());
