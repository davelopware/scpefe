import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

test("mounted profile draft keeps focus until the current document admission decision", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>",
    { url: "https://scpefe.invalid/" });
  const keys = ["window", "document", "HTMLElement", "Node", "MutationObserver",
    "FormData", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT"];
  const prior = new Map(keys.map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const frames = new Map(); let frame = 0; let mountedRoot;
  t.after(async () => {
    mountedRoot?.unmount(); await Promise.resolve(); frames.clear(); dom.window.close();
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

  const listeners = {};
  const listen = (name, listener) => { listeners[name] = listener;
    return () => { delete listeners[name]; }; };
  const opened = { content: "current document", readOnly: true, canEdit: true,
    publicationState: "target-published", targetName: "current.scpefe" };
  dom.window.scpefe = {
    getProfile: async () => ({ name: "Ada", email: "ada@example.test", deviceName: "Desk" }),
    getClientSettings: async () => ({ regularSaveEnabled: false,
      regularSaveIntervalMs: 120000 }),
    getUnresolvedJournalSummary: async () => ({ total: 0, pendingPublications: 0 }),
    saveProfile: async (value) => value, saveClientSettings: async (value) => value,
    activity: async () => ({}), chooseCreateTarget: async () => null,
    cancelCreateTarget: async () => {}, createDocument: async () => null,
    chooseOpenTarget: async () => ({ selected: true, name: "current.scpefe" }),
    cancelOpenTarget: async () => {}, openSelectedDocument: async () => opened,
    unlockDocument: async () => opened, openExternalDocument: async () => opened,
    cancelExternalOpen: async () => true,
    enterEditMode: async () => ({ ...opened, readOnly: false }),
    updateWorkingCopy: async () => ({}), saveDocument: async () => null,
    backupDocument: async () => null, exportPlaintext: async () => null,
    lock: async () => ({ locked: true, journalSaved: true, warning: null }),
    onLocked: (fn) => listen("locked", fn),
    onJournalWarning: (fn) => listen("warning", fn),
    onRegularSave: (fn) => listen("regular", fn),
    onExternalOpenRequested: (fn) => listen("external", fn),
    onUnresolvedJournalSummary: (fn) => listen("summary", fn),
    onSwitchRetained: (fn) => listen("retained", fn),
  };
  dom.window[Symbol.for("scpefe.renderer.mount")] = (root) => { mountedRoot = root; };
  const assets = await fs.readdir(new URL("../dist/assets/", import.meta.url));
  const script = assets.find((entry) => /^index-.*\.js$/.test(entry));
  await import(`${pathToFileURL(path.resolve("dist/assets", script)).href}?admission-form`);
  const ui = await import("@testing-library/dom");
  const userEvent = (await import("@testing-library/user-event")).default;
  const user = userEvent.setup({ document: dom.window.document });
  await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "menubar")));
  await user.click(ui.getByRole(document.body, "menuitem", { name: "File" }));
  await user.click(ui.getByRole(ui.getByRole(document.body, "menu", { name: "File" }),
    "menuitem", { name: /Open/ }));
  const open = await ui.findByRole(document.body, "dialog", { name: "Open document" });
  await user.type(ui.getByLabelText(open, "Password"), "password words");
  await user.click(ui.getByRole(open, "button", { name: "Open" }));
  await ui.waitFor(() => assert.equal(ui.getByRole(document.body, "textbox",
    { name: "Document text" }).value, "current document"));

  await user.click(ui.getByRole(document.body, "menuitem", { name: "Security" }));
  await user.click(ui.getByRole(ui.getByRole(document.body, "menu", { name: "Security" }),
    "menuitem", { name: /Profile/ }));
  const profile = await ui.findByRole(document.body, "dialog", { name: "Profile" });
  const name = ui.getByLabelText(profile, "Name");
  await user.clear(name);
  await user.type(name, "Bea draft");
  assert.equal(document.activeElement === name, true);
  listeners.retained({ ...opened, profileMismatch: { editingBlocked: true,
    slotName: "Ada", slotEmail: "ada@example.test", profileName: "Bea",
    profileEmail: "bea@example.test" } });
  listeners.external({ token: "00000000-0000-4000-8000-000000000080" });
  assert.equal(ui.getAllByRole(document.body, "dialog").length, 1);
  assert.equal(name.value, "Bea draft");
  assert.equal(document.activeElement === name, true);
  await user.click(ui.getByRole(profile, "button", { name: "Cancel" }));
  const mismatch = await ui.findByRole(document.body, "dialog", { name: "Profile mismatch" });
  assert.equal(ui.getAllByRole(document.body, "dialog").length, 1);
  assert.equal(mismatch.getAttribute("aria-modal"), "true");
  assert.equal(ui.queryByRole(document.body, "dialog", { name: "Open requested document" }), null);
  assert.equal(mismatch.contains(document.activeElement), true);
});
