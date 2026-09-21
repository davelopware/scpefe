import { app, BrowserWindow, clipboard, dialog, ipcMain, powerMonitor } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { registerCompactionHandler } from "./compaction-flow.mjs";
import { registerMigrationHandler } from "./migration-flow.mjs";
import { LeaseTakeoverAuthorizations, runLeaseOperation } from "./lease-takeover.mjs";
import { CreationTargetFlow } from "./creation-flow.mjs";
import { ReplacementCoordinator } from "./replacement-coordinator.mjs";
import { SecureLockCoordinator } from "./secure-lock-coordinator.mjs";
import { SessionProtectionCoordinator } from "./session-protection.mjs";
import { NativeLifecycleCoordinator } from "./native-lifecycle.mjs";
import { ExternalOpenLifecycle } from "./external-open-lifecycle.mjs";
import { SessionGeneration } from "./session-generation.mjs";
import { registerNativeWindowClose } from "./window-lifecycle.mjs";
import { COMPACTION_CONFIRMATION, DocumentService } from "./document-service.mjs";
import { OpenRequestQueue } from "./switch-document.mjs";
import { openTargetFromAdditionalData,
  openTargetFromCommandLine, openTargetFromUrl, acknowledgementCredentials,
  acknowledgementTargetHash, createAcknowledgement, validateAcknowledgement,
  OrderedOpenRequests } from "./single-instance.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const native = require(path.join(here, "..", "native", "scpefe_electron_native.node"));
let window;
let service;
let currentTarget = null;
let lockedTarget = null;
const openRequests = new OpenRequestQueue();
const externalRequests = new OrderedOpenRequests({ randomToken: randomUUID });
let externalDrainRunning = false;
let externalOpenInProgress = false;
let externalLifecycle;
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
    JSON.stringify(acknowledgement), { mode: 0o600 });
}

async function drainExternalRequests() {
  if (externalDrainRunning || externalOpenInProgress
      || !service || !window || window.isDestroyed()) return;
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
    } else if (!["focused", "opened", "canceled", "failed"].includes(acknowledgement.status)) {
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
          if (["focused", "opened", "canceled", "failed"].includes(acknowledgement.status)) {
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
  let secureLocks = null;
  let leaseTakeovers = null;
  let protections = null;
  let replacements = null;
  let lifecycleLockInProgress = false;
  const sessionGeneration = new SessionGeneration();
  const invalidateAndClearRenderer = () => {
    sessionGeneration.invalidate();
    protections?.cancelForLock();
    leaseTakeovers?.clear();
    window?.webContents.send("document:locked",
      { locked: true, journalSaved: false, warning: null });
    void externalLifecycle?.cancelForLock().catch((error) =>
      window?.webContents.send("document:journal-warning",
        `External open cancellation needs attention: ${error.message}`));
  };
  const makeService = () => {
    let created;
    created = new DocumentService({
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
      if (!lifecycleLockInProgress && !secureLocks?.isLocking(created)
          && (created === service || replacements?.hasStagedCandidate(created))) {
        invalidateAndClearRenderer();
      }
      void secureLocks?.serviceLocked(created, result).catch((error) =>
        window?.webContents.send("document:journal-warning",
          `Secure lock cleanup needs attention: ${error.message}`));
    },
    onJournalWarning: (warning) => {
      if (created === service) window?.webContents.send("document:journal-warning", warning);
    },
    onRegularSave: (result) => {
      if (created === service) window?.webContents.send("document:regular-saved", result);
    },
    });
    return created;
  };
  service = makeService();
  leaseTakeovers = new LeaseTakeoverAuthorizations();
  const liveService = new Proxy({}, { get(_target, property) {
    const value = service[property];
    return typeof value === "function" ? value.bind(service) : value;
  } });
  await service.loadClientSettings();
  ipcMain.handle("profile:get", () => service.loadProfile());
  ipcMain.handle("profile:save", (_event, profile) => service.saveProfile(profile));
  ipcMain.handle("profile:reconcile-active", () => service.reconcileProfile());
  ipcMain.handle("settings:get", () => service.loadClientSettings());
  ipcMain.handle("settings:save", (_event, settings) =>
    service.saveClientSettings(settings));
  ipcMain.handle("journal:summary", () => service.unresolvedJournalSummary());
  const creationFlow = new CreationTargetFlow();
  let selectedOpenTarget = null;
  protections = new SessionProtectionCoordinator({ getService: () => service,
    generation: sessionGeneration,
    present: (request) => window.webContents.send("document:protection-requested", request) });
  const adoptReplacement = (staged, target) => {
    leaseTakeovers.clear();
    const previous = service;
    service = staged.candidate;
    staged.candidate.acceptCreatedDocument?.();
    currentTarget = target;
    lockedTarget = target;
    if (previous !== service && previous.active) {
      void previous.lock("document-replaced").catch((error) =>
        window?.webContents.send("document:journal-warning",
          `The replaced session cleanup needs attention: ${error.message}`));
    }
  };
  replacements = new ReplacementCoordinator({ makeCandidate: makeService,
    authorizeCurrent: (operation, commit) => protections.authorize(operation, commit),
    adopt: adoptReplacement, generation: sessionGeneration });
  secureLocks = new SecureLockCoordinator({ getService: () => service,
    replacements, creationFlow,
    clearOpenTarget: () => { selectedOpenTarget = null; },
    rememberLockedTarget: (target) => {
      if (target) { currentTarget = target; lockedTarget = target; }
      else if (currentTarget) lockedTarget = currentTarget;
    },
    emitLocked: (result) => {
      window?.webContents.send("document:locked", result);
      void sendJournalSummary();
    } });
  ipcMain.handle("document:choose-create-target", async () =>
    creationFlow.chooseTarget(async () => {
      const chosen = await dialog.showSaveDialog(window, {
        title: "Create encrypted document",
        defaultPath: "Untitled.scpefe",
        filters: [{ name: "SCPEFE document", extensions: ["scpefe"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      return chosen.canceled || !chosen.filePath ? null : chosen.filePath;
    }));
  ipcMain.handle("document:cancel-create-target", () => creationFlow.cancel());
  ipcMain.handle("document:create", (_event, request) => creationFlow.create(request,
    async (target, validated) => {
      const opened = await replacements.create(target, validated);
      return { created: true, opened, name: path.basename(target) };
    }));
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
  ipcMain.handle("document:cancel-open-target", () => { selectedOpenTarget = null; });
  externalLifecycle = new ExternalOpenLifecycle({ requests: externalRequests,
    acknowledge: acknowledgeRequest,
    record: (pending, outcome) => smokeLog("completed", {
      requestToken: pending.token,
      target: pending.target ? path.basename(pending.target) : null, outcome }),
    drain: drainExternalRequests });
  ipcMain.handle("document:cancel-external-open", async (_event, request) => {
    if (!request || typeof request !== "object" || Array.isArray(request)
        || Object.keys(request).some((key) => key !== "token")
        || typeof request.token !== "string") {
      throw new TypeError("invalid external open cancellation");
    }
    return externalLifecycle.cancel(request.token,
      { blocked: externalOpenInProgress });
  });
  ipcMain.handle("document:open-selected", async (_event, password) => {
    if (!selectedOpenTarget) throw new Error("Choose a document first");
    const target = selectedOpenTarget;
    return openRequests.run(async () => {
      const opened = await replacements.open(target, password);
      selectedOpenTarget = null;
      if (opened.invitationRequired) {
        return { readOnly: true, invitationRequired: true,
          targetName: path.basename(target) };
      }
      await sendJournalSummary();
      return { ...opened, targetName: path.basename(target) };
    });
  });
  ipcMain.handle("document:unlock", async (_event, password) => {
    if (!lockedTarget) throw new Error("No locked document is available");
    const target = lockedTarget;
    const opened = await replacements.open(target, password);
    if (opened.invitationRequired) {
      return { readOnly: true, invitationRequired: true,
        targetName: path.basename(target) };
    }
    await sendJournalSummary();
    return { ...opened, targetName: path.basename(target) };
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
        await externalLifecycle.finish(pending, "canceled", "renderer-canceled");
        return null;
      }
      const opened = await openRequests.run(async () => {
        let replacement;
        try {
          replacement = await replacements.open(
            pending.target, request.password, "external-open");
        } catch (error) {
          if (error?.code === "DOCUMENT_REPLACEMENT_CANCELED") return null;
          throw error;
        }
        return replacement;
      });
      if (opened?.invitationRequired) {
        externalLifecycle.stageInvitation(pending);
        return { ...opened, targetName: path.basename(pending.target) };
      }
      await externalLifecycle.finish(pending, opened ? "opened" : "canceled",
        opened ? "opened" : "canceled");
      await sendJournalSummary();
      return opened ? { ...opened, targetName: path.basename(pending.target) } : null;
    } finally {
      externalOpenInProgress = false;
      void drainExternalRequests();
    }
  });
  const leaseRequestAuthorization = (request) => {
    if (!request || typeof request !== "object" || Array.isArray(request)
        || Object.keys(request).some((key) => key !== "authorization")
        || (request.authorization !== undefined
          && (typeof request.authorization !== "string"
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
              .test(request.authorization)))) {
      throw new TypeError("lease takeover decision is invalid");
    }
    return request.authorization;
  };
  ipcMain.handle("document:enter-edit-mode", async (_event, request) => {
    const current = service;
    return runLeaseOperation({ authorizations: leaseTakeovers, operation: "edit",
      service: current, authorization: leaseRequestAuthorization(request),
      perform: (takeoverToken) => current.enterEditMode({ takeoverToken }) });
  });
  ipcMain.handle("document:save", async (_event, content) => {
    let result;
    try { result = await service.saveDocument(content); }
    catch (error) {
      if (!error?.publicationPrepared || !service.active?.opened) throw error;
      result = { saved: true, content,
        publicationState: service.active.opened.publicationState };
    }
    await sendJournalSummary();
    return result;
  });
  ipcMain.handle("document:reconnect-publication", async () => {
    const result = await service.reconnectPendingPublication();
    await sendJournalSummary();
    return result;
  });
  ipcMain.handle("document:begin-divergence-resolution", (_event, request) => {
    const current = service;
    return runLeaseOperation({ authorizations: leaseTakeovers, operation: "divergence",
      service: current, authorization: leaseRequestAuthorization(request),
      perform: (takeoverToken) => current.beginDivergenceResolution({ takeoverToken }) });
  });
  ipcMain.handle("document:save-divergence-resolution", async (_event, content) => {
    let result;
    try { result = await service.saveDivergenceResolution(content); }
    catch (error) {
      if (!error?.publicationPrepared || !service.active?.opened) throw error;
      result = { saved: true, content,
        publicationState: service.active.opened.publicationState };
    }
    await sendJournalSummary();
    return result;
  });
  ipcMain.handle("document:discard-publication", async () => {
    const result = await service.discardPendingPublication();
    await sendJournalSummary();
    return result;
  });
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
  registerCompactionHandler({ ipcMain, service: liveService, dialog, window,
    confirmation: COMPACTION_CONFIRMATION });
  registerMigrationHandler({ ipcMain, getService: () => service, dialog, window,
    authorizations: leaseTakeovers, validateAuthorization: leaseRequestAuthorization });
  ipcMain.handle("document:change-password", (_event, request) =>
    service.changePassword(request));
  ipcMain.handle("document:create-invitation", (_event, request) =>
    service.createInvitation(request));
  ipcMain.handle("document:copy-invitation-passphrase", (_event, password) => {
    if (typeof password !== "string" || password.length === 0 || password.length > 4096) {
      throw new TypeError("invitation passphrase is invalid");
    }
    clipboard.writeText(password);
    return true;
  });
  ipcMain.handle("document:claim-invitation", async (_event, password) => {
    let opened;
    try { opened = await replacements.claim(password); }
    catch (error) {
      if (externalLifecycle.invitation
          && error?.code === "DOCUMENT_REPLACEMENT_CANCELED") {
        await replacements.cancelClaim();
        await externalLifecycle.finishInvitation("canceled", "claim-canceled");
      }
      throw error;
    }
    if (externalLifecycle.invitation) {
      await externalLifecycle.finishInvitation("opened", "claim-opened");
    }
    await sendJournalSummary();
    return { ...opened, targetName: path.basename(currentTarget) };
  });
  ipcMain.handle("document:cancel-invitation-claim", async () => {
    const canceled = await replacements.cancelClaim();
    if (canceled && externalLifecycle.invitation) {
      await externalLifecycle.finishInvitation("canceled", "claim-canceled");
    }
    return canceled;
  });
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
  ipcMain.handle("document:restore-recovery", async (_event, request) => {
    const current = service;
    const result = await runLeaseOperation({ authorizations: leaseTakeovers,
      operation: "recovery", service: current,
      authorization: leaseRequestAuthorization(request),
      perform: (takeoverToken) => current.restoreRecoveredWork({ takeoverToken }) });
    await sendJournalSummary();
    return result;
  });
  ipcMain.handle("document:discard-recovery", async () => {
    const result = await service.discardRecoveredWork();
    await sendJournalSummary();
    return result;
  });
  ipcMain.handle("document:accept-head-mismatch", () => service.acceptHeadMismatch());
  ipcMain.handle("document:cancel-lease-takeover", (_event, authorization) => {
    if (typeof authorization !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(authorization)) {
      throw new TypeError("lease takeover authorization is invalid");
    }
    return leaseTakeovers.cancel(authorization, service);
  });
  const lockActive = (reason) => {
    invalidateAndClearRenderer();
    const current = service;
    return current.runLifecycleBarrier(() => secureLocks.lock(reason));
  };
  ipcMain.handle("document:lock", () => lockActive("app-lock"));
  ipcMain.handle("document:resolve-protection", (_event, request) =>
    protections.decide(request));
  const closeDocument = async () => {
    const closed = await protections.authorize("close", async () => {
      if (service.active?.editMode) await service.exitEditMode();
      if (service.active) {
        lifecycleLockInProgress = true;
        let result;
        try { result = await service.lock("document-close"); }
        finally { lifecycleLockInProgress = false; }
        if (!result.journalSaved) throw new Error(result.warning
          ?? "The document could not be checkpointed before closing");
      }
      currentTarget = null; lockedTarget = null; selectedOpenTarget = null;
    });
    if (closed) {
      sessionGeneration.invalidate();
      void externalLifecycle?.cancelForLock().catch((error) =>
        window?.webContents.send("document:journal-warning",
          `External open cancellation needs attention: ${error.message}`));
      window.webContents.send("document:closed");
      await sendJournalSummary();
    }
    return closed;
  };
  ipcMain.handle("document:close", () => closeDocument());
  let lifecycle;
  ipcMain.handle("application:exit", () => lifecycle.requestExit());
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
  lifecycle = new NativeLifecycleCoordinator({ getService: () => service,
    protections, lockActive, closeWindow: () => window.close(),
    hasExternalRequests: () => externalRequests.size > 0,
    cancelExternalRequests: () => externalLifecycle.terminateAll("application-exit"),
    report: (warning) => window?.webContents.send("document:journal-warning", warning) });
  registerNativeWindowClose(window, lifecycle);
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
