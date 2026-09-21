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
  let protectedNumber = 0; let pendingHost = null; let openCalls = 0;
  const listen = (name, listener) => { listeners[name] = listener;
    return () => { stopped += 1; delete listeners[name]; }; };
  const opened = { content: "original usable plaintext", readOnly: false, canEdit: true,
    publicationState: "target-published", targetName: "current.scpefe" };
  const states = {
    new: { dirty: true, provisional: false, pendingPublication: false,
      recovered: false, conflict: false, unresolvedJournal: true,
      activePublication: false },
    open: { dirty: false, provisional: true, pendingPublication: false,
      recovered: false, conflict: false, unresolvedJournal: false,
      activePublication: false },
    "external-open": { dirty: false, provisional: false, pendingPublication: true,
      recovered: false, conflict: false, unresolvedJournal: true,
      activePublication: false },
    close: { dirty: false, provisional: false, pendingPublication: false,
      recovered: true, conflict: false, unresolvedJournal: true,
      activePublication: false },
    exit: { dirty: false, provisional: false, pendingPublication: true,
      recovered: false, conflict: true, unresolvedJournal: true,
      activePublication: false },
  };
  const requestProtection = (operation) => new Promise((resolve, reject) => {
    const token = `00000000-0000-4000-8000-${String(++protectedNumber).padStart(12, "0")}`;
    pendingHost = { operation, resolve, reject };
    listeners.protection({ token, operation, state: states[operation] });
  });
  dom.window.scpefe = {
    getProfile: async () => ({ name: "Ada", email: "ada@example.test", deviceName: "Desk" }),
    getClientSettings: async () => ({ regularSaveEnabled: false,
      regularSaveIntervalMs: 120000 }),
    getUnresolvedJournalSummary: async () => ({ total: 0, pendingPublications: 0 }),
    saveProfile: async (value) => value, saveClientSettings: async (value) => value,
    activity: async () => ({}), chooseOpenTarget: async () => ({ selected: true,
      name: "current.scpefe" }), cancelOpenTarget: async () => {},
    openSelectedDocument: async () => ++openCalls === 1 ? opened
      : requestProtection("open"), unlockDocument: async () => opened,
    chooseCreateTarget: async () => ({ selected: true }), cancelCreateTarget: async () => {},
    createDocument: async () => requestProtection("new"),
    openExternalDocument: async () => requestProtection("external-open"),
    cancelExternalOpen: async () => true,
    enterEditMode: async () => opened, updateWorkingCopy: async () => ({}),
    saveDocument: async (content) => ({ saved: true, content,
      publicationState: "target-published" }), backupDocument: async () => null,
    exportPlaintext: async () => null, lock: async () =>
      ({ locked: true, journalSaved: true, warning: null }),
    closeDocument: async () => requestProtection("close"),
    exitApplication: async () => requestProtection("exit"),
    resolveProtection: async (request) => {
      decisions.push(request);
      if (request.decision === "save" && failedSave) {
        failedSave = false; return { completed: false, proceed: false,
          retryToken: "20000000-0000-4000-8000-000000000000",
          error: "publication retry failed safely" };
      }
      if (request.decision === "cancel" && pendingHost) {
        const pending = pendingHost; pendingHost = null;
        if (pending.operation === "new" || pending.operation === "open") {
          pending.reject(new Error("The current document remains open"));
        } else pending.resolve(pending.operation === "external-open" ? null : false);
      } else if (pendingHost) {
        const pending = pendingHost; pendingHost = null; pending.resolve(true);
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

  const fileCommand = async (name) => {
    await user.click(ui.getByRole(document.body, "menuitem", { name: "File" }));
    await user.click(ui.getByRole(ui.getByRole(document.body, "menu", { name: "File" }),
      "menuitem", { name }));
  };
  const triggers = [
    ["new", async () => { await fileCommand(/New/);
      const create = await ui.findByRole(document.body, "dialog", { name: "Secure new document" });
      await user.type(ui.getByLabelText(create, "Owner password"), "owner password words");
      await user.type(ui.getByLabelText(create, "Confirm owner password"), "owner password words");
      await user.click(ui.getByLabelText(create,
        "I understand that lost passwords cannot be recovered."));
      await user.click(ui.getByRole(create, "button", { name: "Create" })); }],
    ["open", async () => { await fileCommand(/Open/);
      const open = await ui.findByRole(document.body, "dialog", { name: "Open document" });
      await user.type(ui.getByLabelText(open, "Password"), "password words");
      await user.click(ui.getByRole(open, "button", { name: "Open" })); }],
    ["external-open", async () => { listeners.external({ token:
      "30000000-0000-4000-8000-000000000000" });
      const external = await ui.findByRole(document.body, "dialog",
        { name: "Open requested document" });
      await user.type(ui.getByLabelText(external, "Password"), "password words");
      await user.click(ui.getByRole(external, "button", { name: "Open" })); }],
    ["close", () => fileCommand(/Close/)],
    ["exit", () => fileCommand("Exit")],
  ];
  for (const [operation, trigger] of triggers) {
    await trigger();
    dialog = await ui.findByRole(document.body, "dialog", { name: /Protect current document/ });
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    assert.ok(ui.getAllByRole(dialog, "listitem").length >= 1);
    assert.equal(ui.getByRole(dialog, "alert").textContent.includes("silently lost"), true);
    const keep = ui.getByRole(dialog, "button", { name: "Keep current document open" });
    await ui.waitFor(() => assert.equal(document.activeElement?.textContent,
      "Keep current document open"));
    await user.keyboard("{Escape}");
    assert.equal(ui.getByRole(document.body, "dialog", { name: /Protect/ }) === dialog, true,
      "Escape cannot accidentally dismiss a destructive decision");
    await user.click(keep);
    if (operation === "new") {
      const create = await ui.findByRole(document.body, "dialog", { name: "Secure new document" });
      await user.click(ui.getByRole(create, "button", { name: "Cancel" }));
    } else if (operation === "open") {
      const open = await ui.findByRole(document.body, "dialog", { name: "Open document" });
      await user.click(ui.getByRole(open, "button", { name: "Cancel" }));
    }
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
    assert.equal(editor.value, "unsaved plaintext");
  }

  const mountedMatrix = [
    ["dirty", { dirty: true, provisional: false, pendingPublication: false,
      recovered: false, conflict: false, unresolvedJournal: false,
      activePublication: false }],
    ["provisional", { dirty: false, provisional: true, pendingPublication: false,
      recovered: false, conflict: false, unresolvedJournal: false,
      activePublication: false }],
    ["pending publication", { dirty: false, provisional: false, pendingPublication: true,
      recovered: false, conflict: false, unresolvedJournal: true,
      activePublication: true }],
    ["recovered", { dirty: false, provisional: false, pendingPublication: false,
      recovered: true, conflict: false, unresolvedJournal: true,
      activePublication: false }],
    ["conflict", { dirty: false, provisional: false, pendingPublication: true,
      recovered: false, conflict: true, unresolvedJournal: true,
      activePublication: false }],
  ];
  for (const [stateName, state] of mountedMatrix) {
    for (const [operation, trigger] of triggers) {
      states[operation] = state;
      await trigger();
      dialog = await ui.findByRole(document.body, "dialog", { name: /Protect current document/ });
      assert.equal(ui.getAllByRole(dialog, "listitem").length >= 1, true,
        `${operation} exposes ${stateName} risk through its actual command path`);
      await user.click(ui.getByRole(dialog, "button", { name: "Keep current document open" }));
      if (operation === "new") {
        const create = await ui.findByRole(document.body, "dialog", { name: "Secure new document" });
        await user.click(ui.getByRole(create, "button", { name: "Cancel" }));
      } else if (operation === "open") {
        const open = await ui.findByRole(document.body, "dialog", { name: "Open document" });
        await user.click(ui.getByRole(open, "button", { name: "Cancel" }));
      }
      await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
      assert.equal(editor.value, "unsaved plaintext",
        `${operation} cancellation retains the prior edit session for ${stateName}`);
    }
  }

  states.exit = { dirty: false, provisional: false, pendingPublication: true,
    recovered: false, conflict: true, unresolvedJournal: true,
    activePublication: false };
  await fileCommand("Exit");
  dialog = await ui.findByRole(document.body, "dialog", { name: /before Exit/ });
  const retry = ui.getByRole(dialog, "button", { name: "Retry publication and continue" });
  await user.click(retry);
  await ui.waitFor(() => assert.ok(ui.getByText(dialog,
    /publication retry failed safely/)));
  assert.equal(document.activeElement === retry, true);
  assert.equal(editor.value, "unsaved plaintext");
  await user.click(retry);
  await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));

  await fileCommand(/Close/);
  dialog = await ui.findByRole(document.body, "dialog", { name: /before Close/ });
  await user.click(ui.getByRole(dialog, "button", { name: "Discard and continue" }));
  await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
  assert.equal(editor.value, "unsaved plaintext");

  listeners.closed();
  await ui.waitFor(() => assert.equal(
    ui.getByRole(document.body, "note").textContent.includes("No document"), true));
  assert.equal(editor.value, "");
  assert.equal(decisions.length, 33);
  mountedRoot.unmount(); mountedRoot = null; await Promise.resolve();
  assert.equal(document.getElementById("root").childElementCount, 0);
  assert.equal(stopped, 8); assert.equal(frames.size, 0);
  dom.window.close(); closed = true;
});
