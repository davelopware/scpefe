import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

test("mounted conflict retry preserves edits made during save until explicit discard", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://scpefe.invalid/",
  });
  const keys = ["window", "document", "HTMLElement", "Node", "MutationObserver",
    "FormData", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT"];
  const prior = new Map(keys.map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const frames = new Map();
  let frameSequence = 0;
  let root;
  t.after(async () => {
    root?.unmount();
    await Promise.resolve();
    frames.clear();
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const requestFrame = (callback) => {
    const id = ++frameSequence;
    frames.set(id, callback);
    queueMicrotask(() => {
      const pending = frames.get(id);
      if (pending) { frames.delete(id); pending(performance.now()); }
    });
    return id;
  };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, FormData: dom.window.FormData,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: (id) => frames.delete(id),
    IS_REACT_ACT_ENVIRONMENT: true });

  const listeners = new Map();
  const listen = (name, listener) => {
    listeners.set(name, listener);
    return () => { listeners.delete(name); };
  };
  const opened = { content: "base", readOnly: true, canEdit: true,
    publicationState: "target-published", targetName: "conflict.scpefe" };
  let completeSave;
  let saveContent = null;
  let divergenceCalls = 0;
  const exports = [];
  dom.window.scpefe = {
    getProfile: async () => ({ name: "Ada", email: "ada@example.test", deviceName: "Desk" }),
    getClientSettings: async () => ({ regularSaveEnabled: false,
      regularSaveIntervalMs: 120000 }),
    getUnresolvedJournalSummary: async () => ({ total: 0, pendingPublications: 0 }),
    activity: async () => ({}),
    chooseOpenTarget: async () => ({ selected: true, name: "conflict.scpefe" }),
    openSelectedDocument: async () => opened,
    enterEditMode: async () => ({ ...opened, readOnly: false }),
    updateWorkingCopy: async () => ({}),
    saveDocument: (content) => {
      saveContent = content;
      return new Promise((resolve) => { completeSave = resolve; });
    },
    beginDivergenceResolution: async () => {
      divergenceCalls += 1;
      return { content: "merge draft", hasConflicts: false,
        ancestorRevision: "a", localRevision: "l", currentRevision: "c" };
    },
    exportPlaintext: async (request) => {
      exports.push(structuredClone(request));
      return { exported: true };
    },
    onLocked: (listener) => listen("locked", listener),
    onJournalWarning: (listener) => listen("warning", listener),
    onRegularSave: (listener) => listen("regular", listener),
    onExternalOpenRequested: (listener) => listen("external", listener),
    onUnresolvedJournalSummary: (listener) => listen("summary", listener),
    onSwitchRetained: (listener) => listen("switch", listener),
  };
  dom.window[Symbol.for("scpefe.renderer.mount")] = (mounted) => { root = mounted; };
  const assets = await fs.readdir(new URL("../dist/assets/", import.meta.url));
  const script = assets.find((entry) => /^index-.*\.js$/.test(entry));
  await import(`${pathToFileURL(path.resolve("dist/assets", script)).href}?publication-session-review`);
  const ui = await import("@testing-library/dom");
  const userEvent = (await import("@testing-library/user-event")).default;
  const user = userEvent.setup({ document: dom.window.document });
  await ui.findByRole(document.body, "menubar");
  const command = async (menuName, itemName) => {
    await user.click(ui.getByRole(document.body, "menuitem", { name: menuName }));
    await user.click(ui.getByRole(ui.getByRole(document.body, "menu", { name: menuName }),
      "menuitem", { name: itemName }));
  };
  await command("File", /Open/);
  const open = await ui.findByRole(document.body, "dialog", { name: "Open document" });
  await user.type(ui.getByLabelText(open, "Password"), "password words");
  await user.click(ui.getByRole(open, "button", { name: "Open" }));
  await command("Edit", "Edit Contents");
  const editor = ui.getByRole(document.body, "textbox", { name: "Document text" });
  ui.fireEvent.change(editor, { target: { value: "saved candidate",
    selectionStart: 15, selectionEnd: 15 } });
  await command("File", /Save/);
  await ui.waitFor(() => assert.equal(saveContent, "saved candidate"));
  ui.fireEvent.change(editor, { target: { value: "newer unsaved edit",
    selectionStart: 17, selectionEnd: 17 } });
  completeSave({ saved: true, content: "saved candidate", publicationState: "conflict" });
  let publication = await ui.findByRole(document.body, "dialog",
    { name: "Divergence needs resolution" });
  await user.click(ui.getByRole(publication, "button", { name: "Retry publication" }));
  let decision = await ui.findByRole(document.body, "dialog",
    { name: "Discard newer unsaved edits?" });
  assert.equal(divergenceCalls, 0);
  assert.equal(ui.getByLabelText(document.body, "Working copy state").textContent, "Dirty");
  await user.click(ui.getByRole(decision, "button", { name: "Export newer edits…" }));
  const exportDialog = await ui.findByRole(document.body, "dialog",
    { name: "Export plaintext" });
  await user.click(ui.getByRole(exportDialog, "button", { name: "Export current text…" }));
  assert.equal(exports.at(-1)?.content, "newer unsaved edit");
  publication = await ui.findByRole(document.body, "dialog",
    { name: "Divergence needs resolution" });
  await user.click(ui.getByRole(publication, "button", { name: "Retry publication" }));
  decision = await ui.findByRole(document.body, "dialog",
    { name: "Discard newer unsaved edits?" });
  await user.click(ui.getByRole(decision, "button",
    { name: "Discard newer edits and resolve" }));
  await ui.waitFor(() => assert.equal(editor.value, "merge draft"));
  assert.equal(divergenceCalls, 1);
});
