import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { DocumentService } from "../src/document-service.mjs";
import { SessionGeneration } from "../src/session-generation.mjs";

const capabilities = Object.freeze({ sameFilesystemTransaction: true,
  replacementGuarantee: "atomic-replace" });

async function runMountedLock(t, origin) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `scpefe-mounted-${origin}-`));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(target, "container");
  await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
    email: "ada@example.test", deviceName: "Desk" }));
  let lease = { active: false, sessionId: "0".repeat(32), heartbeatCounter: 0,
    holderUtcMs: 0, durationMs: 600_000, holderName: "", holderEmail: "", deviceName: "" };
  const native = { openDocument() { return { content: "original plaintext", readOnly: true,
    canEdit: true, manuallySealed: true, documentId: "61".repeat(16),
    baseRevision: "62".repeat(32),
    revisionGraph: [{ revisionId: "62".repeat(32), parentRevisionIds: [] }],
    journalKey: Buffer.alloc(32, 0x63), lease: { ...lease } };
  }, updateLease(bytes, _password, next) { lease = { ...next }; return Buffer.from(bytes); } };
  const timers = []; const ipcListeners = new Map(); const generation = new SessionGeneration();
  const emit = (channel, value) => {
    for (const listener of ipcListeners.get(channel) ?? []) listener({}, value);
  };
  let lockStarted; const starting = new Promise((resolve) => { lockStarted = resolve; });
  let lockFinished; const finished = new Promise((resolve) => { lockFinished = resolve; });
  const service = new DocumentService({ native, fs, profilePath, publicationCapabilities: capabilities,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    inactivityMs: origin === "inactivity" ? 1_500 : 999_999,
    ...(origin === "lease-refresh-failed" ? { setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} }; timers.push(timer); return timer;
    }, clearTimer() {} } : {}),
    onLockStart: ({ reason }) => { assert.equal(reason, origin); generation.invalidate();
      emit("document:lock-started"); lockStarted(); },
    onLocked: (result) => { emit("document:locked", result); lockFinished(result); } });

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
    if (channel === "profile:get") return service.loadProfile();
    if (channel === "profile:save") return service.saveProfile(value);
    if (channel === "settings:get") return service.loadClientSettings();
    if (channel === "settings:save") return service.saveClientSettings(value);
    if (channel === "journal:summary") return service.unresolvedJournalSummary();
    if (channel === "document:choose-open-target") {
      return { selected: true, name: "document.scpefe" };
    }
    if (channel === "document:open-selected" || channel === "document:unlock") {
      return { ...await service.openDocument(target, value), targetName: "document.scpefe" };
    }
    if (channel === "document:enter-edit-mode") return service.enterEditMode();
    if (channel === "document:update-working-copy") return service.updateWorkingCopy(value);
    if (channel === "document:activity") return service.notifyActivity();
    if (channel === "document:lock") return service.lock("app-lock");
    return null;
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
  const command = async (menu, name) => { await user.click(ui.getByRole(document.body,
    "menuitem", { name: menu })); await user.click(ui.getByRole(
    ui.getByRole(document.body, "menu", { name: menu }), "menuitem", { name })); };
  await command("File", /Open/);
  let dialog = await ui.findByRole(document.body, "dialog", { name: "Open document" });
  await user.type(ui.getByLabelText(dialog, "Password"), "password words");
  await user.click(ui.getByRole(dialog, "button", { name: "Open" }));
  await ui.waitFor(() => assert.equal(ui.getByLabelText(document.body,
    "Document state").textContent, "Read-only"));
  await command("Edit", "Edit Contents");
  await ui.waitFor(() => assert.equal(ui.getByLabelText(document.body,
    "Document state").textContent, "Edit mode"));
  const editor = ui.getByRole(document.body, "textbox", { name: "Document text" });
  ui.fireEvent.change(editor, { target: { value: "mounted secret plaintext",
    selectionStart: 24, selectionEnd: 24 } });
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
  assert.equal(generation.capture(), 1);
  assert.equal(editor.value, "", "renderer plaintext is gone before journal cleanup settles");
  assert.equal(ui.getByLabelText(document.body, "Document state").textContent, "Locked");
  assert.equal(service.active.working.content, "mounted secret plaintext",
    "backend cleanup is deliberately still awaiting the journal");
  await journalWriting; releaseJournal();
  const result = await finished;
  assert.equal(result.locked, true); assert.equal(service.active, null);
}

for (const origin of ["inactivity", "lease-refresh-failed"]) {
  test(`mounted renderer wired to real DocumentService clears at ${origin} lock start`,
    (t) => runMountedLock(t, origin));
}
