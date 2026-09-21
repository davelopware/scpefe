import { app, BrowserWindow, dialog, ipcMain, powerMonitor } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { applyCloseDecision, needsCloseDecision } from "./close-document.mjs";
import { registerCompactionHandler } from "./compaction-flow.mjs";
import { registerMigrationHandler } from "./migration-flow.mjs";
import { CreationTargetFlow } from "./creation-flow.mjs";
import { COMPACTION_CONFIRMATION, DISCARD_UNREADABLE_JOURNAL_CONFIRMATION,
  DocumentService } from "./document-service.mjs";
import { applySwitchDecision, finishDocumentSwitch,
  OpenRequestQueue } from "./switch-document.mjs";
import { openTargetFromAdditionalData,
  openTargetFromCommandLine, openTargetFromUrl, acknowledgementCredentials,
  acknowledgementTargetHash, createAcknowledgement, validateAcknowledgement,
  OrderedOpenRequests } from "./single-instance.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const native = require(path.join(here, "..", "native", "scpefe_electron_native.node"));
let window;
let service;
const openRequests = new OpenRequestQueue();
const externalRequests = new OrderedOpenRequests({ randomToken: randomUUID });
let externalDrainRunning = false;
let externalOpenInProgress = false;
const smokeDirectory = process.env.SCPEFE_SINGLE_INSTANCE_SMOKE_DIR || null;
const initialOpenTarget = openTargetFromCommandLine(process.argv);
const instanceAcknowledgement = Object.freeze({ id: randomUUID(), secret: randomUUID() });
const instanceAcknowledgementPath = path.join(app.getPath("temp"),
  `scpefe-open-${instanceAcknowledgement.id}.ack`);
const hasInstanceLock = app.requestSingleInstanceLock(
  { ...(initialOpenTarget ? { openTarget: initialOpenTarget } : {}),
    acknowledgementId: instanceAcknowledgement.id,
    acknowledgementSecret: instanceAcknowledgement.secret });

async function sendJournalSummary() {
  if (!service || !window || window.isDestroyed()) return;
  try {
    window.webContents.send("journal:summary",
      await service.unresolvedJournalSummary());
  } catch (error) {
    window.webContents.send("document:journal-warning",
      `Unresolved journals could not be inspected: ${error.message}`);
  }
}

async function smokeLog(event, details = {}) {
  if (!smokeDirectory) return;
  await fs.mkdir(smokeDirectory, { recursive: true });
  await fs.appendFile(path.join(smokeDirectory, "events.jsonl"),
    `${JSON.stringify({ event, pid: process.pid, ...details })}\n`);
}

function acknowledgementPath(id) {
  return path.join(app.getPath("temp"), `scpefe-open-${id}.ack`);
}

async function acknowledgeRequest(request, status, sequence) {
  if (!request.ack) return;
  const acknowledgement = createAcknowledgement(request.ack, {
    requestToken: request.token,
    targetHash: acknowledgementTargetHash(request.target), sequence, status,
  });
  await fs.writeFile(acknowledgementPath(request.ack.id),
    JSON.stringify(acknowledgement), { mode: 0o600 }).catch(() => {});
}

async function prepareDocumentSwitch(finish = true) {
  if (!service.active) return true;
  let decision = "save";
  if (needsCloseDecision(service.active)) {
    const conflict = service.active.pendingRecord?.state === "conflict";
    const pending = service.active.pendingPublication;
    const choice = await dialog.showMessageBox(window, {
      type: "warning",
      title: "Open another document?",
      message: conflict ? "This document has an unresolved divergence."
        : pending ? "This document has a save pending publication."
          : service.active.manuallySealed
            ? "This document has unsaved changes."
            : "This document is only provisionally saved.",
      detail: "Save and open preserves the current work, discard and open is destructive, and cancel keeps this document open.",
      buttons: ["Cancel", "Save and open", "Discard and open"],
      defaultId: 0, cancelId: 0, noLink: true,
    });
    decision = ["cancel", "save", "discard"][choice.response];
  }
  let outcome;
  try {
    outcome = await applySwitchDecision(service, decision);
  } catch (error) {
    if (error?.code !== "DOCUMENT_SWITCH_UNREADABLE_JOURNAL") throw error;
    const confirmation = await dialog.showMessageBox(window, {
      type: "warning", title: "Permanently discard unreadable recovery work?",
      message: "The recovery journal for this authenticated document cannot be read.",
      detail: "Only this document's encrypted journal will be deleted. This cannot be undone.",
      buttons: ["Cancel", "Permanently discard journal and open"],
      defaultId: 0, cancelId: 0, noLink: true,
    });
    if (confirmation.response !== 1) return false;
    await service.discardUnreadableJournalForSwitch(
      DISCARD_UNREADABLE_JOURNAL_CONFIRMATION);
    outcome = await applySwitchDecision(service, "discard");
  }
  if (!outcome.proceed) return false;
  if (outcome.pendingPublication) {
    const disclosure = await dialog.showMessageBox(window, {
      type: "warning",
      title: "Save is still pending publication",
      message: "The manual save is stored locally but has not reached its target.",
      detail: "It will remain discoverable after switching and after restart.",
      buttons: ["Keep current document open", "Open with save pending"],
      defaultId: 0, cancelId: 0, noLink: true,
    });
    if (disclosure.response !== 1) {
      window.webContents.send("document:switch-retained", service.active.opened);
      await sendJournalSummary();
      return false;
    }
  }
  if (finish) await finishDocumentSwitch(service);
  await sendJournalSummary();
  return true;
}

async function drainExternalRequests() {
  if (externalDrainRunning || !service || !window || window.isDestroyed()) return;
  const request = externalRequests.take();
  if (!request) return;
  externalDrainRunning = true;
  window.show();
  if (window.isMinimized()) window.restore();
  window.focus();
  await smokeLog("presented", { requestToken: request.token,
    target: request.target ? path.basename(request.target) : null,
    source: request.source });
  if (!request.target) {
    await acknowledgeRequest(request, "focused", 3);
    externalRequests.complete(request.token);
    externalDrainRunning = false;
    return drainExternalRequests();
  }
  const smokeCompleteAfterMs = Number(
    process.env.SCPEFE_SINGLE_INSTANCE_SMOKE_COMPLETE_MS || 400);
  window.webContents.send("document:external-open-requested", {
    token: request.token,
    ...(smokeDirectory ? { smokeCompleteAfterMs } : {}),
  });
  await acknowledgeRequest(request, "presented", 2);
  externalDrainRunning = false;
}

function routeSecondInstance(commandLine, workingDirectory, additionalData) {
  const acknowledgement = acknowledgementCredentials(additionalData);
  if (process.env.SCPEFE_SINGLE_INSTANCE_SMOKE_STALL === "1") {
    void smokeLog("request-intentionally-unacknowledged",
      { hasToken: Boolean(acknowledgement) });
    return;
  }
  const target = openTargetFromAdditionalData(additionalData)
    ?? openTargetFromCommandLine(commandLine, workingDirectory);
  const request = externalRequests.enqueue({ target, acknowledgement,
    source: "second-instance" });
  void acknowledgeRequest(request, "queued", 1).then(() => smokeLog("queued", {
    requestToken: request.token, target: target ? path.basename(target) : null,
    source: "second-instance" })).then(drainExternalRequests).catch((error) => {
    window?.webContents.send("document:journal-warning",
      `Could not handle the open request: ${error.message}`);
  });
}

if (!hasInstanceLock) {
  // The existing instance remains authoritative; never kill or bypass it.
  void (async () => {
    const deadline = Date.now() + 3000;
    const expectedTargetHash = acknowledgementTargetHash(initialOpenTarget);
    let acknowledgement = null;
    while (Date.now() < deadline) {
      try {
        const result = JSON.parse(await fs.readFile(instanceAcknowledgementPath, "utf8"));
        const valid = validateAcknowledgement(instanceAcknowledgement, result,
          expectedTargetHash);
        if (valid) {
          acknowledgement = valid;
          break;
        }
      }
      catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!acknowledgement) {
      await smokeLog("handoff-timeout", { existingInstancePreserved: true });
      if (!smokeDirectory) {
        await app.whenReady();
        await dialog.showMessageBox({
          type: "warning", title: "SCPEFE is already running",
          message: "The existing SCPEFE instance did not respond.",
          detail: "It was not killed or bypassed because it may hold unsaved encrypted work. Use Windows Task Manager to end it manually only after considering that risk, then try again.",
          buttons: ["Close"], defaultId: 0, noLink: true,
        });
      }
    } else if (!["focused", "opened", "canceled"].includes(acknowledgement.status)) {
      const outcomeDeadline = Date.now()
        + (smokeDirectory ? 20_000 : 300_000);
      let lastSequence = acknowledgement.sequence;
      while (Date.now() < outcomeDeadline) {
        try {
          const result = JSON.parse(
            await fs.readFile(instanceAcknowledgementPath, "utf8"));
          const valid = validateAcknowledgement(instanceAcknowledgement, result,
            expectedTargetHash);
          if (valid?.requestToken === acknowledgement.requestToken
              && valid.sequence >= lastSequence) {
            acknowledgement = valid;
            lastSequence = valid.sequence;
          }
          if (["focused", "opened", "canceled"].includes(acknowledgement.status)) {
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await smokeLog("handoff-acknowledged", { status: acknowledgement.status,
        sequence: acknowledgement.sequence });
    } else {
      await smokeLog("handoff-acknowledged", { status: acknowledgement.status,
        sequence: acknowledgement.sequence });
    }
    await fs.unlink(instanceAcknowledgementPath).catch(() => {});
    app.quit();
  })();
} else app.on("second-instance",
  (_event, commandLine, workingDirectory, additionalData) =>
    routeSecondInstance(commandLine, workingDirectory, additionalData));

if (hasInstanceLock) {
  if (initialOpenTarget) {
    externalRequests.enqueue({ target: initialOpenTarget, source: "command-line" });
    void smokeLog("queued", { target: path.basename(initialOpenTarget),
      source: "command-line" });
  }
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    const target = openTargetFromCommandLine(["SCPEFE", filePath]);
    if (target) externalRequests.enqueue({ target, source: "open-file" });
    void drainExternalRequests();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    const target = openTargetFromUrl(url);
    if (target) externalRequests.enqueue({ target, source: "open-url" });
    void drainExternalRequests();
  });
}

if (hasInstanceLock) app.whenReady().then(async () => {
  service = new DocumentService({
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
    onLocked: (result) => {
      window?.webContents.send("document:locked", result);
      void sendJournalSummary();
    },
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
  ipcMain.handle("journal:summary", () => service.unresolvedJournalSummary());
  const creationFlow = new CreationTargetFlow();
  let selectedOpenTarget = null;
  let lockedTarget = null;
  let replacementPrepared = false;
  const lockActive = (reason) => {
    if (service.active?.target) lockedTarget = service.active.target;
    return service.lock(reason);
  };
  ipcMain.handle("document:prepare-replacement", async () => {
    replacementPrepared = await prepareDocumentSwitch(false);
    return replacementPrepared;
  });
  ipcMain.handle("document:choose-create-target", async () =>
    creationFlow.chooseTarget(async () => {
      const chosen = await dialog.showSaveDialog(window, {
        title: "Create encrypted document",
        filters: [{ name: "SCPEFE document", extensions: ["scpefe"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      return chosen.canceled || !chosen.filePath ? null : chosen.filePath;
    }));
  ipcMain.handle("document:cancel-create-target", () => {
    replacementPrepared = false;
    return creationFlow.cancel();
  });
  ipcMain.handle("document:create", (_event, request) => creationFlow.create(request,
    async (target, validated) => {
      await service.createDocument(target, validated);
      if (!replacementPrepared && !await prepareDocumentSwitch(false)) {
        throw new Error("The current document remains open");
      }
      await finishDocumentSwitch(service);
      replacementPrepared = false;
      await service.openDocument(target, validated.ownerPassword);
      const editable = await service.enterEditMode();
      lockedTarget = target;
      return { created: true, opened: editable, name: path.basename(target) };
    }));
  ipcMain.handle("document:open", async (_event, password) => {
    const chosen = await dialog.showOpenDialog(window, {
      title: "Open encrypted document",
      filters: [{ name: "SCPEFE document", extensions: ["scpefe"] }],
      properties: ["openFile"],
    });
    if (chosen.canceled || chosen.filePaths.length !== 1) return null;
    return openRequests.run(async () => {
      if (!await prepareDocumentSwitch()) return null;
      const opened = await service.openDocument(chosen.filePaths[0], password);
      await sendJournalSummary();
      return opened;
    });
  });
  ipcMain.handle("document:choose-open-target", async () => {
    const chosen = await dialog.showOpenDialog(window, {
      title: "Open encrypted document",
      filters: [{ name: "SCPEFE document", extensions: ["scpefe"] }],
      properties: ["openFile"],
    });
    selectedOpenTarget = chosen.canceled || chosen.filePaths.length !== 1
      ? null : chosen.filePaths[0];
    return selectedOpenTarget
      ? Object.freeze({ selected: true, name: path.basename(selectedOpenTarget) }) : null;
  });
  ipcMain.handle("document:cancel-open-target", () => {
    selectedOpenTarget = null;
    replacementPrepared = false;
  });
  ipcMain.handle("document:open-selected", async (_event, password) => {
    if (!selectedOpenTarget) throw new Error("Choose a document first");
    const target = selectedOpenTarget;
    const opened = await openRequests.run(async () => {
      const inspected = native.openDocument(await fs.readFile(target), password);
      inspected?.journalKey?.fill?.(0);
      if (!replacementPrepared && !await prepareDocumentSwitch(false)) return null;
      await finishDocumentSwitch(service);
      replacementPrepared = false;
      return service.openDocument(target, password);
    });
    if (!opened) throw new Error("The current document remains open");
    selectedOpenTarget = null;
    lockedTarget = target;
    await sendJournalSummary();
    return opened;
  });
  ipcMain.handle("document:unlock", async (_event, password) => {
    if (!lockedTarget) throw new Error("No locked document is available");
    return service.openDocument(lockedTarget, password);
  });
  ipcMain.handle("document:open-external", async (_event, request) => {
    if (!request || typeof request !== "object"
        || typeof request.token !== "string" || typeof request.password !== "string"
        || !externalRequests.current(request.token) || externalOpenInProgress) {
      throw new TypeError("invalid external open request");
    }
    const pending = externalRequests.current(request.token);
    externalOpenInProgress = true;
    try {
      if (smokeDirectory) {
        await acknowledgeRequest(pending, "canceled", 3);
        externalRequests.complete(pending.token);
        await smokeLog("completed", { requestToken: pending.token,
          target: path.basename(pending.target), outcome: "renderer-canceled" });
        void drainExternalRequests();
        return null;
      }
      const opened = await openRequests.run(async () => {
        if (!await prepareDocumentSwitch()) return null;
        return service.openDocument(pending.target, request.password);
      });
      await acknowledgeRequest(pending, opened ? "opened" : "canceled", 3);
      externalRequests.complete(pending.token);
      await smokeLog("completed", { requestToken: pending.token,
        target: path.basename(pending.target), outcome: opened ? "opened" : "canceled" });
      await sendJournalSummary();
      void drainExternalRequests();
      return opened;
    } finally {
      externalOpenInProgress = false;
    }
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
  registerCompactionHandler({ ipcMain, service, dialog, window,
    confirmation: COMPACTION_CONFIRMATION });
  registerMigrationHandler({ ipcMain, service, dialog, window });
  ipcMain.handle("document:create-invitation", (_event, request) =>
    service.createInvitation(request));
  ipcMain.handle("document:claim-invitation", (_event, password) =>
    service.claimInvitation(password));
  ipcMain.handle("document:reconcile-identity", () => service.reconcileIdentity());
  ipcMain.handle("document:update-slot-permissions", (_event, request) =>
    service.updateSlotPermissions(request));
  ipcMain.handle("document:remove-slot", (_event, slotId) =>
    service.removeSlot(slotId));
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
  ipcMain.handle("document:lock", () => {
    return lockActive("app-lock");
  });
  ipcMain.handle("document:close", async () => {
    if (!service.active) return true;
    if (needsCloseDecision(service.active)) {
      const choice = await dialog.showMessageBox(window, {
        type: "warning", title: "Close document?",
        message: "This document has work that requires a decision.",
        detail: "Manual save preserves the work. Discard restores the last manually saved content.",
        buttons: ["Cancel", "Manual save and close", "Discard and close"],
        defaultId: 0, cancelId: 0, noLink: true,
      });
      if (!await applyCloseDecision(service,
        ["cancel", "save", "discard"][choice.response])) return false;
    }
    if (service.active?.target) lockedTarget = service.active.target;
    await lockActive("document-close");
    lockedTarget = null;
    return true;
  });
  ipcMain.handle("application:exit", () => { window.close(); return true; });
  ipcMain.handle("window:set-title", (_event, title) => {
    const safe = typeof title === "string" && title.length <= 260
      && !title.includes("/") && !title.includes("\\") ? title : "SCPEFE";
    window.setTitle(safe);
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
  let closingAfterRelease = false;
  let closeOperation = null;
  window.on("close", (event) => {
    if (closingAfterRelease) return;
    const active = service.active;
    const regularSavePending = active?.pendingRecord?.publication?.purpose
      === "regular-save";
    const needsUnsavedDecision = needsCloseDecision(active);
    if (!active || (!active.editMode && !needsUnsavedDecision)) return;
    event.preventDefault();
    if (closeOperation) return;
    closeOperation = (async () => {
      if (needsUnsavedDecision) {
        const choice = await dialog.showMessageBox(window, {
          type: "warning", title: "Unsaved changes",
          message: service.active.manuallySealed && !regularSavePending
            ? "This document has unsaved changes."
            : "This document is only provisionally saved.",
          detail: "Manual save seals the changes. Discard restores the last manually saved content.",
          buttons: ["Cancel", "Manual save and exit", "Discard and exit"],
          defaultId: 0, cancelId: 0, noLink: true,
        });
        const proceed = await applyCloseDecision(service,
          ["cancel", "save", "discard"][choice.response]);
        if (!proceed) return;
      }
      if (service.active?.editMode) {
        try { await service.exitEditMode(); }
        catch { await lockActive("app-exit"); }
      }
      closingAfterRelease = true;
      window.close();
    })().catch((error) => {
      window?.webContents.send("document:journal-warning",
        `Could not finish exit: ${error.message}`);
    }).finally(() => { closeOperation = null; });
  });
  powerMonitor.on("lock-screen", () => { void lockActive("screen-lock"); });
  window.on("blur", () => { void lockActive("background"); });
  window.on("minimize", () => { void lockActive("background"); });
  window.loadFile(path.join(here, "..", "dist", "index.html"));
  window.webContents.on("did-finish-load", () => {
    void sendJournalSummary();
    const delay = Number(process.env.SCPEFE_SINGLE_INSTANCE_SMOKE_READY_DELAY_MS || 0);
    setTimeout(() => {
      externalRequests.setReady();
      void smokeLog("renderer-ready").then(drainExternalRequests);
    }, delay);
  });
});

app.on("window-all-closed", () => app.quit());
