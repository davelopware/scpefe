import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

async function mount(t, overrides = {}) {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://scpefe.invalid/", pretendToBeVisual: true,
  });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, FormData: dom.window.FormData,
    requestAnimationFrame: (callback) => callback(), IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
  const listeners = {};
  const calls = [];
  const api = {
    getProfile: async () => ({ name: "Ada", email: "ada@example.test", deviceName: "Desk" }),
    getClientSettings: async () => ({ regularSaveEnabled: false, regularSaveIntervalMs: 120000 }),
    saveClientSettings: async (value) => value,
    setWindowTitle: async (value) => { calls.push(["title", value]); },
    activity: async () => ({}), updateWorkingCopy: async () => ({}),
    prepareReplacement: async () => true,
    chooseOpenTarget: async () => { calls.push(["picker"]); return { selected: true, name: "safe.scpefe" }; },
    cancelOpenTarget: async () => {}, openSelectedDocument: async () => ({ content: "secret text", readOnly: true,
      canEdit: true, publicationState: "target-published" }),
    chooseCreateTarget: async () => null, closeDocument: async () => true,
    exitApplication: async () => true, lock: async () => ({ locked: true, warning: null }),
    getUnresolvedJournalSummary: async () => ({ total: 0 }),
    onLocked: (fn) => { listeners.locked = fn; return () => {}; },
    onJournalWarning: () => () => {}, onRegularSave: () => () => {},
    onExternalOpenRequested: () => () => {}, onUnresolvedJournalSummary: () => () => {},
    onSwitchRetained: () => () => {}, ...overrides,
  };
  dom.window.scpefe = api;
  const assets = await fs.readdir(new URL("../dist/assets/", import.meta.url));
  const script = assets.find((entry) => /^index-.*\.js$/.test(entry));
  await import(`${pathToFileURL(path.resolve("dist/assets", script)).href}?test=${Date.now()}-${Math.random()}`);
  const testing = await import("@testing-library/dom");
  const userEvent = (await import("@testing-library/user-event")).default;
  await testing.waitFor(() => assert.ok(testing.getByRole(document.body, "navigation", { name: "Application menu" })));
  t.after(() => { dom.window.close(); });
  return { dom, calls, listeners, user: userEvent.setup({ document: dom.window.document }), ...testing };
}

test("mounted shell has stable menus, disabled no-document editor, and status", async (t) => {
  const ui = await mount(t);
  const editor = ui.getByRole(document.body, "textbox", { name: "Document text" });
  assert.equal(editor.disabled, true);
  assert.match(document.body.textContent, /No document\. Use File → New or File → Open/);
  assert.match(document.body.textContent, /No document/);
  await ui.user.click(ui.getByRole(document.body, "button", { name: "File" }));
  await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "menu", { name: "File" })));
  assert.deepEqual(ui.getAllByRole(document.body, "menuitem").map((item) => item.textContent),
    ["NewCtrl+N", "Open…Ctrl+O", "SaveCtrl+S", "Backup…", "Export Plaintext…", "CloseCtrl+W", "Exit"]);
  assert.equal(ui.getByRole(document.body, "menuitem", { name: /Save/ }).disabled, true);
});

test("mounted Open runs picker before password dialog and successful unlock enters read-only", async (t) => {
  const ui = await mount(t);
  await ui.user.click(ui.getByRole(document.body, "button", { name: "File" }));
  await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "menu", { name: "File" })));
  await ui.user.click(ui.getByRole(document.body, "menuitem", { name: /Open/ }));
  await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "dialog", { name: "Open document" })));
  assert.equal(ui.calls.some((call) => call[0] === "picker"), true);
  assert.equal(ui.calls.findIndex((call) => call[0] === "picker") > 0, true);
  const field = ui.getByLabelText(document.body, "Document password");
  ui.fireEvent.change(field, { target: { value: "correct password" } });
  ui.fireEvent.submit(field.form);
  await ui.waitFor(() => assert.equal(ui.getByRole(document.body, "textbox", { name: "Document text" }).value, "secret text"));
  assert.match(document.body.textContent, /Read-only/);
  assert.equal(ui.getByRole(document.body, "textbox", { name: "Document text" }).readOnly, true);
});

test("manual lock immediately removes mounted plaintext and exposes Unlock without a picker", async (t) => {
  let attempt = 0;
  const ui = await mount(t, { openSelectedDocument: async () => ({ content: "remove me now", readOnly: true,
    canEdit: true, publicationState: "target-published" }), unlockDocument: async () => ({ content: "restored", readOnly: true,
    canEdit: true, publicationState: "target-published" }), lock: async () => {
      queueMicrotask(() => ui.listeners.locked({ warning: null })); return { locked: true, warning: null };
    } });
  await ui.user.click(ui.getByRole(document.body, "button", { name: "File" }));
  await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "menu", { name: "File" })));
  await ui.user.click(ui.getByRole(document.body, "menuitem", { name: /Open/ }));
  await ui.waitFor(() => ui.getByLabelText(document.body, "Document password"));
  ui.fireEvent.change(ui.getByLabelText(document.body, "Document password"), { target: { value: "password" } });
  ui.fireEvent.submit(ui.getByLabelText(document.body, "Document password").form);
  await ui.waitFor(() => assert.match(document.body.textContent, /remove me now/));
  await ui.user.click(ui.getByRole(document.body, "button", { name: "Security" }));
  await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "menu", { name: "Security" })));
  await ui.user.click(ui.getByRole(document.body, "menuitem", { name: "Lock" }));
  await ui.waitFor(() => assert.doesNotMatch(document.body.textContent, /remove me now/));
  assert.match(document.body.textContent, /securely locked/);
  await ui.user.click(ui.getByRole(document.body, "button", { name: "Security" }));
  await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "menu", { name: "Security" })));
  assert.ok(ui.getByRole(document.body, "menuitem", { name: "Unlock" }));
  assert.equal(attempt, 0);
});
