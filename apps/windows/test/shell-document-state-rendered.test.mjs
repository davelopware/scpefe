import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

test("mounted matrix | no-document/read-only/edit/locked | truthful state and secure locking", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://scpefe.invalid/",
  });
  const globalKeys = ["window", "document", "HTMLElement", "Node", "MutationObserver",
    "FormData", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT"];
  const priorGlobals = new Map(globalKeys.map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const animationFrames = new Map();
  let nextAnimationFrame = 0;
  let mountedRoot;
  let closed = false;
  t.after(async () => {
    mountedRoot?.unmount();
    await Promise.resolve();
    if (!closed) dom.window.close();
    for (const [key, descriptor] of priorGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
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

  const listeners = {};
  let stoppedListeners = 0;
  let editAttempts = 0;
  let lockCalls = 0;
  let savedContent = null;
  let nextPublicationState = "target-published";
  let backupAttempt = 0;
  let exportAttempt = 0;
  const exportRequests = [];
  const workingCopyUpdates = [];
  const opened = { content: "first line\nsecond line", readOnly: true, canEdit: true,
    publicationState: "target-published", targetName: "safe-notes.scpefe" };
  const listen = (name, listener) => {
    listeners[name] = listener;
    return () => { stoppedListeners += 1; delete listeners[name]; };
  };
  dom.window.scpefe = {
    getProfile: async () => ({ name: "Ada", email: "ada@example.test", deviceName: "Desk" }),
    getClientSettings: async () => ({ regularSaveEnabled: false,
      regularSaveIntervalMs: 120000 }),
    getUnresolvedJournalSummary: async () => ({ total: 0, pendingPublications: 0 }),
    saveProfile: async (value) => value, saveClientSettings: async (value) => value,
    activity: async () => ({}), chooseCreateTarget: async () => null,
    cancelCreateTarget: async () => {}, createDocument: async () => null,
    chooseOpenTarget: async () => ({ selected: true, name: "safe-notes.scpefe" }),
    cancelOpenTarget: async () => {},
    openSelectedDocument: async () => ({ ...opened }),
    unlockDocument: async () => ({ ...opened }),
    openExternalDocument: async () => null,
    enterEditMode: async () => {
      editAttempts += 1;
      if (editAttempts === 1) throw new Error("Editing lease is held by another session.");
      return { ...opened, readOnly: false };
    },
    updateWorkingCopy: async (working) => {
      workingCopyUpdates.push(structuredClone(working)); return {};
    },
    saveDocument: async (content) => {
      savedContent = content;
      return { saved: true, content, publicationState: nextPublicationState };
    },
    backupDocument: async () => {
      backupAttempt += 1;
      if (backupAttempt === 1) return null;
      if (backupAttempt === 2) throw new Error("backup destination unavailable");
      return { backedUp: true };
    },
    exportPlaintext: async (request) => {
      exportRequests.push(structuredClone(request));
      exportAttempt += 1;
      if (exportAttempt === 1) return null;
      if (exportAttempt === 2) throw new Error("export destination unavailable");
      return { exported: true };
    },
    lock: async () => { lockCalls += 1;
      return { locked: true, journalSaved: true, warning: null }; },
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
  await import(`${pathToFileURL(path.resolve("dist/assets", script)).href}?shell-document-state`);
  assert.ok(mountedRoot);
  const ui = await import("@testing-library/dom");
  const userEvent = (await import("@testing-library/user-event")).default;
  const user = userEvent.setup({ document: dom.window.document });
  await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "menubar")));

  const statusValue = (label) => ui.getByLabelText(document.body, label).textContent;
  const command = async (menu, name) => {
    await user.click(ui.getByRole(document.body, "menuitem", { name: menu }));
    const popup = ui.getByRole(document.body, "menu", { name: menu });
    const item = ui.getByRole(popup, "menuitem", { name });
    await user.click(item);
  };
  const menuItem = async (menu, name) => {
    await user.click(ui.getByRole(document.body, "menuitem", { name: menu }));
    const item = ui.getByRole(ui.getByRole(document.body, "menu", { name: menu }),
      "menuitem", { name });
    ui.fireEvent.keyDown(item.closest('[role="menu"]'), { key: "Escape" });
    return item;
  };

  const editor = ui.getByRole(document.body, "textbox", { name: "Document text" });
  await ui.waitFor(() => assert.equal(document.title, "SCPEFE"));
  assert.equal(statusValue("Document state"), "No document");
  assert.equal(editor.disabled, true);
  assert.match(ui.getByRole(document.body, "note").textContent, /File → New or File → Open/);
  assert.equal((await menuItem("Security", "Unlock")).disabled, true);

  await command("File", /Open/);
  const openDialog = await ui.findByRole(document.body, "dialog", { name: "Open document" });
  await user.type(ui.getByLabelText(openDialog, "Password"), "correct password");
  await user.click(ui.getByRole(openDialog, "button", { name: "Open" }));
  await ui.waitFor(() => assert.equal(statusValue("Document state"), "Read-only"));
  assert.equal(statusValue("Working copy state"), "Clean");
  assert.equal(statusValue("Publication state"), "Published");
  await ui.waitFor(() => assert.equal(document.title, "safe-notes.scpefe — SCPEFE"));
  assert.equal(document.title.includes("/"), false);
  assert.equal(editor.value, opened.content);
  assert.equal(editor.readOnly, true);
  assert.equal((await menuItem("File", /Save/)).disabled, true);
  assert.equal((await menuItem("Edit", "Edit Contents")).disabled, false);

  editor.focus();
  await user.keyboard("{Control>}f{/Control}");
  const findDialog = await ui.findByRole(document.body, "dialog", { name: "Find and replace" });
  assert.equal(findDialog.getAttribute("aria-modal"), "false");
  assert.equal(document.querySelector(".shell-chrome").hasAttribute("inert"), false,
    "modeless search leaves the document interactive");
  const findInput = ui.getByLabelText(findDialog, "Find");
  const replaceInput = ui.getByLabelText(findDialog, "Replace with");
  await user.type(findInput, "line");
  assert.equal(ui.getByRole(findDialog, "button", { name: "Replace" }).disabled, true);
  await user.click(ui.getByRole(findDialog, "button", { name: "Find next" }));
  assert.deepEqual([editor.selectionStart, editor.selectionEnd], [6, 10]);
  await user.click(ui.getByRole(findDialog, "button", { name: "Find next" }));
  assert.deepEqual([editor.selectionStart, editor.selectionEnd], [18, 22]);
  await user.click(ui.getByRole(findDialog, "button", { name: "Find next" }));
  assert.deepEqual([editor.selectionStart, editor.selectionEnd], [6, 10]);
  assert.match(ui.getByRole(findDialog, "status").textContent, /wrapping/);
  editor.focus(); await user.keyboard("{Control>}h{/Control}");
  assert.equal(document.activeElement === replaceInput, true,
    "Ctrl+H focuses Replace with even when mutation is read-only");
  assert.equal(ui.getByRole(findDialog, "button", { name: "Replace" }).disabled, true);

  await command("Edit", "Edit Contents");
  const failure = await ui.findByRole(document.body, "dialog", { name: "Editing unavailable" });
  assert.match(ui.getByRole(failure, "alert").textContent, /lease is held/);
  assert.equal(document.activeElement?.textContent.trim(), "Retry editing");
  assert.equal(editor.readOnly, true);
  assert.equal(statusValue("Document state"), "Read-only");
  await user.click(ui.getByRole(failure, "button", { name: "Continue read-only" }));

  await command("Edit", "Edit Contents");
  await ui.waitFor(() => assert.equal(statusValue("Document state"), "Edit mode"));
  assert.equal(editor.readOnly, false);
  assert.equal((await menuItem("File", /Save/)).disabled, true,
    "clean editable work cannot be saved");

  editor.focus();
  await user.keyboard("{Control>}h{/Control}");
  assert.equal(document.activeElement === replaceInput, true,
    "Ctrl+H reuses the modeless dialog and focuses Replace with");
  await user.type(replaceInput, "row");
  await user.click(ui.getByRole(findDialog, "button", { name: "Replace" }));
  assert.equal(editor.value, "first row\nsecond line");
  await user.click(ui.getByRole(findDialog, "button", { name: "Replace all" }));
  assert.equal(editor.value, "first row\nsecond row");
  assert.deepEqual([editor.selectionStart, editor.selectionEnd],
    [editor.value.length, editor.value.length],
    "Replace all leaves the cursor at the end of the result");
  assert.deepEqual(workingCopyUpdates.at(-1), {
    content: "first row\nsecond row", cursor: { start: 20, end: 20 },
  }, "the end cursor crosses the working-copy boundary");
  assert.match(ui.getByRole(findDialog, "status").textContent, /1 match replaced/);
  editor.focus(); await user.keyboard("{Control>}z{/Control}");
  assert.equal(editor.value, "first row\nsecond line");
  assert.deepEqual(workingCopyUpdates.at(-1), {
    content: "first row\nsecond line", cursor: { start: 21, end: 21 },
  });
  await user.keyboard("{Control>}y{/Control}");
  assert.equal(editor.value, "first row\nsecond row");
  assert.deepEqual(workingCopyUpdates.at(-1), {
    content: "first row\nsecond row", cursor: { start: 20, end: 20 },
  });
  await user.keyboard("{Control>}z{/Control}{Control>}z{/Control}");
  assert.equal(editor.value, opened.content);
  await user.click(ui.getByRole(findDialog, "button", { name: "Close" }));
  await ui.waitFor(() => assert.equal(
    ui.queryByRole(document.body, "dialog", { name: "Find and replace" }), null));

  editor.focus();
  ui.fireEvent.change(editor, { target: { value: `${opened.content}!`,
    selectionStart: opened.content.length + 1, selectionEnd: opened.content.length + 1 } });
  await ui.waitFor(() => assert.equal(statusValue("Working copy state"), "Dirty"));
  await ui.waitFor(() => assert.equal(document.title, "*safe-notes.scpefe — SCPEFE"));
  assert.equal((await menuItem("File", /Save/)).disabled, false);
  assert.equal((await menuItem("File", /Backup/)).disabled, true,
    "an unsealed dirty working copy is ineligible for Backup");
  assert.equal((await menuItem("Edit", /Undo/)).disabled, false);

  editor.focus();
  await user.keyboard("{Control>}z{/Control}");
  assert.equal(editor.value, opened.content);
  assert.equal(statusValue("Working copy state"), "Clean");
  await ui.waitFor(() => assert.equal(document.title, "safe-notes.scpefe — SCPEFE"));
  assert.equal((await menuItem("Edit", /Redo/)).disabled, false);
  editor.focus();
  await user.keyboard("{Control>}y{/Control}");
  assert.equal(editor.value, `${opened.content}!`);
  assert.equal(statusValue("Working copy state"), "Dirty");
  await command("File", /Save/);
  await ui.waitFor(() => assert.equal(statusValue("Working copy state"), "Clean"));
  assert.equal(savedContent, `${opened.content}!`);
  assert.equal(statusValue("Publication state"), "Published");

  const beforeTransfer = editor.value;
  await command("File", /Backup/);
  assert.equal(editor.value, beforeTransfer);
  assert.match(ui.getByRole(document.body, "status").textContent,
    /Backup canceled; the document and destination are unchanged/);
  await command("File", /Backup/);
  assert.match(ui.getByRole(document.body, "status").textContent,
    /backup destination unavailable/);
  assert.equal(editor.value, beforeTransfer);
  await command("File", /Backup/);
  assert.match(ui.getByRole(document.body, "status").textContent,
    /Verified byte-identical backup replica created/);

  await command("File", /Export Plaintext/);
  let exportDialog = await ui.findByRole(document.body, "dialog", { name: "Export plaintext" });
  assert.match(exportDialog.textContent, /Not password protected/);
  await user.selectOptions(ui.getByLabelText(exportDialog, "Line endings"), "native");
  await user.click(ui.getByRole(exportDialog, "button", { name: /Export current text/ }));
  await ui.waitFor(() => assert.equal(
    ui.queryByRole(document.body, "dialog", { name: "Export plaintext" }), null));
  assert.equal(editor.value, beforeTransfer);
  await command("File", /Export Plaintext/);
  exportDialog = await ui.findByRole(document.body, "dialog", { name: "Export plaintext" });
  await user.click(ui.getByRole(exportDialog, "button", { name: /Export current text/ }));
  assert.match((await ui.findByRole(exportDialog, "alert")).textContent,
    /export destination unavailable/);
  assert.equal(document.activeElement?.textContent.trim(), "Export current text…");
  assert.equal(editor.value, beforeTransfer);
  await user.click(ui.getByRole(exportDialog, "button", { name: /Export current text/ }));
  await ui.waitFor(() => assert.equal(
    ui.queryByRole(document.body, "dialog", { name: "Export plaintext" }), null));
  assert.deepEqual(exportRequests, [
    { content: beforeTransfer, lineEndings: "native" },
    { content: beforeTransfer, lineEndings: "native" },
    { content: beforeTransfer, lineEndings: "native" },
  ]);

  ui.fireEvent.change(editor, { target: { value: `${opened.content}!?`,
    selectionStart: opened.content.length + 2, selectionEnd: opened.content.length + 2 } });
  listeners["regular-save"]({ published: true, provisional: true,
    content: `${opened.content}!?` });
  await ui.waitFor(() => assert.equal(statusValue("Publication state"),
    "Provisional publication"));
  assert.equal(statusValue("Working copy state"), "Dirty");
  nextPublicationState = "pending-publication";
  await command("File", /Save/);
  await ui.waitFor(() => assert.equal(statusValue("Publication state"),
    "Pending publication"));
  assert.equal(statusValue("Working copy state"), "Clean");
  assert.equal(statusValue("Document state"), "Read-only");

  const plaintext = opened.content;
  assert.equal(editor.value, "",
    "blocking publication decisions do not expose plaintext behind their overlay");
  listeners.locked({ locked: true, journalSaved: true, warning: null });
  assert.equal(editor.value, "", "automatic lock synchronously removes mounted plaintext");
  assert.equal(document.body.textContent.includes(plaintext), false);
  assert.equal(ui.queryByRole(document.body, "dialog", { name: "Find and replace" }), null);
  assert.equal(statusValue("Document state"), "Locked");
  assert.equal(statusValue("Publication state"), "Pending publication");
  await ui.waitFor(() => assert.equal(document.title, "safe-notes.scpefe — SCPEFE"));
  assert.match(ui.getByRole(document.body, "note").textContent, /Security → Unlock/);
  assert.equal((await menuItem("Security", "Lock")).disabled, true);
  assert.equal((await menuItem("Security", "Unlock")).disabled, false);

  await command("Security", "Unlock");
  const reopenDialog = await ui.findByRole(document.body, "dialog", { name: "Unlock document" });
  await user.type(ui.getByLabelText(reopenDialog, "Password"), "correct password");
  await user.click(ui.getByRole(reopenDialog, "button", { name: "Unlock" }));
  editor.focus(); await user.keyboard("{Control>}f{/Control}");
  const protectedFind = await ui.findByRole(document.body, "dialog",
    { name: "Find and replace" });
  await user.type(ui.getByLabelText(protectedFind, "Find"), "first line");
  await command("Security", "Lock");
  assert.equal(lockCalls, 1);
  assert.equal(editor.value, "", "manual lock synchronously removes mounted plaintext");
  assert.equal(document.body.textContent.includes(opened.content), false);
  assert.equal(document.body.textContent.includes("first line"), false,
    "manual lock removes protected modeless search state");
  assert.equal(ui.queryByRole(document.body, "dialog", { name: "Find and replace" }), null);
  assert.equal(statusValue("Document state"), "Locked");

  mountedRoot.unmount();
  mountedRoot = null;
  await Promise.resolve();
  assert.equal(document.getElementById("root").childElementCount, 0);
  assert.equal(stoppedListeners, 6);
  assert.equal(animationFrames.size, 0);
  dom.window.close(); closed = true;
});
