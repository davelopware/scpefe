import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const entries = ["New", "Open", "external Open", "Close", "Exit", "window close"];
const decisions = ["Cancel", "Save success", "Save failure then Retry success",
  "publication Retry failure then success", "conflict Resolve/continue",
  "Discard allowed", "Discard blocked", "post-approval failure retaining original",
  "auto-lock during dialog", "auto-lock during post-approval await"];

async function mountedCase(t, entry, outcome, serial) {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>",
    { url: "https://scpefe.invalid/" });
  const keys = ["window", "document", "HTMLElement", "Node", "MutationObserver",
    "FormData", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT"];
  const prior = new Map(keys.map((key) => [key,
    Object.getOwnPropertyDescriptor(globalThis, key)]));
  const frames = new Map(); let frame = 0; let mountedRoot; let stopped = 0;
  const raf = (callback) => { const id = ++frame; frames.set(id, callback);
    queueMicrotask(() => { const next = frames.get(id);
      if (next) { frames.delete(id); next(performance.now()); } }); return id; };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, FormData: dom.window.FormData,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: raf, cancelAnimationFrame: (id) => frames.delete(id),
    IS_REACT_ACT_ENVIRONMENT: true });
  t.after(async () => {
    mountedRoot?.unmount(); await Promise.resolve(); frames.clear(); dom.window.close();
    for (const [key, descriptor] of prior) descriptor
      ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });

  const listeners = {}; let pending; let protectionCount = 0; let failures = 0;
  let postApprovalRelease; let postApprovalStarted;
  const postApprovalWaiting = new Promise((resolve) => { postApprovalStarted = resolve; });
  const opened = { content: "authoritative original", readOnly: false, canEdit: true,
    publicationState: "target-published", targetName: "original.scpefe" };
  const state = outcome.startsWith("publication")
    ? { dirty: false, provisional: false, pendingPublication: true, recovered: false,
      conflict: false, unresolvedJournal: true, activePublication: false }
    : outcome.startsWith("conflict")
      ? { dirty: false, provisional: false, pendingPublication: true, recovered: false,
        conflict: true, unresolvedJournal: true, activePublication: false }
      : { dirty: true, provisional: false, pendingPublication: false, recovered: false,
        conflict: false, unresolvedJournal: true, activePublication: false };
  if (outcome.includes("failure then") || outcome === "Discard blocked") failures = 1;
  const protect = (operation) => new Promise((resolve, reject) => {
    const token = `60000000-0000-4000-8000-${String(++protectionCount).padStart(12, "0")}`;
    pending = { resolve, reject, operation };
    listeners.protection({ token, operation, state });
  });
  const afterProtection = async (operation) => {
    const proceed = await protect(operation);
    if (!proceed) return null;
    if (outcome === "auto-lock during post-approval await") {
      postApprovalStarted();
      await new Promise((resolve) => { postApprovalRelease = resolve; });
      throw new Error("staged result fenced after lock");
    }
    if (outcome === "post-approval failure retaining original") {
      throw new Error(`${operation} candidate revalidation failed`);
    }
    return opened;
  };
  const listen = (name, listener) => { listeners[name] = listener;
    return () => { stopped += 1; delete listeners[name]; }; };
  let initialOpen = true;
  dom.window.scpefe = {
    getProfile: async () => ({ name: "Ada", email: "ada@example.test", deviceName: "Desk" }),
    getClientSettings: async () => ({ regularSaveEnabled: false,
      regularSaveIntervalMs: 120000 }),
    getUnresolvedJournalSummary: async () => ({ total: 0, pendingPublications: 0 }),
    saveProfile: async (value) => value, saveClientSettings: async (value) => value,
    activity: async () => ({}), chooseOpenTarget: async () => ({ selected: true,
      name: "original.scpefe" }), cancelOpenTarget: async () => {},
    openSelectedDocument: async () => {
      if (initialOpen) { initialOpen = false; return opened; }
      return afterProtection("open");
    }, unlockDocument: async () => opened,
    chooseCreateTarget: async () => ({ selected: true }), cancelCreateTarget: async () => {},
    createDocument: async () => afterProtection("new"),
    openExternalDocument: async () => afterProtection("external-open"),
    cancelExternalOpen: async () => true, enterEditMode: async () => opened,
    updateWorkingCopy: async () => ({}), saveDocument: async () => ({}),
    backupDocument: async () => null, exportPlaintext: async () => null,
    lock: async () => ({ locked: true, journalSaved: true, warning: null }),
    closeDocument: async () => afterProtection("close"),
    exitApplication: async () => afterProtection("exit"),
    resolveProtection: async (request) => {
      if ((request.decision === "save" || request.decision === "discard") && failures > 0) {
        failures -= 1;
        return { completed: false, proceed: false,
          retryToken: `70000000-0000-4000-8000-${String(serial).padStart(12, "0")}`,
          error: request.decision === "discard" ? "discard blocked safely"
            : "publication failed safely" };
      }
      const proceed = request.decision !== "cancel";
      pending?.resolve(proceed); pending = null;
      return { completed: true, proceed };
    },
    onLocked: (fn) => listen("locked", fn), onJournalWarning: (fn) => listen("warning", fn),
    onRegularSave: (fn) => listen("regular", fn),
    onExternalOpenRequested: (fn) => listen("external", fn),
    onUnresolvedJournalSummary: (fn) => listen("summary", fn),
    onSwitchRetained: (fn) => listen("retained", fn),
    onProtectionRequested: (fn) => listen("protection", fn),
    onDocumentClosed: (fn) => listen("closed", fn),
  };
  dom.window[Symbol.for("scpefe.renderer.mount")] = (root) => { mountedRoot = root; };
  const assets = await fs.readdir(new URL("../dist/assets/", import.meta.url));
  const script = assets.find((entry) => /^index-.*\.js$/.test(entry));
  await import(`${pathToFileURL(path.resolve("dist/assets", script)).href}?decision-${serial}`);
  const ui = await import("@testing-library/dom");
  const userEvent = (await import("@testing-library/user-event")).default;
  const user = userEvent.setup({ document: dom.window.document });
  await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "menubar")));
  const file = async (name) => { await user.click(ui.getByRole(document.body, "menuitem",
    { name: "File" })); await user.click(ui.getByRole(
    ui.getByRole(document.body, "menu", { name: "File" }), "menuitem", { name })); };
  await file(/Open/);
  let dialog = await ui.findByRole(document.body, "dialog", { name: "Open document" });
  await user.type(ui.getByLabelText(dialog, "Password"), "password words");
  await user.click(ui.getByRole(dialog, "button", { name: "Open" }));
  const editor = ui.getByRole(document.body, "textbox", { name: "Document text" });
  await ui.waitFor(() => assert.equal(editor.value, "authoritative original"));
  ui.fireEvent.change(editor, { target: { value: "authoritative unsaved plaintext",
    selectionStart: 31, selectionEnd: 31 } });

  if (entry === "New") {
    await file(/New/); dialog = await ui.findByRole(document.body, "dialog",
      { name: "Secure new document" });
    await user.type(ui.getByLabelText(dialog, "Owner password"), "owner password words");
    await user.type(ui.getByLabelText(dialog, "Confirm owner password"), "owner password words");
    await user.click(ui.getByLabelText(dialog,
      "I understand that lost passwords cannot be recovered."));
    await user.click(ui.getByRole(dialog, "button", { name: "Create" }));
  } else if (entry === "Open") {
    await file(/Open/); dialog = await ui.findByRole(document.body, "dialog",
      { name: "Open document" });
    await user.type(ui.getByLabelText(dialog, "Password"), "password words");
    await user.click(ui.getByRole(dialog, "button", { name: "Open" }));
  } else if (entry === "external Open") {
    listeners.external({ token: `80000000-0000-4000-8000-${String(serial).padStart(12, "0")}` });
    dialog = await ui.findByRole(document.body, "dialog", { name: "Open requested document" });
    await user.type(ui.getByLabelText(dialog, "Password"), "password words");
    await user.click(ui.getByRole(dialog, "button", { name: "Open" }));
  } else if (entry === "Close") await file(/Close/);
  else if (entry === "Exit") await file("Exit");
  else {
    pending = { operation: "exit", reject() {}, resolve(proceed) {
      if (proceed && outcome === "auto-lock during post-approval await") postApprovalStarted();
    } };
    listeners.protection({ token:
      `90000000-0000-4000-8000-${String(serial).padStart(12, "0")}`,
    operation: "exit", state });
  }

  dialog = await ui.findByRole(document.body, "dialog", { name: /Protect current document/ });
  assert.equal(editor.value, "authoritative unsaved plaintext");
  assert.equal(document.activeElement?.textContent, "Keep current document open");
  if (outcome === "auto-lock during dialog") {
    listeners.locked({ locked: true, journalSaved: true, warning: null });
    assert.equal(editor.value, "");
    assert.equal(ui.getByLabelText(document.body, "Document state").textContent, "Locked");
  } else {
    const decision = outcome === "Cancel" ? "cancel"
      : outcome.startsWith("Discard") ? "discard" : "save";
    const name = decision === "cancel" ? "Keep current document open"
      : decision === "discard" ? "Discard and continue"
        : state.pendingPublication ? "Retry publication and continue" : "Manual save and continue";
    const action = ui.getByRole(dialog, "button", { name });
    await user.click(action);
    if (outcome.includes("failure then") || outcome === "Discard blocked") {
      const expectedError = outcome === "Discard blocked"
        ? "discard blocked safely" : "publication failed safely";
      await ui.waitFor(() => assert.ok(ui.getByText(dialog, expectedError)));
      assert.equal(document.activeElement, action);
      if (outcome === "Discard blocked") {
        await user.click(ui.getByRole(dialog, "button", { name: "Keep current document open" }));
      } else await user.click(action);
    }
    if (outcome === "auto-lock during post-approval await") {
      await postApprovalWaiting;
      listeners.locked({ locked: true, journalSaved: true, warning: null });
      postApprovalRelease?.();
      await ui.waitFor(() => assert.equal(editor.value, ""));
    } else if (outcome === "Cancel" || outcome === "Discard blocked"
        || outcome === "post-approval failure retaining original") {
      await ui.waitFor(() => assert.equal(editor.value, "authoritative unsaved plaintext"));
    }
  }
  assert.ok(ui.getByRole(document.body, "status"));
  mountedRoot.unmount(); mountedRoot = null; await Promise.resolve();
  assert.equal(stopped, 8); assert.equal(frames.size, 0);
}

test("mounted lifecycle decision/fault manifest", async (t) => {
  let serial = 0;
  for (const entry of entries) for (const decision of decisions) {
    await t.test(`mounted DECISION/FAULT | ${entry} | ${decision}`,
      (t) => mountedCase(t, entry, decision, ++serial));
  }
});
