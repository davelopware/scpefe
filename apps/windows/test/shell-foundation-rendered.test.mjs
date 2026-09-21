import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

test("mounted shell provides ordered accessible menus, keyboard operation, dialogs, and editor layout", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://scpefe.invalid/",
  });
  const globalKeys = ["window", "document", "HTMLElement", "Node", "MutationObserver",
    "FormData", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT"];
  const priorGlobals = new Map(globalKeys.map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let mountedRoot;
  let closed = false;
  t.after(() => {
    mountedRoot?.unmount();
    if (!closed) dom.window.close();
    for (const [key, descriptor] of priorGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const animationFrames = new Map();
  let nextAnimationFrame = 0;
  const requestTestAnimationFrame = (callback) => {
    const token = ++nextAnimationFrame;
    animationFrames.set(token, callback);
    queueMicrotask(() => {
      const pending = animationFrames.get(token);
      if (pending) { animationFrames.delete(token); pending(performance.now()); }
    });
    return token;
  };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, FormData: dom.window.FormData,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: requestTestAnimationFrame,
    cancelAnimationFrame: (token) => animationFrames.delete(token),
    IS_REACT_ACT_ENVIRONMENT: true });
  const calls = [];
  const listeners = {};
  let stoppedListeners = 0;
  const listen = (name, listener) => {
    listeners[name] = listener;
    return () => { stoppedListeners += 1; delete listeners[name]; };
  };
  dom.window.scpefe = {
    getProfile: async () => ({ name: "Ada", email: "ada@example.test", deviceName: "Desk" }),
    getClientSettings: async () => ({ regularSaveEnabled: false, regularSaveIntervalMs: 120000 }),
    getUnresolvedJournalSummary: async () => ({ total: 0, pendingPublications: 0 }),
    saveProfile: async (value) => value, saveClientSettings: async (value) => value,
    activity: async () => ({}), chooseCreateTarget: async () => { calls.push("new"); return null; },
    cancelCreateTarget: async () => {}, createDocument: async () => null,
    openDocument: async () => { calls.push("open"); return { content: "mounted document",
      readOnly: true, canEdit: true, publicationState: "target-published",
      targetName: "notes.scpefe",
      recovery: { content: "recovered document", state: "unsaved", updateTime: 1,
        cursor: { start: 0, end: 0 } } }; },
    openExternalDocument: async () => null, enterEditMode: async () => ({ content: "mounted document",
      readOnly: false, canEdit: true, publicationState: "target-published" }),
    updateWorkingCopy: async () => ({}), saveDocument: async (content) => ({ saved: true, content,
      publicationState: "target-published" }), backupDocument: async () => ({ backedUp: true }),
    exportPlaintext: async () => ({ exported: true }), lock: async () => ({ locked: true,
      journalSaved: true, warning: null }),
    discardRecoveredWork: async () => ({ content: "mounted document", readOnly: true,
      canEdit: true, publicationState: "target-published" }),
    onLocked: (listener) => listen("locked", listener),
    onJournalWarning: (listener) => listen("warning", listener),
    onRegularSave: (listener) => listen("regular-save", listener),
    onExternalOpenRequested: (listener) => listen("external-open", listener),
    onUnresolvedJournalSummary: (listener) => listen("journal-summary", listener),
    onSwitchRetained: (listener) => listen("switch-retained", listener),
  };
  dom.window[Symbol.for("scpefe.renderer.mount")] = (root) => { mountedRoot = root; };
  const assets = await fs.readdir(new URL("../dist/assets/", import.meta.url));
  const script = assets.find((entry) => /^index-.*\.js$/.test(entry));
  const stylesheet = assets.find((entry) => /^index-.*\.css$/.test(entry));
  const style = document.createElement("style");
  style.textContent = await fs.readFile(new URL(`../dist/assets/${stylesheet}`, import.meta.url), "utf8");
  document.head.append(style);
  await import(`${pathToFileURL(path.resolve("dist/assets", script)).href}?shell-foundation`);
  assert.ok(mountedRoot, "the production renderer reports its mounted React root");
  const ui = await import("@testing-library/dom");
  const userEvent = (await import("@testing-library/user-event")).default;
  const user = userEvent.setup({ document: dom.window.document });
  await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "menubar", { name: "Application menu" })));

  const shell = document.querySelector(".app-shell");
  const workspace = ui.getByRole(document.body, "region", { name: "Document workspace" });
  const editor = ui.getByRole(document.body, "textbox", { name: "Document text" });
  assert.equal(getComputedStyle(shell).height, "100%");
  assert.match(getComputedStyle(shell).gridTemplateRows, /minmax\(0,\s*1fr\)/);
  assert.equal(getComputedStyle(workspace).minHeight, "0");
  assert.equal(getComputedStyle(editor).height, "100%");
  assert.equal(editor.disabled, true);
  const status = ui.getByRole(document.body, "status");
  assert.equal(status.getAttribute("aria-live"), "polite");
  assert.equal(status.getAttribute("aria-atomic"), "true");
  for (const name of ["File", "Edit", "Security"]) {
    const trigger = ui.getByRole(document.body, "menuitem", { name });
    assert.equal(trigger.getAttribute("aria-haspopup"), "menu");
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
  }
  for (const [width, height] of [[1280, 720], [640, 420]]) {
    Object.defineProperties(window, { innerWidth: { configurable: true, value: width },
      innerHeight: { configurable: true, value: height } });
    window.dispatchEvent(new window.Event("resize"));
    await Promise.resolve();
    assert.equal(window.innerWidth, width); assert.equal(window.innerHeight, height);
    assert.equal(getComputedStyle(shell).height, "100%");
    assert.equal(getComputedStyle(editor).height, "100%");
    assert.equal(document.querySelector(".app-shell") === shell, true,
      "resize preserves the mounted shell node");
  }

  await user.click(ui.getByRole(document.body, "menuitem", { name: "File" }));
  const file = ui.getByRole(document.body, "menu", { name: "File" });
  assert.deepEqual(ui.getAllByRole(file, "menuitem").map((item) => item.textContent),
    ["NewCtrl+N", "Open…Ctrl+O", "SaveCtrl+S", "Backup…", "Export Plaintext…",
      "CloseCtrl+W", "Exit"]);
  assert.equal(ui.getAllByRole(file, "separator").length, 2);
  assert.equal(ui.getByRole(file, "menuitem", { name: /Save/ }).disabled, true);
  assert.equal(ui.getByRole(file, "menuitem", { name: /Close/ }).disabled, true);
  ui.fireEvent.keyDown(file, { key: "Escape" });
  assert.equal(document.activeElement?.getAttribute("aria-label"), "File",
    "Escape returns focus to the File trigger");

  await user.click(ui.getByRole(document.body, "menuitem", { name: "Edit" }));
  const editMenu = ui.getByRole(document.body, "menu", { name: "Edit" });
  assert.deepEqual(ui.getAllByRole(editMenu, "menuitem").map((item) => item.textContent),
    ["Edit Contents", "UndoCtrl+Z", "RedoCtrl+Y", "Find…Ctrl+F", "Replace…Ctrl+H"]);
  assert.equal(ui.getAllByRole(editMenu, "separator").length, 2);
  ui.fireEvent.keyDown(editMenu, { key: "Escape" });
  await user.click(ui.getByRole(document.body, "menuitem", { name: "Security" }));
  const securityMenu = ui.getByRole(document.body, "menu", { name: "Security" });
  assert.deepEqual(ui.getAllByRole(securityMenu, "menuitem").map((item) => item.textContent),
    ["Lock", "Unlock", "Passwords…", "Profile…"]);
  assert.equal(ui.getAllByRole(securityMenu, "separator").length, 1);
  ui.fireEvent.keyDown(securityMenu, { key: "Escape" });

  await user.keyboard("{Alt>}s{/Alt}");
  const keyboardSecurityMenu = await ui.findByRole(document.body, "menu", { name: "Security" });
  await ui.waitFor(() => assert.match(document.activeElement?.textContent ?? "", /^Profile/));
  await user.keyboard("{Enter}");
  const profileDialog = await ui.findByRole(document.body, "dialog", { name: "Profile" });
  assert.equal(profileDialog.getAttribute("aria-modal"), "true");
  assert.equal(document.activeElement?.getAttribute("name"), "name");
  await user.keyboard("{Control>}n{/Control}{Control>}o{/Control}{Control>}f{/Control}{Alt>}f{/Alt}");
  assert.deepEqual(calls, []);
  assert.equal(ui.queryByRole(document.body, "menu") === null, true,
    "modal shortcuts open no menu");
  await user.keyboard("{Escape}");
  await ui.waitFor(() => assert.equal(
    document.activeElement?.getAttribute("aria-label"), "Security"));

  await user.keyboard("{Alt>}e{/Alt}");
  assert.ok(await ui.findByRole(document.body, "menu", { name: "Edit" }));
  ui.fireEvent.keyDown(ui.getByRole(document.body, "menu", { name: "Edit" }), { key: "Escape" });
  await user.keyboard("{Alt>}f{/Alt}");
  await ui.findByRole(document.body, "menu", { name: "File" });
  await ui.waitFor(() => assert.match(document.activeElement?.textContent ?? "", /^New/));
  await user.keyboard("{ArrowRight}");
  const keyboardEditMenu = await ui.findByRole(document.body, "menu", { name: "Edit" });
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Edit",
    "ArrowRight leaves focus on Edit when all its commands are disabled");
  assert.equal(ui.getAllByRole(keyboardEditMenu, "menuitem")
    .every((item) => item.disabled), true, "Edit commands are disabled without a document");
  await user.keyboard("{ArrowLeft}");
  await ui.findByRole(document.body, "menu", { name: "File" });
  await ui.waitFor(() => assert.match(document.activeElement?.textContent ?? "", /^New/));
  await user.keyboard("{ArrowDown}");
  assert.match(document.activeElement?.textContent ?? "", /^Open/);
  await user.keyboard("{ArrowDown}");
  assert.equal(document.activeElement?.textContent, "Exit");
  await user.keyboard("{ArrowUp}");
  assert.match(document.activeElement?.textContent ?? "", /^Open/);
  await user.keyboard(" ");
  let dialog = await ui.findByRole(document.body, "dialog", { name: "Open document" });
  await user.keyboard("{Escape}");
  await ui.waitFor(() => assert.equal(
    ui.queryByRole(document.body, "dialog") === null, true,
    "Escape closes the open dialog"));
  await ui.waitFor(() => assert.equal(
    document.activeElement?.getAttribute("aria-label"), "File"));

  const shortcutSurface = ui.getByRole(document.body, "menuitem", { name: "File" });
  shortcutSurface.focus(); await user.keyboard("{Control>}n{/Control}");
  await ui.waitFor(() => assert.deepEqual(calls, ["new"]));
  await user.keyboard("{Control>}o{/Control}");
  dialog = await ui.findByRole(document.body, "dialog", { name: "Open document" });
  assert.equal(document.querySelector(".shell-chrome").hasAttribute("inert"), true);
  const password = ui.getByLabelText(dialog, "Password");
  assert.equal(document.activeElement === password, true,
    "the open password receives initial focus");
  const choose = ui.getByRole(dialog, "button", { name: "Choose document…" });
  choose.focus(); await user.keyboard("{Tab}");
  assert.equal(document.activeElement === password, true,
    "Tab wraps from the final action to the password field");
  await user.type(password, "correct password");
  await user.click(choose);
  const recoveryDialog = await ui.findByRole(document.body, "dialog", { name: "Recovered work" });
  assert.equal(ui.getAllByRole(document.body, "dialog").length, 1);
  await user.keyboard("{Control>}n{/Control}{Control>}o{/Control}{Alt>}f{/Alt}");
  assert.deepEqual(calls, ["new", "open"]);
  assert.equal(ui.queryByRole(document.body, "menu") === null, true,
    "recovery modal shortcuts open no menu");
  await user.click(ui.getByRole(recoveryDialog, "button", { name: "Discard recovered work" }));
  await ui.waitFor(() => assert.equal(
    ui.queryByRole(document.body, "dialog") === null, true,
    "discard closes the recovery dialog"));
  await ui.waitFor(() => assert.equal(
    document.activeElement?.getAttribute("aria-label"), "File"));
  assert.equal(editor.disabled, false); assert.equal(editor.readOnly, true);
  assert.equal(editor.value, "mounted document");

  await user.click(ui.getByRole(document.body, "menuitem", { name: "File" }));
  const openedFileMenu = ui.getByRole(document.body, "menu", { name: "File" });
  assert.equal(ui.getByRole(openedFileMenu, "menuitem", { name: /Save/ }).disabled, true);
  assert.equal(ui.getByRole(openedFileMenu, "menuitem", { name: /Backup/ }).disabled, false);
  assert.equal(ui.getByRole(openedFileMenu, "menuitem", { name: /Export Plaintext/ }).disabled, false);
  ui.fireEvent.keyDown(openedFileMenu, { key: "Escape" });
  await user.click(ui.getByRole(document.body, "menuitem", { name: "Security" }));
  const openedSecurityMenu = ui.getByRole(document.body, "menu", { name: "Security" });
  assert.equal(ui.getByRole(openedSecurityMenu, "menuitem", { name: "Lock" }).disabled, false);
  assert.equal(ui.getByRole(openedSecurityMenu, "menuitem", { name: /Passwords/ }).disabled, false);
  ui.fireEvent.keyDown(openedSecurityMenu, { key: "Escape" });

  editor.focus(); await user.keyboard("{Alt>}e{/Alt}");
  const openedEditMenu = await ui.findByRole(document.body, "menu", { name: "Edit" });
  await ui.waitFor(() => assert.match(document.activeElement?.textContent ?? "", /^Edit Contents/));
  await user.keyboard("{ArrowDown}");
  assert.match(document.activeElement?.textContent ?? "", /^Find/);
  ui.fireEvent.keyDown(openedEditMenu, { key: "Escape" });
  editor.focus(); await user.keyboard("{Control>}f{/Control}");
  const find = await ui.findByRole(document.body, "dialog", { name: "Find and replace" });
  assert.equal(document.activeElement === ui.getByLabelText(find, "Find"), true,
    "the Find field receives initial focus");
  await user.keyboard("{Escape}");
  await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog",
    { name: "Find and replace" }) === null, true, "Escape closes Find and replace"));
  await ui.waitFor(() => assert.equal(
    document.activeElement?.getAttribute("aria-label"), "Document text"));
  assert.deepEqual(calls, ["new", "open"]);
  mountedRoot.unmount();
  mountedRoot = null;
  await Promise.resolve();
  assert.equal(document.getElementById("root").childElementCount, 0);
  assert.equal(stoppedListeners, 6);
  assert.equal(animationFrames.size, 0);
  dom.window.close(); closed = true;
});
