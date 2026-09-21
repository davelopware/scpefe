import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

test("mounted lifecycle protection is accessible, retryable, and retains the session", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>",
    { url: "https://scpefe.invalid/" });
  const keys = ["window", "document", "HTMLElement", "Node", "MutationObserver",
    "FormData", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT"];
  const prior = new Map(keys.map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const frames = new Map(); let frame = 0; let mountedRoot; let closed = false;
  t.after(async () => {
    mountedRoot?.unmount(); await Promise.resolve(); frames.clear();
    if (!closed) dom.window.close();
    for (const [key, descriptor] of prior) descriptor
      ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  const raf = (callback) => { const id = ++frame; frames.set(id, callback);
    queueMicrotask(() => { const next = frames.get(id);
      if (next) { frames.delete(id); next(performance.now()); } }); return id; };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, FormData: dom.window.FormData,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: raf, cancelAnimationFrame: (id) => frames.delete(id),
    IS_REACT_ACT_ENVIRONMENT: true });

  const listeners = {}; const decisions = []; let failedSave = true; let stopped = 0;
  const listen = (name, listener) => { listeners[name] = listener;
    return () => { stopped += 1; delete listeners[name]; }; };
  const opened = { content: "original usable plaintext", readOnly: false, canEdit: true,
    publicationState: "target-published", targetName: "current.scpefe" };
  dom.window.scpefe = {
    getProfile: async () => ({ name: "Ada", email: "ada@example.test", deviceName: "Desk" }),
    getClientSettings: async () => ({ regularSaveEnabled: false,
      regularSaveIntervalMs: 120000 }),
    getUnresolvedJournalSummary: async () => ({ total: 0, pendingPublications: 0 }),
    saveProfile: async (value) => value, saveClientSettings: async (value) => value,
    activity: async () => ({}), chooseOpenTarget: async () => ({ selected: true,
      name: "current.scpefe" }), cancelOpenTarget: async () => {},
    openSelectedDocument: async () => opened, unlockDocument: async () => opened,
    chooseCreateTarget: async () => null, cancelCreateTarget: async () => {},
    createDocument: async () => null, openExternalDocument: async () => null,
    enterEditMode: async () => opened, updateWorkingCopy: async () => ({}),
    saveDocument: async (content) => ({ saved: true, content,
      publicationState: "target-published" }), backupDocument: async () => null,
    exportPlaintext: async () => null, lock: async () =>
      ({ locked: true, journalSaved: true, warning: null }),
    closeDocument: async () => true, exitApplication: async () => true,
    resolveProtection: async (request) => {
      decisions.push(request);
      if (request.decision === "save" && failedSave) {
        failedSave = false; throw new Error("publication retry failed safely");
      }
      return { completed: true, proceed: request.decision !== "cancel" };
    },
    onLocked: (fn) => listen("locked", fn),
    onJournalWarning: (fn) => listen("warning", fn),
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
  await import(`${pathToFileURL(path.resolve("dist/assets", script)).href}?protection`);
  const ui = await import("@testing-library/dom");
  const userEvent = (await import("@testing-library/user-event")).default;
  const user = userEvent.setup({ document: dom.window.document });
  await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "menubar")));
  await user.click(ui.getByRole(document.body, "menuitem", { name: "File" }));
  await user.click(ui.getByRole(ui.getByRole(document.body, "menu", { name: "File" }),
    "menuitem", { name: /Open/ }));
  let dialog = await ui.findByRole(document.body, "dialog", { name: "Open document" });
  await user.type(ui.getByLabelText(dialog, "Password"), "password words");
  await user.click(ui.getByRole(dialog, "button", { name: "Open" }));
  const editor = ui.getByRole(document.body, "textbox", { name: "Document text" });
  await ui.waitFor(() => assert.equal(editor.value, "original usable plaintext"));
  editor.focus();
  ui.fireEvent.change(editor, { target: { value: "unsaved plaintext",
    selectionStart: 17, selectionEnd: 17 } });

  const operations = ["new", "open", "external-open", "close", "exit"];
  for (const [index, operation] of operations.entries()) {
    const focusBefore = document.activeElement;
    listeners.protection({ token: `00000000-0000-4000-8000-00000000000${index}`,
      operation, state: { dirty: true, provisional: true,
        pendingPublication: true, recovered: true, conflict: true,
        unresolvedJournal: true, activePublication: false } });
    dialog = await ui.findByRole(document.body, "dialog", { name: /Protect current document/ });
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    assert.equal(ui.getAllByRole(dialog, "listitem").length, 6);
    assert.equal(ui.getByRole(dialog, "alert").textContent.includes("silently lost"), true);
    const keep = ui.getByRole(dialog, "button", { name: "Keep current document open" });
    assert.equal(document.activeElement === keep, true);
    await user.keyboard("{Escape}");
    assert.equal(ui.getByRole(document.body, "dialog", { name: /Protect/ }) === dialog, true,
      "Escape cannot accidentally dismiss a destructive decision");
    await user.click(keep);
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
    assert.equal(editor.value, "unsaved plaintext");
    await ui.waitFor(() => assert.equal(document.activeElement === focusBefore, true));
  }

  listeners.protection({ token: "10000000-0000-4000-8000-000000000000", operation: "exit",
    state: { dirty: false, provisional: false, pendingPublication: true,
      recovered: false, conflict: false, unresolvedJournal: true,
      activePublication: false } });
  dialog = await ui.findByRole(document.body, "dialog", { name: /before Exit/ });
  const retry = ui.getByRole(dialog, "button", { name: "Retry publication and continue" });
  await user.click(retry);
  await ui.waitFor(() => assert.ok(ui.getByText(dialog,
    /publication retry failed safely/)));
  assert.equal(document.activeElement === retry, true);
  assert.equal(editor.value, "unsaved plaintext");
  await user.click(retry);
  await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));

  listeners.closed();
  await ui.waitFor(() => assert.equal(
    ui.getByRole(document.body, "note").textContent.includes("No document"), true));
  assert.equal(editor.value, "");
  assert.equal(decisions.length, 7);
  mountedRoot.unmount(); mountedRoot = null; await Promise.resolve();
  assert.equal(document.getElementById("root").childElementCount, 0);
  assert.equal(stopped, 8); assert.equal(frames.size, 0);
  dom.window.close(); closed = true;
});
