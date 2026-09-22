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

const capabilities = Object.freeze({ sameFilesystemTransaction: true,
  replacementGuarantee: "atomic-replace" });

export async function runMountedLock(t, origin) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `scpefe-mounted-${origin}-`));
  t.after(() => fs.rm(directory,
    { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
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
  let saveFault = false;
  let discardFault = false;
  let provisionalDiscardFault = false;
  let publicationUnavailable = false;
  let holdMaintenance = false; let releaseMaintenance; let maintenanceStarted;
  const maintenanceEntered = new Promise((resolve) => { maintenanceStarted = resolve; });
  const serviceFs = { ...fs, async rename(source, destination) {
    if (publicationUnavailable && destination === target) {
      const error = new Error("injected publication target unavailable");
      error.code = "EACCES"; throw error;
    }
    if (holdMaintenance && destination === target) {
      maintenanceStarted();
      await new Promise((resolve) => { releaseMaintenance = resolve; });
      holdMaintenance = false;
    }
    return fs.rename(source, destination);
  }, async unlink(file) {
    if (discardFault && file.startsWith(path.join(directory, "journals"))) {
      const error = new Error("injected journal discard failure");
      error.code = "EIO"; throw error;
    }
    return fs.unlink(file);
  } };
  const openedContent = (bytes) => bytes.toString() === "other-container" ? "other plaintext"
    : /^(saved|provisional):/.test(bytes.toString())
      ? bytes.toString().replace(/^[^:]+:/, "") : "original plaintext";
  const native = { openDocument(bytes, password) {
    if (password === "wrong password") throw new Error("authentication failed");
    const revision = createHash("sha256").update(bytes).digest("hex");
    return { content: openedContent(bytes), readOnly: true,
    canEdit: true, manuallySealed: !bytes.toString().startsWith("provisional:"),
    documentId: bytes.toString().startsWith("other") ? "62".repeat(16) : "61".repeat(16),
    baseRevision: revision,
    revisionGraph: [{ revisionId: revision, parentRevisionIds: [] }],
    journalKey: Buffer.alloc(32, bytes.toString().startsWith("other") ? 0x64 : 0x63),
    lease: { ...(bytes.toString().startsWith("other") ? { active: false,
      sessionId: "0".repeat(32), heartbeatCounter: 0, holderUtcMs: 0,
      durationMs: 600_000, holderName: "", holderEmail: "", deviceName: "" } : lease) } };
  }, updateLease(bytes, _password, next) { lease = { ...next }; return Buffer.from(bytes); },
  createDocument() { lease = { active: false, sessionId: "0".repeat(32),
    heartbeatCounter: 0, holderUtcMs: 0, durationMs: 600_000,
    holderName: "", holderEmail: "", deviceName: "" }; return Buffer.from("saved:"); },
  saveDocument(_bytes, _password, input) {
    if (saveFault) throw new Error("injected native save failure");
    return Buffer.from(`saved:${input.content}`);
  }, regularSaveDocument(_bytes, _password, input) {
    return Buffer.from(`provisional:${input.content}`);
  }, discardProvisional() {
    if (provisionalDiscardFault) throw new Error("injected provisional discard failure");
    return Buffer.from("saved:original plaintext");
  } };
  const serviceOptions = (callbacks = {}) => ({ native, fs: serviceFs, profilePath,
    publicationCapabilities: capabilities,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    inactivityMs: origin === "inactivity" ? 1_500 : 999_999,
    ...(origin === "lease-refresh-failed" ? { setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} }; timers.push(timer); return timer;
    }, clearTimer() {} } : {}), ...callbacks });
  const timers = []; const acks = [];
  const ipcListeners = new Map(); const ipcHandlers = new Map();
  const emit = (channel, value) => {
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
  const fakeWindow = new FakeWindow(); let createPickerCalls = 0;
  let restartCandidateHash = null;
  if (origin.startsWith("s7-")) {
    const crashed = new DocumentService(serviceOptions());
    await crashed.openDocument(target, "password words");
    await crashed.enterEditMode();
    crashed.updateWorkingCopy({ content: "restart recovered plaintext",
      cursor: { start: 27, end: 27 } });
    await crashed.lock("process-restart");
  }
  if (origin.startsWith("s8-")) {
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
        || origin.startsWith("s5-") || origin.startsWith("s9-")
        || origin.startsWith("dr-new-") || origin.startsWith("prr-new-")
        ? newTarget : null;
    },
      chooseOpenTarget: async () => origin === "s0-open" ? null
        : (origin.startsWith("dr-open-") || origin.startsWith("prr-open-"))
          && createPickerCalls++ > 0 ? otherTarget : target },
    serviceFactory: (callbacks) => new DocumentService(serviceOptions(callbacks)),
    acknowledge: async (request, status, sequence) => {
      acks.push({ token: request.token, status, sequence });
    },
  }).start();
  let service = host.service;

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
  t.after(async () => { mountedRoot?.unmount(); await Promise.resolve(); frames.clear();
    dom.window.close(); for (const [key, descriptor] of prior) descriptor
      ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  const invoke = async (channel, value) => {
    const handler = ipcHandlers.get(channel);
    if (!handler) return null;
    return handler({}, value);
  };
  const preload = await fs.readFile(new URL("../dist/preload.cjs", import.meta.url), "utf8");
  vm.runInNewContext(preload, { Buffer, setTimeout,
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
  await import(`${pathToFileURL(path.resolve("dist/assets", script)).href}?real-lock-${origin}`);
  const ui = await import("@testing-library/dom");
  const userEvent = (await import("@testing-library/user-event")).default;
  const user = userEvent.setup({ document: dom.window.document });
  await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "menubar")));
  await ui.waitFor(() => assert.ok(
    ipcListeners.get("document:external-open-requested")?.size));
  const command = async (menu, name) => { await user.click(ui.getByRole(document.body,
    "menuitem", { name: menu })); await user.click(ui.getByRole(
    ui.getByRole(document.body, "menu", { name: menu }), "menuitem", { name })); };
  const editor = ui.getByRole(document.body, "textbox", { name: "Document text" });
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
    await ui.waitFor(() => assert.equal(ui.getByLabelText(document.body,
      "Document state").textContent, expectedState));
  };
  const driveProtectedCancel = async (entry) => {
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
      await host.setReady(); host.enqueueExternal({ target, source: "second-instance" });
      const opened = await ui.findByRole(document.body, "dialog",
        { name: "Open requested document" });
      await user.type(ui.getByLabelText(opened, "Password"), "password words");
      await user.click(ui.getByRole(opened, "button", { name: "Open" }));
    } else if (entry === "close") await command("File", /Close/);
    else if (entry === "exit") await command("File", "Exit");
    else { const event = fakeWindow.close(); assert.equal(event.prevented, true); }
    const title = entry === "new" ? /before New/ : ["open", "external"].includes(entry)
      ? /before Open/ : entry === "close" ? /before Close/ : /before Exit/;
    const protection = await ui.findByRole(document.body, "dialog", { name: title });
    const keep = ui.getByRole(protection, "button", { name: "Keep current document open" });
    assert.equal(document.activeElement, keep); await user.click(keep);
    await ui.waitFor(() => assert.equal(
      ui.queryByRole(document.body, "dialog", { name: title }), null));
    const returned = ui.queryByRole(document.body, "dialog");
    if (returned) {
      const cancel = ui.queryByRole(returned, "button", { name: "Cancel" });
      if (cancel) await user.click(cancel);
    }
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
  };
  if (origin.startsWith("s0-")) {
    const entry = origin.slice(3);
    if (entry === "new") {
      await command("File", /New/); assert.equal(createPickerCalls, 1);
      assert.equal(ui.queryByRole(document.body, "dialog"), null);
    } else if (entry === "open") {
      await command("File", /Open/); assert.equal(ui.queryByRole(document.body, "dialog"), null);
    } else if (entry === "external") {
      await host.setReady(); const request = host.enqueueExternal({ target,
        source: "second-instance" });
      const dialog = await ui.findByRole(document.body, "dialog",
        { name: "Open requested document" });
      await user.click(ui.getByRole(dialog, "button", { name: "Cancel" }));
      await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
      assert.equal(host.externalRequests.current(request.token), null);
      assert.deepEqual(acks.map(({ status }) => status), ["queued", "presented", "canceled"]);
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
  await command("File", /Open/);
  let dialog = await ui.findByRole(document.body, "dialog", { name: "Open document" });
  await user.type(ui.getByLabelText(dialog, "Password"), "password words");
  await user.click(ui.getByRole(dialog, "button", { name: "Open" }));
  await ui.waitFor(() => assert.equal(ui.getByLabelText(document.body,
    "Document state").textContent, "Read-only"));
  if (origin === "pp-restart") {
    const pending = await ui.findByRole(document.body, "dialog",
      { name: "Manual save pending publication" });
    assert.equal(editor.value, "");
    assert.equal(host.service.active.opened.content, "restart pending plaintext");
    assert.equal(host.service.active.opened.publicationState, "pending-publication");
    assert.equal(host.service.active.pendingRecord.publication.candidateHash,
      restartCandidateHash);
    await user.click(ui.getByRole(pending, "button", { name: "Retry publication" }));
    assert.equal(host.service.active.pendingRecord.publication.candidateHash,
      restartCandidateHash);
    assert.equal(host.service.active.opened.publicationState, "pending-publication");
    return;
  }
  if (origin.startsWith("s7-") || origin.startsWith("s8-")) {
    const divergent = origin.startsWith("s8-");
    if (divergent) {
      const head = await ui.findByRole(document.body, "dialog",
        { name: "This target has diverged" });
      await user.click(ui.getByRole(head, "button",
        { name: "Accept current authenticated head" }));
    }
    const recovery = await ui.findByRole(document.body, "dialog",
      { name: divergent ? "Divergence needs resolution" : "Recovered work" });
    assert.equal(editor.value, "",
      "a blocking recovery decision retains but does not expose plaintext behind its overlay");
    const entry = origin.slice(3);
    if (entry === "external") {
      await host.setReady(); const request = host.enqueueExternal({ target,
        source: "second-instance" });
      await ui.waitFor(() => assert.equal(
        host.externalRequests.current(request.token)?.token, request.token));
      assert.deepEqual(acks.map(({ status }) => status), ["queued", "presented"]);
    } else if (entry === "window") {
      const event = fakeWindow.close(); assert.equal(event.prevented, true);
      const protection = await ui.findByRole(document.body, "dialog", { name: /before Exit/ });
      await user.click(ui.getByRole(protection, "button",
        { name: "Keep current document open" }));
      await fakeWindow.lastClose;
      assert.equal(fakeWindow.closed, 0);
    } else {
      await command("File", entry === "new" ? /New/ : entry === "open" ? /Open/
        : entry === "close" ? /Close/ : "Exit");
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
    await driveDirect(origin.slice(3), "Read-only"); return;
  }
  await command("Edit", "Edit Contents");
  await ui.waitFor(() => assert.equal(ui.getByLabelText(document.body,
    "Document state").textContent, "Edit mode"));
  service = host.service;
  const originalLockStart = service.onLockStart;
  service.onLockStart = (value) => { assert.equal(value.reason, origin.startsWith("s3-")
    ? "app-lock" : origin === "close" || origin.endsWith("-close")
      || origin.startsWith("dc-close-") || origin.startsWith("prc-close-")
      ? "document-close" : origin);
    originalLockStart(value); lockStarted(); };
  const originalLocked = service.onLocked;
  service.onLocked = (result) => { originalLocked(result); lockFinished(result); };
  if (origin.startsWith("s2-")) {
    await driveDirect(origin.slice(3), "Edit mode", origin.endsWith("window")); return;
  }
  if (origin.startsWith("s3-")) {
    await command("Security", "Lock");
    await ui.waitFor(() => assert.equal(ui.getByLabelText(document.body,
      "Document state").textContent, "Locked"));
    await driveDirect(origin.slice(3), "Locked"); return;
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
    await user.click(ui.getByRole(protection, "button", { name: decision }));
    if (outcome.endsWith("retry")) {
      await ui.findByText(protection, outcome.startsWith("save")
        ? /injected native save failure/ : provisionalDecision
          ? /injected provisional discard failure/ : /injected journal discard failure/);
      assert.equal(host.service === service, true); assert.equal(editor.value,
        "mounted secret plaintext");
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(document.querySelector("[role=dialog]") === null, true);
    assert.equal(host.service === service, false);
    assert.equal(editor.value, entry === "new" ? "" : "other plaintext");
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
    await user.click(ui.getByRole(protection, "button", { name: decision }));
    if (outcome.endsWith("retry")) {
      const message = outcome.startsWith("save") ? /injected native save failure/
        : provisionalDecision ? /injected provisional discard failure/
          : /injected journal discard failure/;
      await ui.findByText(protection, message);
      assert.equal(editor.value, "mounted secret plaintext"); assert.equal(fakeWindow.closed, 0);
      if (provisionalDecision && outcome === "discard-retry") {
        protection = ui.getByRole(document.body, "dialog",
          { name: entry === "close" ? /before Close/ : /before Exit/ });
        await user.click(ui.getByRole(protection, "button",
          { name: "Keep current document open" }));
        await ui.waitFor(() => assert.equal(
          document.querySelector("[role=dialog]") === null, true));
        assert.equal(fakeWindow.closed, 0); return;
      }
      saveFault = false; discardFault = false; provisionalDiscardFault = false;
      protection = ui.getByRole(document.body, "dialog",
        { name: entry === "close" ? /before Close/ : /before Exit/ });
      await user.click(ui.getByRole(protection, "button", { name: decision }));
    }
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
    if (entry === "open" || entry === "external") {
      let request;
      if (entry === "open") await command("File", /Open/);
      else { await host.setReady(); request = host.enqueueExternal({ target,
        source: "second-instance" }); }
      const staged = await ui.findByRole(document.body, "dialog",
        { name: entry === "open" ? "Open document" : "Open requested document" });
      assert.ok(document.body.contains(staged),
        "the selected replacement remains staged while real maintenance is active");
      assert.equal(ui.queryByRole(document.body, "dialog", { name: /before Open/ }), null);
      await user.click(ui.getByRole(staged, "button", { name: "Cancel" }));
      releaseMaintenance(); await publishing;
      await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
      if (request) await ui.waitFor(() => assert.equal(
        host.externalRequests.current(request.token), null));
    } else {
      await driveProtectedCancel(entry);
      releaseMaintenance(); await publishing;
    }
    assert.equal(fakeWindow.closed, 0);
    assert.equal(editor.value, "mounted secret plaintext");
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
      await ui.findByText(protection, /injected publication target unavailable/i);
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
    if (entry === "external") {
      await host.setReady(); const request = host.enqueueExternal({ target,
        source: "second-instance" });
      await ui.waitFor(() => assert.equal(
        host.externalRequests.current(request.token)?.token, request.token));
      assert.deepEqual(acks.map(({ status }) => status), ["queued", "presented"]);
    } else if (entry === "window") {
      const event = fakeWindow.close(); assert.equal(event.prevented, true);
      assert.equal(fakeWindow.closed, 0);
    } else {
      await command("File", entry === "new" ? /New/ : entry === "open" ? /Open/
        : entry === "close" ? /Close/ : "Exit");
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
    assert.equal(editor.value, "mounted secret plaintext");
    await user.click(ui.getByRole(protection, "button", { name: "Keep current document open" }));
    const returned = await ui.findByRole(document.body, "dialog", { name: "Open document" });
    assert.equal(editor.value, "mounted secret plaintext");
    assert.equal(host.service, service);
    await user.click(ui.getByRole(returned, "button", { name: "Cancel" }));
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
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
    assert.equal(editor.value, "mounted secret plaintext");
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
    assert.equal(await fs.stat(newTarget).then(() => true, () => false), false);
    assert.equal(editor.value, "mounted secret plaintext");
    await user.click(ui.getByRole(protection, "button", { name: "Keep current document open" }));
    const returned = await ui.findByRole(document.body, "dialog",
      { name: "Secure new document" });
    assert.equal(await fs.stat(newTarget).then(() => true, () => false), false);
    assert.equal(editor.value, "mounted secret plaintext");
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
    await ui.findByText(retryProtection, /injected native save failure/);
    saveFault = false;
    await user.click(ui.getByRole(retryProtection, "button",
      { name: "Manual save and continue" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(document.querySelector(".dialog-error")?.textContent ?? "", "");
    assert.equal(document.querySelector("[role=dialog]") === null, true);
    assert.equal(host.service === service, false);
    assert.equal(await fs.stat(newTarget).then(() => true, () => false), true);
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
    assert.equal(editor.value, "mounted secret plaintext");
    assert.deepEqual(acks.map(({ status }) => status), ["queued", "presented"]);
    assert.equal(host.externalRequests.current(request.token).token, request.token);
    await user.click(ui.getByRole(externalDialog, "button", { name: "Cancel" }));
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
    assert.equal(editor.value, "mounted secret plaintext");
    assert.deepEqual(acks.map(({ status }) => status), ["queued", "presented", "canceled"]);
    assert.equal(host.externalRequests.current(request.token), null);
    return;
  }
  if (origin === "window-close") {
    const first = fakeWindow.close();
    assert.equal(first.prevented, true);
    let protection = await ui.findByRole(document.body, "dialog", { name: /before Exit/ });
    assert.equal(editor.value, "mounted secret plaintext");
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
      /injected native save failure/).textContent, /injected native save failure/));
    assert.equal(fakeWindow.closed, 0); assert.equal(editor.value, "mounted secret plaintext");
    assert.equal(document.activeElement, save);
    saveFault = false; await user.click(save);
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
                    exit: "E", window: "W" }[origin.slice(3)]} no-document direct lifecycle behavior`
                  : /^s[123]-/.test(origin)
                    ? `L-${origin.slice(0, 2).toUpperCase()}-${{ new: "N", open: "O",
                      external: "X", close: "C", exit: "E", window: "W" }[origin.slice(3)]} ${{
                      s1: "clean read-only", s2: "clean edit", s3: "locked",
                    }[origin.slice(0, 2)]} direct lifecycle behavior`
                    : origin.startsWith("s5-")
                      ? `L-S5-${{ new: "N", open: "O", external: "X", close: "C",
                        exit: "E", window: "W" }[origin.slice(3)]} real provisional revision protection Cancel retains`
                      : origin.startsWith("s6-")
                        ? `L-S6-${{ new: "N", open: "O", external: "X", close: "C",
                          exit: "E", window: "W" }[origin.slice(3)]} real pending publication blocks lifecycle and retains plaintext`
                        : origin.startsWith("s7-")
                          ? `L-S7-${{ new: "N", open: "O", external: "X", close: "C",
                            exit: "E", window: "W" }[origin.slice(3)]} process-restart recovered work blocks lifecycle and retains journal`
                          : origin.startsWith("s8-")
                            ? `L-S8-${{ new: "N", open: "O", external: "X", close: "C",
                              exit: "E", window: "W" }[origin.slice(3)]} real divergent publication blocks lifecycle and retains both branches`
                            : origin.startsWith("s9-")
                              ? `L-S9-${{ new: "N", open: "O", external: "X", close: "C",
                                exit: "E", window: "W" }[origin.slice(3)]} held real publication maintenance serializes lifecycle Cancel`
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
