import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, powerMonitor } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { registerCompactionHandler } from "./compaction-flow.mjs";
import { DocumentLifecycleHost } from "./document-lifecycle-host.mjs";
import { COMPACTION_CONFIRMATION, DocumentService } from "./document-service.mjs";
import { registerMigrationHandler } from "./migration-flow.mjs";
import { createSafeIpc } from "./error-boundary.mjs";
import { registerWindowFocusProtection } from "./window-focus-protection.mjs";
import { acknowledgementCredentials, acknowledgementTargetHash,
  createAcknowledgement, openTargetFromAdditionalData, openTargetFromCommandLine,
  openTargetFromUrl, validateAcknowledgement } from "./single-instance.mjs";
import { validateInvitationCreateRequest, validatePassword,
  validatePasswordChangeRequest, validatePlaintextExportRequest,
  validateSlotId, validateSlotPermissionsRequest } from "./contracts.mjs";

Menu.setApplicationMenu(null);

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const native = require(path.join(here, "..", "native", "scpefe_electron_native.node"));
const smokeDirectory = process.env.SCPEFE_SINGLE_INSTANCE_SMOKE_DIR || null;
const initialOpenTarget = openTargetFromCommandLine(process.argv);
const instanceAcknowledgement = Object.freeze({ id: randomUUID(), secret: randomUUID() });
const instanceAcknowledgementPath = path.join(app.getPath("temp"),
  `scpefe-open-${instanceAcknowledgement.id}.ack`);
const pendingExternalRequests = [];
let window = null;
let lifecycleHost = null;
const safeIpcMain = createSafeIpc(ipcMain);

const hasInstanceLock = app.requestSingleInstanceLock(
  { ...(initialOpenTarget ? { openTarget: initialOpenTarget } : {}),
    acknowledgementId: instanceAcknowledgement.id,
    acknowledgementSecret: instanceAcknowledgement.secret });

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
    requestToken: request.token, targetHash: acknowledgementTargetHash(request.target),
    sequence, status,
  });
  await fs.writeFile(acknowledgementPath(request.ack.id),
    JSON.stringify(acknowledgement), { mode: 0o600 });
}

function queueExternal(value) {
  if (lifecycleHost) return lifecycleHost.enqueueExternal(value);
  pendingExternalRequests.push(value); return null;
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
  queueExternal({ target, acknowledgement, source: "second-instance" });
}

if (!hasInstanceLock) {
  // The existing instance remains authoritative; never kill or bypass it.
  void (async () => {
    const deadline = Date.now() + 3000;
    const expectedTargetHash = acknowledgementTargetHash(initialOpenTarget);
    let acknowledgement = null;
    while (Date.now() < deadline) {
      try {
        const value = JSON.parse(await fs.readFile(instanceAcknowledgementPath, "utf8"));
        const valid = validateAcknowledgement(instanceAcknowledgement, value, expectedTargetHash);
        if (valid) { acknowledgement = valid; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!acknowledgement) {
      await smokeLog("handoff-timeout", { existingInstancePreserved: true });
      if (!smokeDirectory) {
        await app.whenReady();
        await dialog.showMessageBox({ type: "warning", title: "SCPEFE is already running",
          message: "The existing SCPEFE instance did not respond.",
          detail: "It was not killed or bypassed because it may hold unsaved encrypted work. Use Windows Task Manager to end it manually only after considering that risk, then try again.",
          buttons: ["Close"], defaultId: 0, noLink: true });
      }
    } else if (!["focused", "opened", "canceled", "failed"].includes(acknowledgement.status)) {
      const outcomeDeadline = Date.now() + (smokeDirectory ? 20_000 : 300_000);
      let lastSequence = acknowledgement.sequence;
      while (Date.now() < outcomeDeadline) {
        try {
          const value = JSON.parse(await fs.readFile(instanceAcknowledgementPath, "utf8"));
          const valid = validateAcknowledgement(instanceAcknowledgement, value, expectedTargetHash);
          if (valid?.requestToken === acknowledgement.requestToken
              && valid.sequence >= lastSequence) {
            acknowledgement = valid; lastSequence = valid.sequence;
          }
          if (["focused", "opened", "canceled", "failed"].includes(acknowledgement.status)) break;
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
} else {
  app.on("second-instance", (_event, commandLine, workingDirectory, additionalData) =>
    routeSecondInstance(commandLine, workingDirectory, additionalData));
  if (initialOpenTarget) queueExternal({ target: initialOpenTarget, source: "command-line" });
  app.on("open-file", (event, filePath) => {
    event.preventDefault(); const target = openTargetFromCommandLine(["SCPEFE", filePath]);
    if (target) queueExternal({ target, source: "open-file" });
  });
  app.on("open-url", (event, url) => {
    event.preventDefault(); const target = openTargetFromUrl(url);
    if (target) queueExternal({ target, source: "open-url" });
  });
}

function leaseRequestAuthorization(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)
      || Object.keys(request).some((key) => key !== "authorization")
      || (request.authorization !== undefined
        && (typeof request.authorization !== "string"
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            .test(request.authorization)))) {
    throw new TypeError("lease takeover decision is invalid");
  }
  return request.authorization;
}

if (hasInstanceLock) app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 920, height: 700,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(here, "..", "dist", "preload.cjs") } });
  const userData = app.getPath("userData");
  const serviceFactory = (callbacks) => new DocumentService({ native, fs,
    profilePath: path.join(userData, "profile.json"),
    settingsPath: path.join(userData, "settings.json"),
    journalDirectory: path.join(userData, "work-journals"),
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "best-effort-replace" },
    witnessDirectory: path.join(userData, "head-witnesses"), ...callbacks });
  lifecycleHost = await new DocumentLifecycleHost({ ipc: safeIpcMain, window, serviceFactory,
    picker: {
      async chooseCreateTarget() {
        const chosen = await dialog.showSaveDialog(window, { title: "Create encrypted document",
          defaultPath: "Untitled.scpefe",
          filters: [{ name: "SCPEFE document", extensions: ["scpefe"] }],
          properties: ["createDirectory", "showOverwriteConfirmation"] });
        return chosen.canceled || !chosen.filePath ? null : chosen.filePath;
      },
      async chooseOpenTarget() {
        const chosen = await dialog.showOpenDialog(window, { title: "Open encrypted document",
          filters: [{ name: "SCPEFE document", extensions: ["scpefe"] }],
          properties: ["openFile"] });
        return chosen.canceled || chosen.filePaths.length !== 1 ? null : chosen.filePaths[0];
      },
    }, acknowledge: acknowledgeRequest,
    record: (pending, outcome) => smokeLog("completed", { requestToken: pending.token,
      target: pending.target ? path.basename(pending.target) : null, outcome }),
    observe: (event, request) => smokeLog(event, { requestToken: request.token,
      target: request.target ? path.basename(request.target) : null, source: request.source }),
    externalPresentation: (request) => ({ token: request.token,
      ...(smokeDirectory ? { smokeCompleteAfterMs: Number(
        process.env.SCPEFE_SINGLE_INSTANCE_SMOKE_COMPLETE_MS || 400) } : {}) }),
    completeExternalWithoutOpen: Boolean(smokeDirectory),
  }).start();
  for (const request of pendingExternalRequests.splice(0)) lifecycleHost.enqueueExternal(request);

  const liveService = lifecycleHost.liveService;
  safeIpcMain.handle("document:backup", async () => {
    const chosen = await dialog.showSaveDialog(window, { title: "Create verified backup replica",
      defaultPath: lifecycleHost.service.suggestedBackupTarget(),
      filters: [{ name: "SCPEFE document", extensions: ["scpefe"] }],
      properties: ["createDirectory"] });
    return chosen.canceled || !chosen.filePath ? null
      : lifecycleHost.service.backupDocument(chosen.filePath);
  });
  registerCompactionHandler({ ipcMain: safeIpcMain, service: liveService, dialog, window,
    confirmation: COMPACTION_CONFIRMATION });
  registerMigrationHandler({ ipcMain: safeIpcMain, getService: () => lifecycleHost.service,
    dialog, window, authorizations: lifecycleHost.leaseTakeovers,
    validateAuthorization: leaseRequestAuthorization });
  safeIpcMain.handle("document:change-password", (_event, request) =>
    lifecycleHost.service.changePassword(validatePasswordChangeRequest(request)));
  safeIpcMain.handle("security:password-meets-policy", (_event, password) =>
    Boolean(lifecycleHost.service.native.passwordMeetsPolicy(validatePassword(password))));
  safeIpcMain.handle("document:create-invitation", (_event, request) =>
    lifecycleHost.service.createInvitation(validateInvitationCreateRequest(request)));
  safeIpcMain.handle("document:copy-invitation-passphrase", (_event, password) => {
    clipboard.writeText(validatePassword(password)); return true;
  });
  safeIpcMain.handle("document:reconcile-identity", () =>
    lifecycleHost.service.reconcileIdentity());
  safeIpcMain.handle("document:update-slot-permissions", (_event, request) =>
    lifecycleHost.service.updateSlotPermissions(validateSlotPermissionsRequest(request)));
  safeIpcMain.handle("document:remove-slot", (_event, slotId) =>
    lifecycleHost.service.removeSlot(validateSlotId(slotId)));
  safeIpcMain.handle("document:export-plaintext", async (_event, request) => {
    const validated = validatePlaintextExportRequest(request);
    const warning = await dialog.showMessageBox(window, { type: "warning",
      title: "Export unprotected plaintext?",
      message: "The exported copy will not be password protected.",
      detail: "It contains only the current text, but may persist in backups or storage history.",
      buttons: ["Cancel", "Export plaintext…"], defaultId: 0, cancelId: 0, noLink: true });
    if (warning.response !== 1) return null;
    const chosen = await dialog.showSaveDialog(window, { title: "Export unprotected plaintext",
      filters: [{ name: "Plain text", extensions: ["txt"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"] });
    return chosen.canceled || !chosen.filePath ? null
      : lifecycleHost.service.exportPlaintext(chosen.filePath, validated);
  });

  registerWindowFocusProtection({ window, powerMonitor,
    activity: () => lifecycleHost.notifyActivity(),
    lock: (reason) => lifecycleHost.lockActive(reason) });
  window.loadFile(path.join(here, "..", "dist", "index.html"));
  window.webContents.on("did-finish-load", () => {
    void lifecycleHost.sendJournalSummary();
    const delay = Number(process.env.SCPEFE_SINGLE_INSTANCE_SMOKE_READY_DELAY_MS || 0);
    setTimeout(() => { void smokeLog("renderer-ready").then(() => lifecycleHost.setReady()); },
      delay);
  });
});

app.on("window-all-closed", () => app.quit());
