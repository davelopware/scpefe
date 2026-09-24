import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { DocumentService } from "../src/document-service.mjs";
import { DocumentLifecycleHost } from "../src/document-lifecycle-host.mjs";
import { registerWindowFocusProtection } from "../src/window-focus-protection.mjs";
import { cleanupMountedLifecycleHarness } from "./mounted-lifecycle-cleanup.mjs";

const capabilities = Object.freeze({ sameFilesystemTransaction: true,
  replacementGuarantee: "atomic-replace" });

export async function runMountedLock(t, origin, nativeOverride = null) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `scpefe-mounted-${origin}-`));
  let teardown = () => fs.rm(directory,
    { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  t.after(() => teardown());
  const target = path.join(directory, "document.scpefe");
  const otherTarget = path.join(directory, "other.scpefe");
  const newTarget = path.join(directory, "new-document.scpefe");
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(target, "container");
  await fs.writeFile(otherTarget, "other-container");
  await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
    email: "ada@example.test", deviceName: "Desk" }));
  let lease = { active: false, sessionId: "0".repeat(32), heartbeatCounter: 0,
    holderUtcMs: 0, durationMs: 600_000, holderName: "", holderEmail: "", deviceName: "" };
  let newLease = { ...lease };
  let saveFault = false;
  let discardFault = false;
  let provisionalDiscardFault = false;
  let publicationUnavailable = false;
  let publicationFailureAfter = null;
  let createFault = false;
  let createdCandidate = false;
  let createdInput = null;
  let createdLeaseFault = false;
  let holdMaintenance = false; let releaseMaintenance; let maintenanceStarted;
  const maintenanceReleased = new Promise((resolve) => { releaseMaintenance = resolve; });
  const revisionGraphs = new Map();
  const maintenanceEntered = new Promise((resolve) => { maintenanceStarted = resolve; });
  let holdDiscard = false; let releaseDiscard; let discardStarted;
  const discardReleased = new Promise((resolve) => { releaseDiscard = resolve; });
  const discardEntered = new Promise((resolve) => { discardStarted = resolve; });
  let holdNewLink = false; let releaseNewLink; let newLinkStarted;
  const newLinkEntered = new Promise((resolve) => { newLinkStarted = resolve; });
  let holdOtherReadAt = 0; let otherReadCount = 0; let releaseOtherRead; let otherReadStarted;
  let holdInitialRead = false; let releaseInitialRead; let initialReadStarted;
  const initialReadReleased = new Promise((resolve) => { releaseInitialRead = resolve; });
  const initialReadEntered = new Promise((resolve) => { initialReadStarted = resolve; });
  let postAuthorizationFaultTarget = null;
  let postAuthorizationFaultArmed = false;
  const otherReadEntered = new Promise((resolve) => { otherReadStarted = resolve; });
  const serviceFs = { ...fs, async readFile(file, ...args) {
    if (holdInitialRead && file === target) {
      initialReadStarted();
      await initialReadReleased;
      holdInitialRead = false;
    }
    if (postAuthorizationFaultArmed && file === postAuthorizationFaultTarget) {
      postAuthorizationFaultArmed = false;
      return Buffer.from("post-authorization-revalidation-fault");
    }
    if (file === otherTarget && holdOtherReadAt > 0
        && ++otherReadCount === holdOtherReadAt) {
      otherReadStarted();
      await new Promise((resolve) => { releaseOtherRead = resolve; });
      holdOtherReadAt = 0;
    }
    return fs.readFile(file, ...args);
  }, async link(source, destination) {
    if (holdNewLink && destination === newTarget) {
      newLinkStarted();
      await new Promise((resolve) => { releaseNewLink = resolve; });
      holdNewLink = false;
    }
    return fs.link(source, destination);
  }, async rename(source, destination) {
    if (publicationFailureAfter !== null && destination === target) {
      if (publicationFailureAfter === 0) {
        publicationFailureAfter = null;
        const error = new Error("injected publication target unavailable");
        error.code = "EACCES"; throw error;
      }
      publicationFailureAfter -= 1;
    }
    if (publicationUnavailable && destination === target) {
      const error = new Error("injected publication target unavailable");
      error.code = "EACCES"; throw error;
    }
    if (holdMaintenance && destination === target) {
      maintenanceStarted();
      await maintenanceReleased;
      holdMaintenance = false;
    }
    const renamed = await fs.rename(source, destination);
    if (destination === target && postAuthorizationFaultTarget) {
      postAuthorizationFaultArmed = true;
    }
    return renamed;
  }, async unlink(file) {
    if (holdDiscard && file.startsWith(path.join(directory, "journals"))) {
      discardStarted();
      await discardReleased;
      holdDiscard = false;
    }
    if (discardFault && file.startsWith(path.join(directory, "journals"))) {
      const error = new Error("injected journal discard failure");
      error.code = "EIO"; throw error;
    }
    return fs.unlink(file);
  } };
  const openedContent = (bytes) => bytes.toString() === "other-container" ? "other plaintext"
    : bytes.toString().startsWith("new:") ? bytes.toString().slice(4)
    : /^(saved|provisional):/.test(bytes.toString())
      ? bytes.toString().replace(/^[^:]+:/, "") : "original plaintext";
  const fakeNative = { openDocument(bytes, password) {
    if (password === "wrong password") throw new Error("authentication failed");
    const revision = createHash("sha256").update(bytes).digest("hex");
    const initialRevision = createHash("sha256").update(Buffer.from("container")).digest("hex");
    const revisionGraph = revisionGraphs.get(revision)
      ?? (bytes.toString().startsWith("saved:")
        ? [{ revisionId: revision, parentRevisionIds: [initialRevision] },
          { revisionId: initialRevision, parentRevisionIds: [] }]
        : [{ revisionId: revision, parentRevisionIds: [] }]);
    const invitation = origin === "ro-invitation" && bytes.toString() === "other-container";
    return { content: invitation ? "" : openedContent(bytes), readOnly: true,
    canEdit: !invitation, canAddPasswords: !invitation, canRemovePasswords: !invitation,
    ...(invitation ? { mustBeChanged: true,
      slotIdentityName: "Temporary colleague label",
      slotIdentityEmail: "invited@example.test", profileName: "Document author",
      profileEmail: "author@example.test", deviceName: "Author device" } : {}),
    manuallySealed: !bytes.toString().startsWith("provisional:"),
    documentId: bytes.toString().startsWith("other") ? "62".repeat(16)
      : bytes.toString().startsWith("new:") ? "63".repeat(16) : "61".repeat(16),
    baseRevision: revision,
    revisionGraph,
    journalKey: Buffer.alloc(32, bytes.toString().startsWith("other") ? 0x64
      : bytes.toString().startsWith("new:") ? 0x65 : 0x63),
    lease: { ...(bytes.toString().startsWith("other") ? { active: false,
      sessionId: "0".repeat(32), heartbeatCounter: 0, holderUtcMs: 0,
      durationMs: 600_000, holderName: "", holderEmail: "", deviceName: "" }
      : bytes.toString().startsWith("new:") ? newLease : lease) } };
  }, updateLease(bytes, _password, next) {
    if (createdCandidate && createdLeaseFault) throw new Error("injected created candidate lease failure");
    if (bytes.toString().startsWith("new:")) newLease = { ...next };
    else lease = { ...next };
    return Buffer.from(bytes);
  },
  passwordMeetsPolicy(password) { return password.length >= 12; },
  createDocument(input) {
    if (createFault) throw new Error("injected native create failure");
    createdInput = input;
    createdCandidate = true;
    newLease = { active: false, sessionId: "0".repeat(32),
    heartbeatCounter: 0, holderUtcMs: 0, durationMs: 600_000,
    holderName: "", holderEmail: "", deviceName: "" }; return Buffer.from("new:");
  },
  saveDocument(_bytes, _password, input) {
    if (saveFault) throw new Error("injected native save failure");
    const candidate = Buffer.from(`saved:${input.content}`);
    const revision = createHash("sha256").update(candidate).digest("hex");
    const parent = createHash("sha256").update(_bytes).digest("hex");
    revisionGraphs.set(revision, [{ revisionId: revision, parentRevisionIds: [parent] },
      ...(revisionGraphs.get(parent) ?? [{ revisionId: parent, parentRevisionIds: [] }])]);
    return candidate;
  }, mergeDocument(currentBytes, localBytes, _password, input) {
    const candidate = Buffer.from(`saved:${input.content}`);
    const revision = createHash("sha256").update(candidate).digest("hex");
    const current = createHash("sha256").update(currentBytes).digest("hex");
    const local = createHash("sha256").update(localBytes).digest("hex");
    const nodes = [...(revisionGraphs.get(current)
      ?? [{ revisionId: current, parentRevisionIds: [] }])];
    for (const node of revisionGraphs.get(local)
        ?? [{ revisionId: local, parentRevisionIds: [] }]) {
      if (!nodes.some(({ revisionId }) => revisionId === node.revisionId)) nodes.push(node);
    }
    revisionGraphs.set(revision,
      [{ revisionId: revision, parentRevisionIds: [local, current] }, ...nodes]);
    return candidate;
  }, regularSaveDocument(_bytes, _password, input) {
    return Buffer.from(`provisional:${input.content}`);
  }, discardProvisional() {
    if (provisionalDiscardFault) throw new Error("injected provisional discard failure");
    return Buffer.from("saved:original plaintext");
  } };
  const native = nativeOverride ?? fakeNative;
  const serviceOptions = (callbacks = {}) => ({ native, fs: serviceFs, profilePath,
    publicationCapabilities: capabilities,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    inactivityMs: origin === "inactivity" ? 1_500 : 999_999,
    ...(origin === "lease-refresh-failed" ? { setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} }; timers.push(timer); return timer;
    }, clearTimer() {} } : {}), ...callbacks });
  const timers = []; const acks = [];
  let protectionRequestSeen;
  const protectionRequestObserved = new Promise((resolve) => {
    protectionRequestSeen = resolve;
  });
  const ipcListeners = new Map(); const ipcHandlers = new Map();
  const emittedChannels = [];
  const emit = (channel, value) => {
    emittedChannels.push(channel);
    if (channel === "document:protection-requested") protectionRequestSeen();
    for (const listener of ipcListeners.get(channel) ?? []) listener({}, value);
  };
  let lockStarted; const starting = new Promise((resolve) => { lockStarted = resolve; });
  let lockFinished; const finished = new Promise((resolve) => { lockFinished = resolve; });
  class FakeWindow extends EventEmitter {
    constructor() { super(); this.webContents = { send: emit }; this.closed = 0; }
    close() { const event = { prevented: false, preventDefault() { this.prevented = true; } };
      this.lastClose = Promise.all(this.listeners("close").map((listener) => listener(event)));
      if (!event.prevented) this.closed += 1; return event; }
    show() {} focus() {} isMinimized() { return false; }
  }
  const fakeWindow = new FakeWindow(); let createPickerCalls = 0; let openPickerCalls = 0;
  let restartCandidateHash = null;
  if (origin.startsWith("s7-") || origin.startsWith("rw-")) {
    const crashed = new DocumentService(serviceOptions());
    await crashed.openDocument(target, "password words");
    await crashed.enterEditMode();
    crashed.updateWorkingCopy({ content: "restart recovered plaintext",
      cursor: { start: 27, end: 27 } });
    await crashed.lock("process-restart");
    lease = { active: false, sessionId: "0".repeat(32), heartbeatCounter: 0,
      holderUtcMs: 0, durationMs: 600_000, holderName: "", holderEmail: "",
      deviceName: "" };
  }
  if (origin.startsWith("s8-") || origin.startsWith("cf-")) {
    const diverged = new DocumentService(serviceOptions());
    await diverged.openDocument(target, "password words");
    await diverged.enterEditMode();
    diverged.updateWorkingCopy({ content: "local unpublished branch",
      cursor: { start: 24, end: 24 } });
    publicationUnavailable = true;
    await assert.rejects(diverged.saveDocument("local unpublished branch"), (error) =>
      error.publicationPrepared === true
        && /injected publication target unavailable/.test(error.message));
    assert.equal(diverged.active.opened.publicationState, "pending-publication");
    publicationUnavailable = false;
    await fs.writeFile(target, "saved:remote divergent branch");
    lease = { active: false, sessionId: "0".repeat(32), heartbeatCounter: 0,
      holderUtcMs: 0, durationMs: 600_000, holderName: "", holderEmail: "",
      deviceName: "" };
  }
  if (origin === "pp-restart") {
    const interrupted = new DocumentService(serviceOptions());
    await interrupted.openDocument(target, "password words");
    await interrupted.enterEditMode();
    interrupted.updateWorkingCopy({ content: "restart pending plaintext",
      cursor: { start: 25, end: 25 } });
    publicationUnavailable = true;
    await assert.rejects(interrupted.saveDocument("restart pending plaintext"), (error) =>
      error.publicationPrepared === true);
    restartCandidateHash = interrupted.active.pendingRecord.publication.candidateHash;
  }
  const host = await new DocumentLifecycleHost({
    ipc: { handle(channel, handler) { ipcHandlers.set(channel, handler); } },
    window: fakeWindow, picker: { chooseCreateTarget: async () => {
      createPickerCalls += 1; return origin.startsWith("new")
        || /^s[0-3]-new$/.test(origin)
        || origin.startsWith("s5-") || origin.startsWith("s9-")
        || origin.startsWith("dr-new-") || origin.startsWith("prr-new-")
        || origin.startsWith("al-new-") || origin.startsWith("focus-")
        || origin === "als-new-candidate"
        || (origin.startsWith("rn-") && origin !== "rn-picker-cancel")
        ? newTarget : null;
    },
      chooseOpenTarget: async () => origin.startsWith("ro-") || origin.startsWith("rx-")
          || origin.startsWith("als-open-")
          ? (openPickerCalls++ === 0 ? target
            : origin === "ro-picker-cancel" ? null : otherTarget)
        : origin === "s0-open" ? otherTarget
          : /^(s[1-3]|s9)-open$/.test(origin)
            ? (openPickerCalls++ === 0 ? target : otherTarget)
        : (origin.startsWith("dr-open-") || origin.startsWith("prr-open-"))
          && createPickerCalls++ > 0 ? otherTarget : target },
    serviceFactory: (callbacks) => new DocumentService(serviceOptions(callbacks)),
    acknowledge: async (request, status, sequence) => {
      acks.push({ token: request.token, status, sequence });
    },
  }).start();
  let service = host.service;
  const powerMonitor = new EventEmitter();
  registerWindowFocusProtection({ window: fakeWindow, powerMonitor,
    activity: () => host.notifyActivity(), lock: (reason) => host.lockActive(reason) });

  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>",
    { url: "https://scpefe.invalid/" });
  const keys = ["window", "document", "HTMLElement", "Node", "MutationObserver",
    "FormData", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT"];
  const prior = new Map(keys.map((key) => [key,
    Object.getOwnPropertyDescriptor(globalThis, key)]));
  const frames = new Map(); let frame = 0; let mountedRoot;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, FormData: dom.window.FormData,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame(callback) { const id = ++frame; frames.set(id, callback);
      queueMicrotask(() => { const pending = frames.get(id);
        if (pending) { frames.delete(id); pending(performance.now()); } }); return id; },
    cancelAnimationFrame: (id) => frames.delete(id), IS_REACT_ACT_ENVIRONMENT: true });
  teardown = () => cleanupMountedLifecycleHarness({
    completion: dom.window[Symbol.for("scpefe.renderer.lifecycle-completion")],
    drainRendererTasks: () => new Promise((resolve) => setImmediate(resolve)),
    unmount: () => mountedRoot?.unmount(), clearFrames: () => frames.clear(),
    closeDom: () => dom.window.close(),
    restoreGlobals: () => { for (const [key, descriptor] of prior) descriptor
      ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; },
    removeTemporaryFiles: () => fs.rm(directory,
      { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
  });
  const invoke = async (channel, value) => {
    if (channel === "security:password-meets-policy") {
      return native.passwordMeetsPolicy(value);
    }
    const handler = ipcHandlers.get(channel);
    if (!handler) return null;
    return handler({}, value);
  };
  const preload = await fs.readFile(new URL("../dist/preload.cjs", import.meta.url), "utf8");
  vm.runInNewContext(preload, { Buffer, TextEncoder, setTimeout,
    require(identifier) {
      assert.equal(identifier, "electron");
      return { contextBridge: { exposeInMainWorld(name, api) { dom.window[name] = api; } },
        ipcRenderer: {
          invoke,
          on(channel, listener) {
            const current = ipcListeners.get(channel) ?? new Set();
            current.add(listener); ipcListeners.set(channel, current);
          },
          removeListener(channel, listener) { ipcListeners.get(channel)?.delete(listener); },
        } };
    } });
  dom.window[Symbol.for("scpefe.renderer.mount")] = (root) => { mountedRoot = root; };
  const assets = await fs.readdir(new URL("../dist/assets/", import.meta.url));
  const script = assets.find((entry) => /^index-.*\.js$/.test(entry));
  const rendererUrl = new URL(`../dist/assets/${script}`, import.meta.url);
  await import(`${rendererUrl.href}?real-lock-${origin}`);
  const ui = await import("@testing-library/dom");
  const userEvent = (await import("@testing-library/user-event")).default;
  const user = userEvent.setup({ document: dom.window.document });
  const waitScalar = async (predicate, label, attempts = 100) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "menubar")));
  await ui.waitFor(() => assert.ok(
    ipcListeners.get("document:external-open-requested")?.size));
  const command = async (menu, name) => { await user.click(ui.getByRole(document.body,
    "menuitem", { name: menu })); await user.click(ui.getByRole(
    ui.getByRole(document.body, "menu", { name: menu }), "menuitem", { name })); };
  const awaitLifecycleCompletion = async (label) => {
    const completion = dom.window[
      Symbol.for("scpefe.renderer.lifecycle-completion")];
    assert.equal(typeof completion?.waitForIdle, "function",
      `renderer exposes lifecycle completion for ${label}`);
    await completion.waitForIdle({ timeoutMs: 5_000 });
  };
  const awaitHarnessPhase = async (phase, label) => {
    let phaseTimeout;
    try {
      await Promise.race([phase, new Promise((_, reject) => {
        phaseTimeout = setTimeout(() => reject(
          new Error(`renderer did not reach ${label}`)), 5_000);
      })]);
    } finally {
      clearTimeout(phaseTimeout);
    }
  };
  const awaitHeldLifecycleCompletion = async (entered, release, label) => {
    let completion;
    let completionSettledBeforeRelease;
    let entryTimeout;
    try {
      await Promise.race([entered, new Promise((_, reject) => {
        entryTimeout = setTimeout(() => reject(
          new Error(`${label} did not reach its held operation`)), 5_000);
      })]);
      let completionSettled = false;
      completion = awaitLifecycleCompletion(label)
        .then(() => { completionSettled = true; });
      await new Promise((resolve) => setImmediate(resolve));
      completionSettledBeforeRelease = completionSettled;
    } finally {
      clearTimeout(entryTimeout);
      release();
    }
    assert.equal(completionSettledBeforeRelease, false,
      `lifecycle completion waits for held ${label}`);
    await completion;
  };
  const editor = ui.getByRole(document.body, "textbox", { name: "Document text" });
  const assertFocusPreserved = async (dialog, field) => {
    const focused = ui.getByLabelText(dialog, field);
    focused.focus(); focused.setSelectionRange(2, 5);
    const priorEmits = emittedChannels.length;
    for (const event of ["blur", "minimize", "focus", "restore"]) fakeWindow.emit(event);
    await Promise.resolve();
    assert.equal(document.body.contains(dialog), true);
    assert.equal(document.activeElement, focused);
    assert.deepEqual([focused.selectionStart, focused.selectionEnd], [2, 5]);
    assert.equal(emittedChannels.slice(priorEmits).some((channel) =>
      channel === "document:lock-started" || channel === "document:locked"), false);
    assert.equal(createdCandidate, false);
  };
  const driveDirect = async (entry, expectedState, windowPrevented = false) => {
    if (entry === "new") {
      await command("File", /New/); assert.equal(ui.queryByRole(document.body, "dialog"), null);
    } else if (entry === "open") {
      await command("File", /Open/);
      const opened = await ui.findByRole(document.body, "dialog", { name: "Open document" });
      await user.click(ui.getByRole(opened, "button", { name: "Cancel" }));
    } else if (entry === "external") {
      await host.setReady(); host.enqueueExternal({ target, source: "second-instance" });
      const opened = await ui.findByRole(document.body, "dialog",
        { name: "Open requested document" });
      await user.click(ui.getByRole(opened, "button", { name: "Cancel" }));
    } else if (entry === "close") {
      await command("File", /Close/); expectedState = "No document";
    } else if (entry === "exit") {
      await command("File", "Exit"); await ui.waitFor(() => assert.equal(fakeWindow.closed, 1));
    } else {
      const event = fakeWindow.close(); assert.equal(event.prevented, windowPrevented);
      if (windowPrevented) await fakeWindow.lastClose;
      await ui.waitFor(() => assert.equal(fakeWindow.closed, 1));
    }
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
    await waitScalar(() => ui.getByLabelText(document.body,
      "Document state").textContent === expectedState, `${entry} state ${expectedState}`);
  };
  const driveSuccessfulReplacement = async (entry) => {
    const priorService = host.service;
    let request = null;
    if (entry === "new") {
      const issue53 = origin === "s0-new";
      const ownerPassword = issue53
        ? "defenistration is the root of" : "owner password words";
      await command("File", /New/);
      await waitScalar(() => ui.queryByRole(document.body, "dialog",
        { name: "Secure new document" }) !== null, "New security dialog");
      const creation = ui.getByRole(document.body, "dialog",
        { name: "Secure new document" });
      await user.type(ui.getByLabelText(creation, "Owner password"), ownerPassword);
      await user.type(ui.getByLabelText(creation, "Confirm owner password"),
        ownerPassword);
      if (issue53) {
        await user.type(ui.getByLabelText(creation,
          "Independent recovery password (strongly recommended)"),
        "01a0bf20-2424-73e9-a572-f2eded90be3e");
        await user.type(ui.getByLabelText(creation, "Confirm recovery password"),
          "01a0bf20-2424-73e9-a572-f2eded90be3e");
        await ui.waitFor(() => assert.equal(
          ui.getAllByText(creation, "Meets password requirements").length, 2));
        await user.click(ui.getByLabelText(creation,
          "I will store the recovery password independently."));
      }
      await user.click(ui.getByLabelText(creation,
        "I understand that lost passwords cannot be recovered."));
      await user.click(ui.getByRole(creation, "button", { name: "Create" }));
    } else {
      if (entry === "open") await command("File", /Open/);
      else {
        await host.setReady();
        request = host.enqueueExternal({ target: otherTarget, source: "second-instance" });
      }
      const dialogName = entry === "open" ? "Open document" : "Open requested document";
      await waitScalar(() => ui.queryByRole(document.body, "dialog",
        { name: dialogName }) !== null, `${entry} password dialog`);
      const opened = ui.getByRole(document.body, "dialog", { name: dialogName });
      await user.type(ui.getByLabelText(opened, "Password"), "password words");
      await user.click(ui.getByRole(opened, "button", { name: "Open" }));
    }
    const expectedState = entry === "new" ? "Edit mode" : "Read-only";
    await waitScalar(() => host.service !== priorService,
      `${entry} candidate adoption as the authoritative service`);
    await waitScalar(() => ui.getByLabelText(document.body,
      "Document state").textContent === expectedState, `${entry} state ${expectedState}`);
    assert.notEqual(host.service, priorService, "the staged service became authoritative");
    assert.equal(priorService.active, null, "the replaced service released its lease and secrets");
    assert.equal(host.currentTarget, entry === "new" ? newTarget : otherTarget);
    const titlePattern = new RegExp(entry === "new"
      ? "new-document\\.scpefe" : "other\\.scpefe");
    await waitScalar(() => titlePattern.test(document.title), `${entry} safe document title`);
    assert.equal(editor.value, entry === "new" ? "" : "other plaintext");
    if (entry === "new" && origin === "s0-new" && nativeOverride === null) {
      assert.equal(createdInput.ownerPassword, "defenistration is the root of");
      assert.equal(createdInput.recoveryPassword,
        "01a0bf20-2424-73e9-a572-f2eded90be3e");
    }
    await waitScalar(() => document.activeElement === editor,
      "successful replacement focus on the document editor");
    if (request) {
      await waitScalar(() => host.externalRequests.current(request.token) === null,
        "external request terminal acknowledgement");
      assert.deepEqual(acks.map(({ status }) => status), ["queued", "presented", "opened"]);
    }
  };
  const driveProtectedCancel = async (entry) => {
    let externalRequest = null;
    if (entry === "new") {
      await command("File", /New/);
      const creation = await ui.findByRole(document.body, "dialog",
        { name: "Secure new document" });
      await user.type(ui.getByLabelText(creation, "Owner password"), "owner password words");
      await user.type(ui.getByLabelText(creation, "Confirm owner password"),
        "owner password words");
      await user.click(ui.getByLabelText(creation,
        "I understand that lost passwords cannot be recovered."));
      await user.click(ui.getByRole(creation, "button", { name: "Create" }));
      if (origin === "s5-new") {
        await awaitHarnessPhase(protectionRequestObserved,
          "provisional New protection request");
        await new Promise((resolve) => setImmediate(resolve));
      }
    } else if (entry === "open") {
      await command("File", /Open/);
      const opened = await ui.findByRole(document.body, "dialog", { name: "Open document" });
      await user.type(ui.getByLabelText(opened, "Password"), "password words");
      await user.click(ui.getByRole(opened, "button", { name: "Open" }));
    } else if (entry === "external") {
      await host.setReady(); externalRequest = host.enqueueExternal({ target: otherTarget,
        source: "second-instance" });
      const opened = await ui.findByRole(document.body, "dialog",
        { name: "Open requested document" });
      await user.type(ui.getByLabelText(opened, "Password"), "password words");
      await user.click(ui.getByRole(opened, "button", { name: "Open" }));
    } else if (entry === "close") await command("File", /Close/);
    else if (entry === "exit") await command("File", "Exit");
    else { const event = fakeWindow.close(); assert.equal(event.prevented, true); }
    const title = entry === "new" ? /before New/ : ["open", "external"].includes(entry)
      ? /before Open/ : entry === "close" ? /before Close/ : /before Exit/;
    const protection = origin === "s5-new"
      ? ui.getByRole(document.body, "dialog", { name: title })
      : await ui.findByRole(document.body, "dialog", { name: title });
    const keep = ui.getByRole(protection, "button", { name: "Keep current document open" });
    assert.equal(document.activeElement, keep);
    if (externalRequest) keep.click();
    else await user.click(keep);
    if (externalRequest) await waitScalar(() =>
      host.externalRequests.current(externalRequest.token) === null,
    "external request cancellation after keeping the current document");
    await ui.waitFor(() => assert.equal(
      ui.queryByRole(document.body, "dialog", { name: title }), null));
    const returned = ["new", "open"].includes(entry)
      ? await ui.findByRole(document.body, "dialog")
      : entry === "external" ? null : ui.queryByRole(document.body, "dialog");
    if (returned) {
      const cancel = ui.queryByRole(returned, "button", { name: "Cancel" });
      if (cancel) await user.click(cancel);
    }
    if (origin === "s5-new") {
      await awaitLifecycleCompletion("provisional New protection cancellation");
    }
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
  };
  if (origin === "tc-close-no-doc") {
    await command("File", /Close/);
    assert.equal(ui.queryByRole(document.body, "dialog"), null);
    assert.equal(ui.getByLabelText(document.body, "Document state").textContent,
      "No document"); assert.equal(fakeWindow.closed, 0); return;
  }
  if (origin === "te-exit-once") {
    await command("File", "Exit");
    await ui.waitFor(() => assert.equal(fakeWindow.closed, 1));
    assert.equal(acks.length, 0); return;
  }
  if (origin.startsWith("s0-")) {
    const entry = origin.slice(3);
    if (["new", "open", "external"].includes(entry)) {
      await driveSuccessfulReplacement(entry); return;
    } else if (entry === "close") {
      await command("File", /Close/);
      assert.equal(ui.queryByRole(document.body, "dialog"), null);
    } else if (entry === "exit") {
      await command("File", "Exit"); await ui.waitFor(() => assert.equal(fakeWindow.closed, 1));
    } else {
      const event = fakeWindow.close(); assert.equal(event.prevented, false);
      assert.equal(fakeWindow.closed, 1);
    }
    assert.equal(ui.getByLabelText(document.body, "Document state").textContent,
      "No document");
    return;
  }
  if (origin === "focus-no-doc") {
    await command("File", /New/);
    const creation = await ui.findByRole(document.body, "dialog",
      { name: "Secure new document" });
    const owner = ui.getByLabelText(creation, "Owner password");
    const recovery = ui.getByLabelText(creation,
      "Independent recovery password (strongly recommended)");
    await user.type(owner, "owner password words");
    await user.type(ui.getByLabelText(creation, "Confirm owner password"),
      "owner password typo");
    await user.type(recovery, "independent recovery secret");
    await user.type(ui.getByLabelText(creation, "Confirm recovery password"),
      "independent recovery secret");
    await user.click(ui.getByLabelText(creation,
      "I understand that lost passwords cannot be recovered."));
    await user.click(ui.getByLabelText(creation,
      "I will store the recovery password independently."));
    await user.click(ui.getByRole(creation, "button", { name: "Show owner passwords" }));
    await user.click(ui.getByRole(creation, "button", { name: "Create" }));
    assert.match(ui.getByRole(creation, "alert").textContent, /owner passwords do not match/i);
    await assertFocusPreserved(creation, "Confirm owner password");
    assert.equal(owner.value, "owner password words");
    assert.equal(owner.type, "text");
    assert.equal(recovery.value, "independent recovery secret");
    assert.equal(ui.getByLabelText(creation,
      "I will store the recovery password independently.").checked, true);
    assert.match(ui.getByRole(creation, "alert").textContent, /owner passwords do not match/i);
    assert.equal(createPickerCalls, 1);
    assert.equal(await fs.stat(newTarget).then(() => true, () => false), false);
    await user.click(ui.getByRole(creation, "button", { name: "Cancel" }));
    await command("File", /Open/);
    const opened = await ui.findByRole(document.body, "dialog", { name: "Open document" });
    await user.type(ui.getByLabelText(opened, "Password"), "password words");
    await assertFocusPreserved(opened, "Password");
    assert.equal(ui.getByLabelText(opened, "Password").value, "password words");
    await user.click(ui.getByRole(opened, "button", { name: "Cancel" }));
    return;
  }
  await command("File", /Open/);
  let dialog = await ui.findByRole(document.body, "dialog", { name: "Open document" });
  await user.type(ui.getByLabelText(dialog, "Password"), "password words");
  if (origin === "s8-close") holdInitialRead = true;
  await user.click(ui.getByRole(dialog, "button", { name: "Open" }));
  if (origin === "s8-close") {
    await awaitHeldLifecycleCompletion(initialReadEntered, () => releaseInitialRead(),
      "initial document Open");
  } else await awaitLifecycleCompletion("initial document Open");
  await ui.waitFor(() => assert.equal(ui.getByLabelText(document.body,
    "Document state").textContent, "Read-only"));
  if (origin === "focus-active") {
    await command("File", /New/);
    const creation = await ui.findByRole(document.body, "dialog",
      { name: "Secure new document" });
    await user.type(ui.getByLabelText(creation, "Owner password"), "owner password words");
    await assertFocusPreserved(creation, "Owner password");
    assert.equal(host.service.active.opened.content, "original plaintext");
    assert.equal(ui.getByLabelText(creation, "Owner password").value,
      "owner password words");
    await user.click(ui.getByRole(creation, "button", { name: "Cancel" }));
    assert.equal(editor.value, "original plaintext");
    return;
  }
  if (origin === "pp-restart") {
    const pending = await ui.findByRole(document.body, "dialog",
      { name: "Manual save pending publication" });
    assert.equal(editor.value, "");
    assert.equal(host.service.active.opened.content, "restart pending plaintext");
    assert.equal(host.service.active.opened.publicationState, "pending-publication");
    assert.equal(host.service.active.pendingRecord.publication.candidateHash,
      restartCandidateHash);
    await user.click(ui.getByRole(pending, "button", { name: "Retry publication" }));
    await ui.findByText(pending, /operation could not be completed safely/i);
    assert.equal(host.service.active.pendingRecord.publication.candidateHash,
      restartCandidateHash);
    assert.equal(host.service.active.opened.publicationState, "pending-publication");
    assert.equal(document.activeElement,
      ui.getByRole(pending, "button", { name: "Retry publication" }));
    await new Promise((resolve) => setImmediate(resolve));
    return;
  }
  if (origin.startsWith("s7-") || origin.startsWith("rw-")
      || origin.startsWith("s8-") || origin.startsWith("cf-")) {
    const divergent = origin.startsWith("s8-") || origin.startsWith("cf-");
    if (divergent) {
      const head = ui.queryByRole(document.body, "dialog",
        { name: "This target has diverged" });
      if (head) await user.click(ui.getByRole(head, "button",
        { name: "Accept current authenticated head" }));
    }
    const recovery = await ui.findByRole(document.body, "dialog",
      { name: divergent ? "Divergence needs resolution" : "Recovered work" });
    assert.equal(editor.value, "",
      "a blocking recovery decision retains but does not expose plaintext behind its overlay");
    if (origin.startsWith("cf-")) {
      const outcome = origin.slice(3);
      if (outcome === "external") {
        await host.setReady(); const request = host.enqueueExternal({ target: otherTarget,
          source: "second-instance" });
        await ui.waitFor(() => assert.equal(
          host.externalRequests.current(request.token)?.token, request.token));
        assert.deepEqual(acks.map(({ status }) => status), ["queued", "presented"]);
        assert.equal(host.service.active.opened.publicationState, "conflict");
        await user.click(ui.getByRole(recovery, "button", { name: "Retry publication" }));
        await waitScalar(() => editor.value.includes("local unpublished branch"),
          "conflict resolution merge draft");
        await user.clear(editor); await user.type(editor, "resolved queued conflict");
        await user.keyboard("{Control>}s{/Control}");
        await waitScalar(() => ui.getByLabelText(document.body,
          "Publication state").textContent === "Published", "resolved conflict publication");
        const external = await ui.findByRole(document.body, "dialog",
          { name: "Open requested document" });
        await user.type(ui.getByLabelText(external, "Password"), "password words");
        await user.click(ui.getByRole(external, "button", { name: "Open" }));
        await waitScalar(() => host.externalRequests.current(request.token) === null,
          "resolved conflict external request completion");
        assert.deepEqual(acks.map(({ status }) => status), ["queued", "presented", "opened"]);
        assert.equal(host.currentTarget, otherTarget); return;
      }
      if (outcome === "restart") {
        assert.equal(host.service.active.pendingRecord.state, "conflict");
        await user.click(ui.getByRole(recovery, "button", { name: "Retry publication" }));
        await ui.waitFor(() => assert.equal(editor.value.includes("local unpublished branch"), true));
        assert.equal(host.service.active.pendingRecord.merge.localContent,
          "local unpublished branch"); return;
      }
      const event = fakeWindow.close(); assert.equal(event.prevented, true);
      let protection = await ui.findByRole(document.body, "dialog", { name: /before Exit/ });
      if (outcome === "cancel") {
        await user.click(ui.getByRole(protection, "button",
          { name: "Keep current document open" }));
        assert.ok(await ui.findByRole(document.body, "dialog",
          { name: "Divergence needs resolution" }));
        assert.equal(fakeWindow.closed, 0); return;
      }
      if (outcome === "retry") {
        await user.click(ui.getByRole(protection, "button",
          { name: "Retry publication and continue" }));
        await ui.findByText(protection,
          /document protection choice could not be completed/i);
        assert.equal(host.service.active.opened.publicationState, "conflict");
        assert.equal(fakeWindow.closed, 0); return;
      }
      if (outcome === "discard") {
        await user.click(ui.getByRole(protection, "button", { name: "Discard and continue" }));
        await ui.findByText(protection,
          /document protection choice could not be completed/i);
        assert.equal(fakeWindow.closed, 0);
        assert.equal(host.service.active.opened.publicationState, "conflict");
        assert.equal(await fs.readFile(target, "utf8"), "saved:remote divergent branch"); return;
      }
      await user.click(ui.getByRole(protection, "button",
        { name: "Keep current document open" }));
      const conflict = await ui.findByRole(document.body, "dialog",
        { name: "Divergence needs resolution" });
      await user.click(ui.getByRole(conflict, "button", { name: "Retry publication" }));
      await ui.waitFor(() => assert.equal(editor.value.includes("local unpublished branch"), true));
      await user.clear(editor); await user.type(editor, "merged authenticated branch");
      await user.keyboard("{Control>}s{/Control}");
      await ui.waitFor(() => assert.equal(ui.getByLabelText(document.body,
        "Publication state").textContent, "Published"));
      const closeEvent = fakeWindow.close();
      if (closeEvent.prevented) await fakeWindow.lastClose;
      await ui.waitFor(() => assert.equal(fakeWindow.closed, 1));
      assert.equal(await fs.readFile(target, "utf8"), "saved:merged authenticated branch");
      return;
    }
    if (origin.startsWith("rw-")) {
      const outcome = origin.slice(3);
      if (outcome === "external") {
        await host.setReady(); const request = host.enqueueExternal({ target: otherTarget,
          source: "second-instance" });
        await ui.waitFor(() => assert.equal(
          host.externalRequests.current(request.token)?.token, request.token));
        assert.deepEqual(acks.map(({ status }) => status), ["queued", "presented"]);
        assert.ok(document.body.contains(recovery));
        await user.click(ui.getByRole(recovery, "button", { name: "Discard recovered work" }));
        const external = await ui.findByRole(document.body, "dialog",
          { name: "Open requested document" });
        await user.type(ui.getByLabelText(external, "Password"), "password words");
        await user.click(ui.getByRole(external, "button", { name: "Open" }));
        await waitScalar(() => host.externalRequests.current(request.token) === null,
          "resolved recovery external request completion");
        assert.deepEqual(acks.map(({ status }) => status), ["queued", "presented", "opened"]);
        assert.equal(host.currentTarget, otherTarget); return;
      }
      if (outcome === "restart") {
        assert.equal(host.service.active.recovery.text, "restart recovered plaintext");
        const record = await host.service.journals.read(host.service.active.documentId,
          host.service.active.journalKey);
        assert.equal(record.text, "restart recovered plaintext"); return;
      }
      const event = fakeWindow.close(); assert.equal(event.prevented, true);
      let protection = await ui.findByRole(document.body, "dialog", { name: /before Exit/ });
      if (outcome === "cancel") {
        await user.click(ui.getByRole(protection, "button",
          { name: "Keep current document open" }));
        assert.ok(await ui.findByRole(document.body, "dialog", { name: "Recovered work" }));
        assert.equal(fakeWindow.closed, 0); return;
      }
      if (outcome === "save-retry") publicationFailureAfter = 1;
      const decision = outcome === "discard" ? "Discard and continue"
        : "Manual save and continue";
      await user.click(ui.getByRole(protection, "button", { name: decision }));
      if (outcome === "save-retry") {
        await ui.findByText(protection,
          /document protection choice could not be completed/i);
        assert.equal(fakeWindow.closed, 0);
        protection = ui.getByRole(document.body, "dialog", { name: /before Exit/ });
        await user.click(ui.getByRole(protection, "button", { name: decision }));
      }
      await ui.waitFor(() => assert.equal(fakeWindow.closed, 1));
      if (outcome !== "discard") assert.equal(await fs.readFile(target, "utf8"),
        "saved:restart recovered plaintext");
      return;
    }
    const entry = origin.slice(3);
    const pickerCounts = { create: createPickerCalls, open: openPickerCalls };
    if (entry === "external") {
      await host.setReady(); const request = host.enqueueExternal({ target,
        source: "second-instance" });
      await ui.waitFor(() => assert.equal(
        host.externalRequests.current(request.token)?.token, request.token));
      assert.deepEqual(acks.map(({ status }) => status), ["queued", "presented"]);
    } else if (entry === "window") {
      const event = fakeWindow.close(); assert.equal(event.prevented, true);
      const protection = await ui.findByRole(document.body, "dialog", { name: /before Exit/ });
      assert.equal(host.protections.pending?.operation, "exit",
        "the actual native-close handler requested protection behind the blocking modal");
      await user.click(ui.getByRole(protection, "button",
        { name: "Keep current document open" }));
      await fakeWindow.lastClose;
      assert.equal(fakeWindow.closed, 0);
    } else {
      await command("File", entry === "new" ? /New/ : entry === "open" ? /Open/
        : entry === "close" ? /Close/ : "Exit");
      assert.equal(host.protections.pending, null,
        "the blocking recovery modal makes the lifecycle command inapplicable");
      assert.deepEqual({ create: createPickerCalls, open: openPickerCalls }, pickerCounts,
        "no picker or host lifecycle entry ran behind the blocking modal");
    }
    assert.ok(await ui.findByRole(document.body, "dialog",
      { name: divergent ? "Divergence needs resolution" : "Recovered work" }));
    assert.equal(editor.value, "");
    if (divergent) {
      assert.equal(host.service.active.opened.publicationState, "conflict");
      assert.equal(host.service.active.opened.content, "local unpublished branch");
      assert.equal(host.service.active.pendingRecord.text, "local unpublished branch");
    } else {
      assert.equal(host.service.active.opened.content, "original plaintext");
      assert.equal(host.service.active.recovery.text, "restart recovered plaintext");
    }
    assert.equal(fakeWindow.closed, 0);
    return;
  }
  if (origin.startsWith("s1-")) {
    const entry = origin.slice(3);
    if (["new", "open", "external"].includes(entry)) {
      await driveSuccessfulReplacement(entry); return;
    }
    await driveDirect(entry, "Read-only"); return;
  }
  await command("Edit", "Edit Contents");
  await awaitLifecycleCompletion("entering edit mode");
  await ui.waitFor(() => assert.equal(ui.getByLabelText(document.body,
    "Document state").textContent, "Edit mode"));
  service = host.service;
  const originalLockStart = service.onLockStart;
  service.onLockStart = (value) => { assert.equal(value.reason,
    origin.startsWith("s3-") || origin.startsWith("al-") || origin.startsWith("als-")
    ? "app-lock" : origin === "close" || origin.endsWith("-close")
      || origin.startsWith("dc-close-") || origin.startsWith("prc-close-")
      || origin.startsWith("rw-") || origin.startsWith("tw-") || origin.startsWith("tx-")
      ? "document-close" : origin);
    originalLockStart(value); lockStarted(); };
  const originalLocked = service.onLocked;
  service.onLocked = (result) => { originalLocked(result); lockFinished(result); };
  if (origin === "focus-decision") {
    await user.clear(editor);
    await user.type(editor, "unsaved focus decision");
    await command("File", /New/);
    const creation = await ui.findByRole(document.body, "dialog",
      { name: "Secure new document" });
    await user.type(ui.getByLabelText(creation, "Owner password"), "owner password words");
    await user.type(ui.getByLabelText(creation, "Confirm owner password"),
      "owner password words");
    await user.click(ui.getByLabelText(creation,
      "I understand that lost passwords cannot be recovered."));
    await user.click(ui.getByRole(creation, "button", { name: "Create" }));
    const decision = await ui.findByRole(document.body, "dialog", { name: /before New/ });
    const priorEmits = emittedChannels.length;
    for (const event of ["blur", "minimize", "focus", "restore"]) fakeWindow.emit(event);
    assert.equal(document.body.contains(decision), true);
    assert.equal(ui.getByRole(decision, "button",
      { name: "Keep current document open" }).disabled, false);
    assert.equal(emittedChannels.slice(priorEmits).some((channel) =>
      channel === "document:lock-started" || channel === "document:locked"), false);
    assert.equal(host.service.active.working.content, "unsaved focus decision");
    await user.click(ui.getByRole(decision, "button",
      { name: "Keep current document open" }));
    const returned = await ui.findByRole(document.body, "dialog",
      { name: "Secure new document" });
    await user.click(ui.getByRole(returned, "button", { name: "Cancel" }));
    return;
  }
  if (origin.startsWith("s2-")) {
    const entry = origin.slice(3);
    if (["new", "open", "external"].includes(entry)) {
      await driveSuccessfulReplacement(entry); return;
    }
    await driveDirect(entry, "Edit mode", origin.endsWith("window")); return;
  }
  if (origin.startsWith("s3-")) {
    await command("Security", "Lock");
    await ui.waitFor(() => assert.equal(ui.getByLabelText(document.body,
      "Document state").textContent, "Locked"));
    const entry = origin.slice(3);
    if (["new", "open", "external"].includes(entry)) {
      await driveSuccessfulReplacement(entry); return;
    }
    await driveDirect(entry, "Locked"); return;
  }
  await user.clear(editor);
  await user.type(editor, "mounted secret plaintext");
  await ui.waitFor(() => assert.equal(ui.getByLabelText(document.body,
    "Working copy state").textContent, "Dirty"));
  const provisionalDecision = origin.startsWith("prr-") || origin.startsWith("prc-");
  if (provisionalDecision) {
    await service.saveClientSettings({ regularSaveEnabled: true,
      regularSaveIntervalMs: 120_000 });
    await service.regularSaveDocument();
    await ui.waitFor(() => assert.equal(ui.getByLabelText(document.body,
      "Publication state").textContent, "Provisional publication"));
  }
  if (origin.startsWith("als-")) {
    const [, entry, stage] = origin.split("-"); let request;
    if (entry === "new") {
      holdNewLink = true;
      await command("File", /New/);
      const creation = await ui.findByRole(document.body, "dialog",
        { name: "Secure new document" });
      await user.type(ui.getByLabelText(creation, "Owner password"), "owner password words");
      await user.type(ui.getByLabelText(creation, "Confirm owner password"),
        "owner password words");
      await user.click(ui.getByLabelText(creation,
        "I understand that lost passwords cannot be recovered."));
      await user.click(ui.getByRole(creation, "button", { name: "Create" }));
      await newLinkEntered;
    } else {
      holdOtherReadAt = stage === "auth" ? 1 : 2;
      if (entry === "open") await command("File", /Open/);
      else { await host.setReady(); request = host.enqueueExternal({ target: otherTarget,
        source: "second-instance" }); }
      const opened = await ui.findByRole(document.body, "dialog",
        { name: entry === "open" ? "Open document" : "Open requested document" });
      await user.type(ui.getByLabelText(opened, "Password"), "password words");
      await user.click(ui.getByRole(opened, "button", { name: "Open" }));
      if (stage === "auth") await otherReadEntered;
      else {
        const protection = await ui.findByRole(document.body, "dialog", { name: /before Open/ });
        await user.click(ui.getByRole(protection, "button", { name: "Discard and continue" }));
        await otherReadEntered;
      }
    }
    const generation = host.generation.capture();
    const locking = host.lockActive("app-lock");
    assert.equal(host.generation.capture(), generation + 1);
    await ui.waitFor(() => assert.equal(editor.value, ""));
    if (entry === "new") releaseNewLink(); else releaseOtherRead();
    await locking;
    await ui.waitFor(() => assert.equal(ui.getByLabelText(document.body,
      "Document state").textContent, "Locked"));
    assert.equal(host.service.active, null); assert.equal(fakeWindow.closed, 0);
    await ui.waitFor(() => assert.equal(host.replacements.candidates.size, 0));
    await new Promise((resolve) => setImmediate(resolve));
    if (entry === "new") await ui.waitFor(async () => assert.equal(
      await fs.stat(newTarget).then(() => true, () => false), false));
    if (request) {
      await ui.waitFor(() => assert.equal(host.externalRequests.current(request.token), null));
      assert.equal(acks.at(-1).status, "canceled");
    }
    return;
  }
  if (origin.startsWith("al-")) {
    const [, entry, variant] = origin.split("-"); let request;
    if (entry === "new") {
      await command("File", /New/);
      const creation = await ui.findByRole(document.body, "dialog",
        { name: "Secure new document" });
      await user.type(ui.getByLabelText(creation, "Owner password"), "owner password words");
      await user.type(ui.getByLabelText(creation, "Confirm owner password"),
        "owner password words");
      await user.click(ui.getByLabelText(creation,
        "I understand that lost passwords cannot be recovered."));
      await user.click(ui.getByRole(creation, "button", { name: "Create" }));
    } else if (entry === "open") {
      await command("File", /Open/);
      const opened = await ui.findByRole(document.body, "dialog", { name: "Open document" });
      await user.type(ui.getByLabelText(opened, "Password"), "password words");
      await user.click(ui.getByRole(opened, "button", { name: "Open" }));
    } else if (entry === "external") {
      await host.setReady(); request = host.enqueueExternal({ target: otherTarget,
        source: "second-instance" });
      const opened = await ui.findByRole(document.body, "dialog",
        { name: "Open requested document" });
      await user.type(ui.getByLabelText(opened, "Password"), "password words");
      await user.click(ui.getByRole(opened, "button", { name: "Open" }));
    } else if (entry === "close") await command("File", /Close/);
    else if (entry === "exit") await command("File", "Exit");
    else { const event = fakeWindow.close(); assert.equal(event.prevented, true); }
    const protection = await ui.findByRole(document.body, "dialog",
      { name: entry === "new" ? /before New/ : ["open", "external"].includes(entry)
        ? /before Open/ : entry === "close" ? /before Close/ : /before Exit/ });
    if (variant === "save") {
      holdMaintenance = true;
      await user.click(ui.getByRole(protection, "button", { name: "Manual save and continue" }));
      await Promise.race([maintenanceEntered, new Promise((_, reject) => setTimeout(() =>
        reject(new Error(`save did not enter publication: ${protection.textContent}`)), 1_000))]);
    } else if (variant === "discard") {
      holdDiscard = true;
      await user.click(ui.getByRole(protection, "button", { name: "Discard and continue" }));
      await Promise.race([discardEntered, new Promise((_, reject) => setTimeout(() =>
        reject(new Error(`discard did not enter journal cleanup: ${protection.textContent}`)),
      1_000))]);
    }
    const generation = host.generation.capture();
    const locking = host.lockActive("app-lock");
    if (variant === "dialog") await starting;
    assert.equal(host.generation.capture(), generation + 1);
    await ui.waitFor(() => assert.equal(editor.value, ""));
    assert.equal(fakeWindow.closed, 0);
    if (variant === "save") releaseMaintenance();
    if (variant === "discard") releaseDiscard();
    await locking;
    await ui.waitFor(() => assert.equal(ui.getByLabelText(document.body,
      "Document state").textContent, "Locked"));
    assert.equal(host.service.active, null);
    if (entry === "new") await ui.waitFor(async () => assert.equal(
      await fs.stat(newTarget).then(() => true, () => false), false));
    if (request) {
      await ui.waitFor(() => assert.equal(host.externalRequests.current(request.token), null));
      assert.equal(acks.at(-1).status, "canceled");
    }
    return;
  }
  if (origin === "tx-external-before-exit") {
    await host.setReady(); const request = host.enqueueExternal({ target: otherTarget,
      source: "second-instance" });
    await ui.findByRole(document.body, "dialog", { name: "Open requested document" });
    assert.deepEqual(acks.map(({ status }) => status), ["queued", "presented"]);
    const event = fakeWindow.close(); assert.equal(event.prevented, true);
    const protection = await ui.findByRole(document.body, "dialog", { name: /before Exit/ });
    await user.click(ui.getByRole(protection, "button", { name: "Discard and continue" }));
    await fakeWindow.lastClose;
    assert.deepEqual(acks.map(({ status }) => status), ["queued", "presented", "canceled"]);
    assert.equal(host.externalRequests.current(request.token), null);
    assert.equal(fakeWindow.closed, 1); return;
  }
  if (origin.startsWith("rn-")) {
    await command("File", /New/);
    if (origin === "rn-picker-cancel") {
      assert.equal(ui.queryByRole(document.body, "dialog"), null);
      assert.equal(await fs.stat(newTarget).then(() => true, () => false), false);
      assert.equal(editor.value, "mounted secret plaintext"); return;
    }
    const creation = await ui.findByRole(document.body, "dialog",
      { name: "Secure new document" });
    await user.type(ui.getByLabelText(creation, "Owner password"), "owner password words");
    await user.type(ui.getByLabelText(creation, "Confirm owner password"),
      origin === "rn-mismatch" ? "owner password typo" : "owner password words");
    await user.click(ui.getByLabelText(creation,
      "I understand that lost passwords cannot be recovered."));
    createFault = origin === "rn-create-fault";
    createdLeaseFault = origin === "rn-stage-lease-fault";
    await user.click(ui.getByRole(creation, "button", { name: "Create" }));
    if (origin === "rn-mismatch") {
      assert.match(ui.getByRole(creation, "alert").textContent,
        /owner passwords do not match/i);
      assert.equal(await fs.stat(newTarget).then(() => true, () => false), false);
      assert.equal(editor.value, ""); return;
    }
    if (origin === "rn-post-authorization-revalidation") {
      const protection = await ui.findByRole(document.body, "dialog", { name: /before New/ });
      postAuthorizationFaultTarget = newTarget;
      await user.click(ui.getByRole(protection, "button", { name: "Manual save and continue" }));
      await ui.findByText(protection, /document protection choice could not be completed/i);
      assert.equal(host.service, service);
      assert.equal(editor.value, "");
      assert.equal(service.active.dirty, false,
        "the authorized Save completed before the second revalidation failed");
      assert.equal(document.activeElement,
        ui.getByRole(protection, "button", { name: "Manual save and continue" }));
      assert.equal(await fs.stat(newTarget).then(() => true, () => false), true,
        "the retryable candidate remains staged until the operator cancels replacement");
      await user.click(ui.getByRole(protection, "button",
        { name: "Keep current document open" }));
      const returned = await ui.findByRole(document.body, "dialog",
        { name: "Secure new document" });
      await ui.waitFor(async () => assert.equal(
        await fs.stat(newTarget).then(() => true, () => false), false));
      await user.click(ui.getByRole(returned, "button", { name: "Cancel" }));
      return;
    }
    await ui.findByText(creation, /operation could not be completed safely/i);
    assert.equal(host.service === service, true);
    assert.equal(editor.value, "");
    assert.equal(await fs.stat(newTarget).then(() => true, () => false), false);
    return;
  }
  if (origin.startsWith("ro-")) {
    await command("File", /Open/);
    if (origin === "ro-picker-cancel") {
      assert.equal(ui.queryByRole(document.body, "dialog"), null);
      assert.equal(editor.value, "mounted secret plaintext"); return;
    }
    let opened = await ui.findByRole(document.body, "dialog", { name: "Open document" });
    if (origin === "ro-dialog-cancel") {
      await user.click(ui.getByRole(opened, "button", { name: "Cancel" }));
      await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
      assert.equal(host.service === service, true); assert.equal(editor.value,
        "mounted secret plaintext"); return;
    }
    await user.type(ui.getByLabelText(opened, "Password"),
      origin === "ro-wrong-password" ? "wrong password" : "password words");
    await user.click(ui.getByRole(opened, "button", { name: "Open" }));
    if (origin === "ro-wrong-password") {
      await ui.findByRole(opened, "alert");
      assert.equal(host.service === service, true); assert.equal(editor.value, ""); return;
    }
    if (origin === "ro-invitation") {
      const claim = await ui.findByRole(document.body, "dialog", { name: "Claim invitation" });
      await user.click(ui.getByRole(claim, "button", { name: "Cancel" }));
      await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
      assert.equal(host.service === service, true); assert.equal(editor.value,
        "mounted secret plaintext"); return;
    }
    const protection = await ui.findByRole(document.body, "dialog", { name: /before Open/ });
    if (origin === "ro-pre-authorization-revalidation") {
      await fs.writeFile(otherTarget, "other-container-mutated");
      await user.click(ui.getByRole(protection, "button", { name: "Discard and continue" }));
    } else {
      postAuthorizationFaultTarget = otherTarget;
      await user.click(ui.getByRole(protection, "button", { name: "Manual save and continue" }));
    }
    await ui.findByText(protection, /document protection choice could not be completed/i);
    assert.equal(host.service === service, true);
    assert.equal(editor.value, "");
    if (origin === "ro-post-authorization-revalidation") {
      assert.equal(service.active.dirty, false,
        "the authorized Save completed before the second revalidation failed");
      assert.equal(document.activeElement,
        ui.getByRole(protection, "button", { name: "Manual save and continue" }));
      assert.equal(host.replacements.candidates.size, 1);
    }
    await user.click(ui.getByRole(protection, "button",
      { name: "Keep current document open" }));
    const returned = await ui.findByRole(document.body, "dialog", { name: "Open document" });
    await ui.waitFor(() => assert.equal(host.replacements.candidates.size, 0));
    await user.click(ui.getByRole(returned, "button", { name: "Cancel" }));
    return;
  }
  if (origin.startsWith("rx-")) {
    await host.setReady(); const request = host.enqueueExternal({ target: otherTarget,
      source: "second-instance" });
    const opened = await ui.findByRole(document.body, "dialog",
      { name: "Open requested document" });
    if (origin === "rx-cancel") {
      await user.click(ui.getByRole(opened, "button", { name: "Cancel" }));
      await ui.waitFor(() => assert.deepEqual(acks.map(({ status }) => status),
        ["queued", "presented", "canceled"]));
      assert.equal(host.externalRequests.current(request.token), null);
      assert.equal(editor.value, "mounted secret plaintext"); return;
    }
    if (origin === "rx-retry") {
      await user.type(ui.getByLabelText(opened, "Password"), "wrong password");
      await user.click(ui.getByRole(opened, "button", { name: "Open" }));
      await ui.findByRole(opened, "alert");
      assert.deepEqual(acks.map(({ status }) => status), ["queued", "presented"]);
      await user.clear(ui.getByLabelText(opened, "Password"));
    }
    await user.type(ui.getByLabelText(opened, "Password"), "password words");
    await user.click(ui.getByRole(opened, "button", { name: "Open" }));
    const protection = await ui.findByRole(document.body, "dialog", { name: /before Open/ });
    await user.click(ui.getByRole(protection, "button", { name: "Discard and continue" }));
    await ui.waitFor(() => assert.deepEqual(acks.map(({ status }) => status),
      ["queued", "presented", "opened"]));
    assert.equal(host.externalRequests.current(request.token), null);
    assert.equal(host.service === service, false);
    await ui.waitFor(() => assert.equal(editor.value, "other plaintext"));
    return;
  }
  if (origin.startsWith("dr-") || origin.startsWith("prr-")) {
    const [, entry, ...outcomeParts] = origin.split("-");
    const outcome = outcomeParts.join("-"); let request;
    if (entry === "new") {
      await command("File", /New/);
      const creation = await ui.findByRole(document.body, "dialog",
        { name: "Secure new document" });
      await user.type(ui.getByLabelText(creation, "Owner password"), "owner password words");
      await user.type(ui.getByLabelText(creation, "Confirm owner password"),
        "owner password words");
      await user.click(ui.getByLabelText(creation,
        "I understand that lost passwords cannot be recovered."));
      await user.click(ui.getByRole(creation, "button", { name: "Create" }));
    } else if (entry === "open") {
      await command("File", /Open/);
      const opened = await ui.findByRole(document.body, "dialog", { name: "Open document" });
      await user.type(ui.getByLabelText(opened, "Password"), "password words");
      await user.click(ui.getByRole(opened, "button", { name: "Open" }));
    } else {
      await host.setReady(); request = host.enqueueExternal({ target: otherTarget,
        source: "second-instance" });
      const opened = await ui.findByRole(document.body, "dialog",
        { name: "Open requested document" });
      await user.type(ui.getByLabelText(opened, "Password"), "password words");
      await user.click(ui.getByRole(opened, "button", { name: "Open" }));
    }
    let protection = await ui.findByRole(document.body, "dialog",
      { name: entry === "new" ? /before New/ : /before Open/ });
    if (outcome === "cancel") {
      await user.click(ui.getByRole(protection, "button",
        { name: "Keep current document open" }));
      const returned = await ui.findByRole(document.body, "dialog");
      await user.click(ui.getByRole(returned, "button", { name: "Cancel" }));
      await ui.waitFor(() => assert.equal(document.querySelector("[role=dialog]") === null, true));
      assert.equal(host.service === service, true); assert.equal(editor.value,
        "mounted secret plaintext");
      if (request) assert.deepEqual(acks.map(({ status }) => status),
        ["queued", "presented", "canceled"]);
      return;
    }
    const decision = outcome.startsWith("save") ? "Manual save and continue"
      : "Discard and continue";
    if (outcome === "save-retry") saveFault = true;
    if (outcome === "discard-retry") {
      if (provisionalDecision) provisionalDiscardFault = true; else discardFault = true;
    }
    let replacementCompletion = null;
    if (origin === "prr-open-save") holdMaintenance = true;
    await user.click(ui.getByRole(protection, "button", { name: decision }));
    if (origin === "prr-open-save") {
      await Promise.race([maintenanceEntered, new Promise((_, reject) => setTimeout(() =>
        reject(new Error(`provisional replacement did not enter publication: ${
          protection.textContent}`)), 1_000))]);
      let completionSettled = false;
      replacementCompletion = awaitLifecycleCompletion(
        "provisional Save-and-open").then(() => { completionSettled = true; });
      let completionSettledBeforeRelease;
      try {
        await new Promise((resolve) => setImmediate(resolve));
        completionSettledBeforeRelease = completionSettled;
      } finally {
        releaseMaintenance();
      }
      assert.equal(completionSettledBeforeRelease, false,
        "lifecycle completion waits for held provisional replacement publication");
    }
    if (outcome.endsWith("retry")) {
      await ui.findByText(protection,
        /document protection choice could not be completed/i);
      assert.equal(host.service === service, true); assert.equal(editor.value, "");
      if (provisionalDecision && outcome === "discard-retry") {
        protection = ui.getByRole(document.body, "dialog",
          { name: entry === "new" ? /before New/ : /before Open/ });
        await user.click(ui.getByRole(protection, "button",
          { name: "Keep current document open" }));
        const returned = await ui.findByRole(document.body, "dialog");
        await user.click(ui.getByRole(returned, "button", { name: "Cancel" }));
        await ui.waitFor(() => assert.equal(
          document.querySelector("[role=dialog]") === null, true));
        return;
      }
      saveFault = false; discardFault = false; provisionalDiscardFault = false;
      protection = ui.getByRole(document.body, "dialog",
        { name: entry === "new" ? /before New/ : /before Open/ });
      await user.click(ui.getByRole(protection, "button", { name: decision }));
    }
    if (replacementCompletion) await replacementCompletion;
    else await awaitLifecycleCompletion(
      `${provisionalDecision ? "provisional" : "dirty"} ${decision} ${entry}`);
    await ui.waitFor(() => {
      assert.equal(document.querySelector("[role=dialog]") === null, true);
      assert.equal(host.service === service, false);
      assert.equal(editor.value, entry === "new" ? "" : "other plaintext");
    });
    if (request) assert.deepEqual(acks.map(({ status }) => status),
      ["queued", "presented", "opened"]);
    return;
  }
  if (origin.startsWith("dc-") || origin.startsWith("prc-")) {
    const [, entry, ...outcomeParts] = origin.split("-");
    const outcome = outcomeParts.join("-");
    if (entry === "close") await command("File", /Close/);
    else if (entry === "exit") await command("File", "Exit");
    else { const event = fakeWindow.close(); assert.equal(event.prevented, true); }
    let protection = await ui.findByRole(document.body, "dialog",
      { name: entry === "close" ? /before Close/ : /before Exit/ });
    if (outcome === "cancel") {
      await user.click(ui.getByRole(protection, "button",
        { name: "Keep current document open" }));
      await awaitLifecycleCompletion(`dirty Cancel ${entry}`);
      await ui.waitFor(() => assert.equal(document.querySelector("[role=dialog]") === null, true));
      assert.equal(editor.value, "mounted secret plaintext"); assert.equal(fakeWindow.closed, 0);
      return;
    }
    const decision = outcome.startsWith("save") ? "Manual save and continue"
      : "Discard and continue";
    if (outcome === "save-retry") saveFault = true;
    if (outcome === "discard-retry") {
      if (provisionalDecision) provisionalDiscardFault = true; else discardFault = true;
    }
    if (origin === "dc-exit-discard") holdDiscard = true;
    await user.click(ui.getByRole(protection, "button", { name: decision }));
    if (outcome.endsWith("retry")) {
      const message = /document protection choice could not be completed/i;
      await ui.findByText(protection, message);
      assert.equal(editor.value, ""); assert.equal(fakeWindow.closed, 0);
      if (provisionalDecision && outcome === "discard-retry") {
        protection = ui.getByRole(document.body, "dialog",
          { name: entry === "close" ? /before Close/ : /before Exit/ });
        await user.click(ui.getByRole(protection, "button",
          { name: "Keep current document open" }));
        await awaitLifecycleCompletion(`provisional retry Cancel ${entry}`);
        await ui.waitFor(() => assert.equal(
          document.querySelector("[role=dialog]") === null, true));
        assert.equal(fakeWindow.closed, 0); return;
      }
      saveFault = false; discardFault = false; provisionalDiscardFault = false;
      protection = ui.getByRole(document.body, "dialog",
        { name: entry === "close" ? /before Close/ : /before Exit/ });
      if (origin === "dc-exit-save-retry") holdMaintenance = true;
      await user.click(ui.getByRole(protection, "button", { name: decision }));
    }
    if (origin === "dc-exit-save-retry") {
      await awaitHeldLifecycleCompletion(maintenanceEntered, () => releaseMaintenance(),
        "dirty Exit save retry");
    } else if (origin === "dc-exit-discard") {
      await awaitHeldLifecycleCompletion(discardEntered, () => releaseDiscard(),
        "dirty Exit discard");
    } else await awaitLifecycleCompletion(`dirty ${decision} ${entry}`);
    if (entry === "close") await ui.waitFor(() => assert.equal(
      ui.getByLabelText(document.body, "Document state").textContent, "No document"));
    else await ui.waitFor(() => assert.equal(fakeWindow.closed, 1));
    return;
  }
  if (origin.startsWith("s9-")) {
    await service.saveClientSettings({ regularSaveEnabled: true,
      regularSaveIntervalMs: 120_000 });
    holdMaintenance = true;
    const publishing = service.regularSaveDocument();
    await maintenanceEntered;
    assert.equal(service.hasActivePublication(), true);
    const entry = origin.slice(3);
    const priorService = host.service; let request = null; let stagedSubmit = null;
    if (entry === "new") {
      await command("File", /New/);
      const creation = await ui.findByRole(document.body, "dialog",
        { name: "Secure new document" });
      await user.type(ui.getByLabelText(creation, "Owner password"), "owner password words");
      await user.type(ui.getByLabelText(creation, "Confirm owner password"),
        "owner password words");
      await user.click(ui.getByLabelText(creation,
        "I understand that lost passwords cannot be recovered."));
      await user.click(ui.getByRole(creation, "button", { name: "Create" }));
    } else if (entry === "open" || entry === "external") {
      if (entry === "open") await command("File", /Open/);
      else { await host.setReady(); request = host.enqueueExternal({ target: otherTarget,
        source: "second-instance" }); }
      const staged = await ui.findByRole(document.body, "dialog",
        { name: entry === "open" ? "Open document" : "Open requested document" });
      await user.type(ui.getByLabelText(staged, "Password"), "password words");
      stagedSubmit = user.click(ui.getByRole(staged, "button", { name: "Open" }));
    } else if (entry === "close") await command("File", /Close/);
    else if (entry === "exit") await command("File", "Exit");
    else { const event = fakeWindow.close(); assert.equal(event.prevented, true); }
    const protection = await ui.findByRole(document.body, "dialog", { name:
      entry === "new" ? /before New/ : ["open", "external"].includes(entry)
        ? /before Open/ : entry === "close" ? /before Close/ : /before Exit/ });
    await user.click(ui.getByRole(protection, "button", { name: "Manual save and continue" }));
    assert.equal(host.service, priorService,
      "authorization waits behind the held production lifecycle barrier");
    assert.equal(fakeWindow.closed, 0);
    if (request) assert.deepEqual(acks.map(({ status }) => status), ["queued", "presented"]);
    releaseMaintenance(); await publishing;
    if (stagedSubmit) await stagedSubmit;
    if (entry === "new" || entry === "open" || entry === "external") {
      const expectedState = entry === "new" ? "Edit mode" : "Read-only";
      await ui.waitFor(() => assert.notEqual(host.service, priorService));
      await ui.waitFor(() => assert.equal(ui.getByLabelText(document.body,
        "Document state").textContent, expectedState));
      assert.notEqual(host.service, priorService);
      assert.equal(priorService.active, null);
      assert.equal(host.currentTarget, entry === "new" ? newTarget : otherTarget);
      if (request) {
        await ui.waitFor(() => assert.equal(host.externalRequests.current(request.token), null));
        assert.deepEqual(acks.map(({ status }) => status), ["queued", "presented", "opened"]);
      }
    } else if (entry === "close") {
      await ui.waitFor(() => assert.equal(ui.getByLabelText(document.body,
        "Document state").textContent, "No document"));
    } else {
      if (entry === "window") await fakeWindow.lastClose;
      await ui.waitFor(() => assert.equal(fakeWindow.closed, 1));
    }
    assert.equal(service.hasActivePublication(), false);
    return;
  }
  if (origin.startsWith("s6-") || origin.startsWith("pp-")) {
    publicationUnavailable = true;
    await command("File", /^Save/);
    const pending = await ui.findByRole(document.body, "dialog",
      { name: "Manual save pending publication" });
    assert.equal(editor.value, "",
      "the pending publication decision retains but does not expose plaintext behind its overlay");
    assert.equal(host.service.active.opened.publicationState, "pending-publication");
    assert.equal(host.service.active.opened.content, "mounted secret plaintext");
    if (origin === "pp-window-cancel") {
      const event = fakeWindow.close(); assert.equal(event.prevented, true);
      const protection = await ui.findByRole(document.body, "dialog", { name: /before Exit/ });
      await user.click(ui.getByRole(protection, "button",
        { name: "Keep current document open" }));
      await fakeWindow.lastClose; assert.equal(fakeWindow.closed, 0);
      assert.ok(await ui.findByRole(document.body, "dialog",
        { name: "Manual save pending publication" }));
      return;
    }
    if (origin === "pp-retry") {
      const retry = ui.getByRole(pending, "button", { name: "Retry publication" });
      await user.click(retry);
      assert.ok(document.body.contains(pending));
      assert.equal(host.service.active.opened.publicationState, "pending-publication");
      publicationUnavailable = false; await user.click(retry);
      await ui.waitFor(() => assert.equal(document.querySelector("[role=dialog]") === null, true));
      assert.equal(host.service.active.opened.publicationState, "target-published");
      assert.equal(await fs.readFile(target, "utf8"), "saved:mounted secret plaintext");
      return;
    }
    if (origin === "pp-discard-refused") {
      const event = fakeWindow.close(); assert.equal(event.prevented, true);
      const protection = await ui.findByRole(document.body, "dialog", { name: /before Exit/ });
      const discard = ui.getByRole(protection, "button", { name: "Discard and continue" });
      await user.click(discard);
      await ui.findByText(protection,
        /document protection choice could not be completed/i);
      assert.equal(document.activeElement, discard);
      assert.equal(host.service.active.opened.publicationState, "pending-publication");
      assert.equal(fakeWindow.closed, 0);
      return;
    }
    if (origin === "pp-fifo") {
      await host.setReady(); const request = host.enqueueExternal({ target: otherTarget,
        source: "second-instance" });
      await ui.waitFor(() => assert.deepEqual(acks.map(({ status }) => status),
        ["queued", "presented"]));
      assert.equal(host.externalRequests.current(request.token)?.token, request.token);
      publicationUnavailable = false;
      await user.click(ui.getByRole(pending, "button", { name: "Retry publication" }));
      const external = await ui.findByRole(document.body, "dialog",
        { name: "Open requested document" });
      await user.click(ui.getByRole(external, "button", { name: "Cancel" }));
      await ui.waitFor(() => assert.deepEqual(acks.map(({ status }) => status),
        ["queued", "presented", "canceled"]));
      return;
    }
    const entry = origin.slice(3);
    const pickerCounts = { create: createPickerCalls, open: openPickerCalls };
    if (entry === "external") {
      await host.setReady(); const request = host.enqueueExternal({ target,
        source: "second-instance" });
      await ui.waitFor(() => assert.equal(
        host.externalRequests.current(request.token)?.token, request.token));
      assert.deepEqual(acks.map(({ status }) => status), ["queued", "presented"]);
    } else if (entry === "window") {
      const event = fakeWindow.close(); assert.equal(event.prevented, true);
      assert.equal(fakeWindow.closed, 0);
      assert.equal(host.protections.pending?.operation, "exit",
        "the registered native close requested protection while publication is blocked");
    } else {
      await command("File", entry === "new" ? /New/ : entry === "open" ? /Open/
        : entry === "close" ? /Close/ : "Exit");
      assert.equal(host.protections.pending, null,
        "the pending-publication modal makes this menu command inapplicable");
      assert.deepEqual({ create: createPickerCalls, open: openPickerCalls }, pickerCounts,
        "no picker or host lifecycle entry ran behind the pending-publication modal");
    }
    assert.equal(ui.getByRole(document.body, "dialog"), pending,
      "the real pending-publication decision remains authoritative");
    assert.equal(editor.value, "");
    assert.equal(fakeWindow.closed, 0);
    return;
  }
  if (origin.startsWith("s5-")) {
    await service.saveClientSettings({ regularSaveEnabled: true,
      regularSaveIntervalMs: 120_000 });
    await service.regularSaveDocument();
    await ui.waitFor(() => assert.equal(ui.getByLabelText(document.body,
      "Publication state").textContent, "Provisional publication"));
    await driveProtectedCancel(origin.slice(3));
    assert.equal(editor.value, "mounted secret plaintext");
    assert.equal(ui.getByLabelText(document.body, "Working copy state").textContent, "Dirty");
    assert.equal(ui.getByLabelText(document.body, "Publication state").textContent,
      "Provisional publication");
    assert.equal(fakeWindow.closed, 0);
    return;
  }
  if (["close", "exit"].includes(origin)) {
    await command("File", origin === "close" ? /Close/ : "Exit");
    let protection = await ui.findByRole(document.body, "dialog",
      { name: new RegExp(`before ${origin === "close" ? "Close" : "Exit"}`) });
    const keep = ui.getByRole(protection, "button", { name: "Keep current document open" });
    assert.equal(document.activeElement, keep); await user.click(keep);
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
    assert.equal(editor.value, "mounted secret plaintext"); assert.equal(fakeWindow.closed, 0);
    await command("File", origin === "close" ? /Close/ : "Exit");
    protection = await ui.findByRole(document.body, "dialog",
      { name: new RegExp(`before ${origin === "close" ? "Close" : "Exit"}`) });
    await user.click(ui.getByRole(protection, "button", { name: "Discard and continue" }));
    if (origin === "close") {
      await ui.waitFor(() => assert.equal(ui.getByLabelText(document.body,
        "Document state").textContent, "No document"));
      assert.equal(editor.value, "");
    } else await ui.waitFor(() => assert.equal(fakeWindow.closed, 1));
    return;
  }
  if (origin === "open") {
    await command("File", /Open/);
    const openDialog = await ui.findByRole(document.body, "dialog", { name: "Open document" });
    await user.type(ui.getByLabelText(openDialog, "Password"), "password words");
    await user.click(ui.getByRole(openDialog, "button", { name: "Open" }));
    const protection = await ui.findByRole(document.body, "dialog", { name: /before Open/ });
    assert.equal(editor.value, "");
    await user.click(ui.getByRole(protection, "button", { name: "Keep current document open" }));
    const returned = await ui.findByRole(document.body, "dialog", { name: "Open document" });
    assert.equal(editor.value, "");
    assert.equal(host.service, service);
    await user.click(ui.getByRole(returned, "button", { name: "Cancel" }));
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
    assert.equal(editor.value, "mounted secret plaintext");
    return;
  }
  if (origin === "new") {
    await command("File", /New/);
    const creation = await ui.findByRole(document.body, "dialog",
      { name: "Secure new document" });
    assert.equal(createPickerCalls, 1, "the real picker completed before the security dialog");
    await user.type(ui.getByLabelText(creation, "Owner password"), "owner password words");
    await user.type(ui.getByLabelText(creation, "Confirm owner password"),
      "owner password typo");
    await user.click(ui.getByLabelText(creation,
      "I understand that lost passwords cannot be recovered."));
    await user.click(ui.getByRole(creation, "button", { name: "Create" }));
    assert.match(ui.getByRole(creation, "alert").textContent,
      /owner passwords do not match/i);
    assert.equal(document.activeElement,
      ui.getByLabelText(creation, "Confirm owner password"));
    assert.equal(await fs.stat(newTarget).then(() => true, () => false), false);
    assert.equal(editor.value, "");
    await user.click(ui.getByRole(creation, "button", { name: "Cancel" }));
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
    assert.equal(editor.value, "mounted secret plaintext");
    return;
  }
  if (origin === "new-approved") {
    await command("File", /New/);
    const creation = await ui.findByRole(document.body, "dialog",
      { name: "Secure new document" });
    await user.type(ui.getByLabelText(creation, "Owner password"), "owner password words");
    await user.type(ui.getByLabelText(creation, "Confirm owner password"),
      "owner password words");
    await user.click(ui.getByLabelText(creation,
      "I understand that lost passwords cannot be recovered."));
    await user.click(ui.getByRole(creation, "button", { name: "Create" }));
    const protection = await ui.findByRole(document.body, "dialog", { name: /before New/ });
    assert.equal(await fs.stat(newTarget).then(() => true, () => false), true,
      "the isolated candidate exists until the protection decision completes");
    assert.equal(editor.value, "");
    await user.click(ui.getByRole(protection, "button", { name: "Keep current document open" }));
    const returned = await ui.findByRole(document.body, "dialog",
      { name: "Secure new document" });
    await ui.waitFor(async () => assert.equal(
      await fs.stat(newTarget).then(() => true, () => false), false));
    assert.equal(editor.value, "");
    await user.click(ui.getByRole(returned, "button", { name: "Cancel" }));
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
    await command("File", /New/);
    const retryCreation = await ui.findByRole(document.body, "dialog",
      { name: "Secure new document" });
    await user.type(ui.getByLabelText(retryCreation, "Owner password"),
      "owner password words");
    await user.type(ui.getByLabelText(retryCreation, "Confirm owner password"),
      "owner password words");
    await user.click(ui.getByLabelText(retryCreation,
      "I understand that lost passwords cannot be recovered."));
    await user.click(ui.getByRole(retryCreation, "button", { name: "Create" }));
    const retryProtection = await ui.findByRole(document.body, "dialog",
      { name: /before New/ });
    saveFault = true;
    await user.click(ui.getByRole(retryProtection, "button",
      { name: "Manual save and continue" }));
    await ui.findByText(retryProtection,
      /document protection choice could not be completed/i);
    saveFault = false;
    await user.click(ui.getByRole(retryProtection, "button",
      { name: "Manual save and continue" }));
    await ui.waitFor(async () => {
      assert.equal(document.querySelector(".dialog-error")?.textContent ?? "", "");
      assert.equal(document.querySelector("[role=dialog]") === null, true);
      assert.equal(host.service === service, false);
      assert.equal(await fs.stat(newTarget).then(() => true, () => false), true);
    });
    return;
  }
  if (origin === "external-open") {
    await host.setReady();
    const request = host.enqueueExternal({ target, source: "second-instance" });
    const externalDialog = await ui.findByRole(document.body, "dialog",
      { name: "Open requested document" });
    await user.type(ui.getByLabelText(externalDialog, "Password"), "wrong password");
    await user.click(ui.getByRole(externalDialog, "button", { name: "Open" }));
    await ui.findByRole(externalDialog, "alert");
    assert.equal(editor.value, "");
    assert.deepEqual(acks.map(({ status }) => status), ["queued", "presented"]);
    assert.equal(host.externalRequests.current(request.token).token, request.token);
    await user.click(ui.getByRole(externalDialog, "button", { name: "Cancel" }));
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
    assert.equal(editor.value, "mounted secret plaintext");
    assert.deepEqual(acks.map(({ status }) => status), ["queued", "presented", "canceled"]);
    assert.equal(host.externalRequests.current(request.token), null);
    return;
  }
  if (origin === "window-close" || origin === "tw-protect-reentry") {
    const first = fakeWindow.close();
    assert.equal(first.prevented, true);
    let protection = await ui.findByRole(document.body, "dialog", { name: /before Exit/ });
    assert.equal(editor.value, "");
    assert.equal(document.activeElement, ui.getByRole(protection, "button",
      { name: "Keep current document open" }));
    await user.click(ui.getByRole(protection, "button", { name: "Keep current document open" }));
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
    await fakeWindow.lastClose;
    assert.equal(fakeWindow.closed, 0); assert.equal(editor.value, "mounted secret plaintext");
    const second = fakeWindow.close(); assert.equal(second.prevented, true);
    protection = await ui.findByRole(document.body, "dialog", { name: /before Exit/ });
    const save = ui.getByRole(protection, "button", { name: "Manual save and continue" });
    saveFault = true; await user.click(save);
    await ui.waitFor(() => assert.match(ui.getByText(protection,
      /document protection choice could not be completed/i).textContent,
    /document protection choice could not be completed/i));
    assert.equal(fakeWindow.closed, 0); assert.equal(editor.value, "");
    assert.equal(document.activeElement, save);
    saveFault = false; holdMaintenance = true; await user.click(save);
    await awaitHeldLifecycleCompletion(maintenanceEntered, () => releaseMaintenance(),
      "native window Exit save retry");
    await ui.waitFor(() => assert.equal(fakeWindow.closed, 1));
    assert.equal(host.service.active.editMode, false);
    assert.equal(await fs.readFile(target, "utf8"), "saved:mounted secret plaintext");
    return;
  }
  let releaseJournal; let journalStarted;
  const journalWriting = new Promise((resolve) => { journalStarted = resolve; });
  const write = service.journals.write.bind(service.journals);
  service.journals.write = async (...args) => { journalStarted();
    await new Promise((resolve) => { releaseJournal = resolve; }); return write(...args); };
  if (origin === "lease-refresh-failed") {
    service.fs = { ...fs, async readFile(file, ...args) {
      if (file === target) throw new Error("lease provider failed");
      return fs.readFile(file, ...args);
    } };
    const heartbeat = timers.find((timer) => timer.delay === 120_000);
    assert.ok(heartbeat, "actual edit session scheduled its lease heartbeat");
    heartbeat.callback();
  }
  await Promise.race([starting, new Promise((_, reject) => setTimeout(() =>
    reject(new Error(`${origin} did not start`)), 3_000))]);
  assert.equal(host.generation.capture(), 1);
  assert.equal(editor.value, "", "renderer plaintext is gone before journal cleanup settles");
  assert.equal(ui.getByLabelText(document.body, "Document state").textContent, "Locked");
  assert.equal(service.active.working.content, "mounted secret plaintext",
    "backend cleanup is deliberately still awaiting the journal");
  await journalWriting; releaseJournal();
  const result = await finished;
  assert.equal(result.locked, true); assert.equal(service.active, null);
}

export function lifecycleCaseName(origin) {
  if (origin.startsWith("als-")) {
    const [, entry, stage] = origin.split("-");
    return `ALS-${{ new: "N", open: "O", external: "X" }[entry]} real lock-start during staged ${entry} ${stage}`;
  }
  if (origin.startsWith("al-")) {
    const [, entry, variant] = origin.split("-");
    return `AL-${{ new: "N", open: "O", external: "X", close: "C", exit: "E",
      window: "W" }[entry]} real lock-start during ${entry} ${variant === "dialog"
      ? "open protection dialog" : `${variant} decision await`}`;
  }
  if (origin === "tc-close-no-doc") return "TC Close command on no-document is direct and non-terminating";
  if (origin === "te-exit-once") return "TE Exit command closes exactly once from no-document";
  if (origin === "tw-protect-reentry") return "TW registered window close prevents, protects, retries fault, and reenters once";
  if (origin === "tx-external-before-exit") return "TX active external FIFO is terminally canceled before native exit";
  if (origin.startsWith("rn-")) return `RN-${origin.slice(3)} New replacement ${{
    "picker-cancel": "picker Cancel retains session", mismatch: "mismatch creates no file",
    "create-fault": "pre-authorization native create fault retains session",
    "stage-lease-fault": "pre-authorization candidate lease fault cleans created file",
    "post-authorization-revalidation": "post-authorization revalidation fault retains saved original and cleans canceled candidate",
  }[origin.slice(3)] ?? ""}`;
  if (origin.startsWith("ro-")) return `RO-${origin.slice(3)} Open replacement ${{
    "picker-cancel": "picker Cancel retains session",
    "dialog-cancel": "password dialog Cancel retains session",
    "wrong-password": "wrong password retains session",
    "pre-authorization-revalidation": "pre-authorization revalidation failure retains session",
    "post-authorization-revalidation": "post-authorization revalidation fault retains saved original",
    invitation: "invitation claim Cancel retains session",
  }[origin.slice(3)] ?? ""}`;
  if (origin.startsWith("rx-")) return `RX-${origin.slice(3)} external Open ${{
    retry: "wrong password Retry then opened acknowledgement",
    cancel: "Cancel terminal acknowledgement", "open-ack": "opened terminal acknowledgement",
  }[origin.slice(3)] ?? ""}`;
  if (origin.startsWith("cf-")) return `CF-${origin.slice(3)} conflict ${{
    cancel: "window close Cancel", retry: "window close Retry remains conflict",
    discard: "window close Discard policy blocks changed target",
    merge: "real divergence merge save then close",
    external: "queues external request; resolution releases FIFO and opens it",
    restart: "restart restores conflict merge draft",
  }[origin.slice(3)] ?? ""}`;
  if (origin.startsWith("rw-")) return `RW-${origin.slice(3)} recovered work ${{
    cancel: "window close Cancel", save: "window close Save and publish",
    "save-retry": "window close Save failure then Retry", discard: "window close Discard",
    external: "queues external request; recovery resolution releases FIFO and opens it",
    restart: "restart preserves identical plaintext",
  }[origin.slice(3)] ?? ""}`;
  if (origin === "pp-window-cancel") return "PP-W pending publication window close Cancel retains";
  if (origin === "pp-retry") return "PP-W pending publication Retry unavailable then Retry success";
  if (origin === "pp-discard-refused") return "PP-W pending publication Discard refused while unavailable";
  if (origin === "pp-fifo") return "PP-X pending publication queues external request until resolution releases FIFO";
  if (origin === "pp-restart") return "PP restart preserves exact pending candidate and status";
  if (origin.startsWith("prr-") || origin.startsWith("prc-")) {
    const [, entry, ...outcomeParts] = origin.split("-");
    const outcome = outcomeParts.join("-");
    return `P-S5-${{ new: "N", open: "O", external: "X", close: "C", exit: "E",
      window: "W" }[entry]} provisional ${entry} ${{ cancel: "Cancel retains",
      save: "Seal success", "save-retry": "Seal failure then Retry",
      discard: "Discard restores sealed", "discard-retry": "Discard fault blocks",
    }[outcome]}`;
  }
  if (origin.startsWith("dr-")) {
    const [, entry, ...outcomeParts] = origin.split("-");
    const outcome = outcomeParts.join("-");
    return `D-S4-${{ new: "N", open: "O", external: "X" }[entry]} dirty ${entry} ${{
      cancel: "Cancel retains", save: "Save success", "save-retry": "Save failure then Retry",
      discard: "Discard success", "discard-retry": "Discard failure then Retry",
    }[outcome]}`;
  }
  if (origin.startsWith("dc-")) {
    const [, entry, ...outcomeParts] = origin.split("-");
    const outcome = outcomeParts.join("-");
    return `D-S4-${{ close: "C", exit: "E", window: "W" }[entry]} dirty ${entry} ${{
      cancel: "Cancel retains", save: "Save success", "save-retry": "Save failure then Retry",
      discard: "Discard success", "discard-retry": "Discard failure then Retry",
    }[outcome]}`;
  }
  return origin === "window-close"
    ? "L-S4-W dirty BrowserWindow close: Cancel retains, Save failure focuses retry, success terminates"
    : origin === "external-open"
      ? "L-S4-X dirty external Open: wrong password retains FIFO request, Cancel terminally acks"
      : origin === "new"
        ? "RN-S4 dirty New: picker precedes security, mismatch creates no target, Cancel retains"
        : origin === "new-approved"
          ? "L-S4-N dirty New: protection Cancel preserves session and creates no target"
          : origin === "open"
            ? "L-S4-O dirty Open: authenticated candidate protection Cancel retains authority"
            : origin === "close"
              ? "L-S4-C dirty Close: Cancel retains, Discard reaches no-document shell"
              : origin === "exit"
                ? "L-S4-E dirty Exit: Cancel retains, Discard terminates"
                : origin.startsWith("s0-")
                  ? `L-S0-${{ new: "N", open: "O", external: "X", close: "C",
                    exit: "E", window: "W" }[origin.slice(3)]} no-document ${
                    ["new", "open", "external"].includes(origin.slice(3))
                      ? "successful replacement" : "direct termination behavior"}`
                  : /^s[123]-/.test(origin)
                    ? `L-${origin.slice(0, 2).toUpperCase()}-${{ new: "N", open: "O",
                      external: "X", close: "C", exit: "E", window: "W" }[origin.slice(3)]} ${{
                      s1: "clean read-only", s2: "clean edit", s3: "locked",
                    }[origin.slice(0, 2)]} ${["new", "open", "external"].includes(origin.slice(3))
                      ? "successful replacement releases the prior session" : "direct termination behavior"}`
                    : origin.startsWith("s5-")
                      ? `L-S5-${{ new: "N", open: "O", external: "X", close: "C",
                        exit: "E", window: "W" }[origin.slice(3)]} real provisional revision protection Cancel retains`
                      : origin.startsWith("s6-")
                        ? `L-S6-${{ new: "N", open: "O", external: "X", close: "C",
                          exit: "E", window: "W" }[origin.slice(3)]} INAPPLICABLE-BLOCKED pending-publication modal prevents command; external queues and W protects`
                        : origin.startsWith("s7-")
                          ? `L-S7-${{ new: "N", open: "O", external: "X", close: "C",
                            exit: "E", window: "W" }[origin.slice(3)]} INAPPLICABLE-BLOCKED recovered-work modal prevents command; external queues and W protects`
                          : origin.startsWith("s8-")
                            ? `L-S8-${{ new: "N", open: "O", external: "X", close: "C",
                              exit: "E", window: "W" }[origin.slice(3)]} INAPPLICABLE-BLOCKED conflict modal prevents command; external queues and W protects`
                            : origin.startsWith("s9-")
                              ? `L-S9-${{ new: "N", open: "O", external: "X", close: "C",
                                exit: "E", window: "W" }[origin.slice(3)]} held real publication maintenance serializes then completes lifecycle outcome`
                              : `mounted renderer wired to real DocumentService clears at ${origin} lock start`;
}

const primaryOrigins = ["inactivity", "lease-refresh-failed", "window-close", "external-open",
  "new", "new-approved", "open", "close", "exit", "s0-new", "s0-open", "s0-external",
  "s0-close", "s0-exit", "s0-window",
  ...["s1", "s2", "s3"].flatMap((state) => ["new", "open", "external", "close", "exit",
    "window"].map((entry) => `${state}-${entry}`))];

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const origin of primaryOrigins) {
    test(lifecycleCaseName(origin), (t) => runMountedLock(t, origin));
  }
}
