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
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true });
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
    chooseCreateTarget: async () => null, cancelCreateTarget: async () => {}, createDocument: async () => null,
    enterEditMode: async () => ({ content: "secret text", readOnly: false, canEdit: true, publicationState: "target-published" }),
    saveDocument: async (content) => ({ content, publicationState: "target-published" }),
    backupDocument: async () => ({ backedUp: true }), exportPlaintext: async () => ({ exported: true }),
    saveProfile: async (value) => value, createInvitation: async () => ({ temporaryPassword: "temporary secure phrase" }),
    exitApplication: async () => true, lock: async () => ({ locked: true, warning: null }),
    getUnresolvedJournalSummary: async () => ({ total: 0 }),
    onLocked: (fn) => { listeners.locked = fn; return () => {}; },
    onJournalWarning: () => () => {}, onRegularSave: (fn) => { listeners.regularSave = fn; return () => {}; },
    onExternalOpenRequested: (fn) => { listeners.external = fn; return () => {}; }, onUnresolvedJournalSummary: () => () => {},
    onSwitchRetained: () => () => {}, ...overrides,
  };
  dom.window.scpefe = api;
  const assets = await fs.readdir(new URL("../dist/assets/", import.meta.url));
  const script = assets.find((entry) => /^index-.*\.js$/.test(entry));
  await import(`${pathToFileURL(path.resolve("dist/assets", script)).href}?test=${Date.now()}-${Math.random()}`);
  const testing = await import("@testing-library/dom");
  const userEvent = (await import("@testing-library/user-event")).default;
  await testing.waitFor(() => assert.ok(testing.getByRole(document.body, "menubar", { name: "Application menu" })));
  t.after(() => { dom.window.close(); });
  return { dom, calls, listeners, user: userEvent.setup({ document: dom.window.document }), ...testing };
}

async function menuCommand(ui, menu, command) {
  await ui.user.click(ui.getByRole(document.body, "menuitem", { name: menu }));
  await ui.waitFor(() => ui.getByRole(document.body, "menu", { name: menu }));
  await ui.user.click(ui.getByRole(ui.getByRole(document.body, "menu", { name: menu }), "menuitem", { name: command }));
}

async function openThroughDialog(ui, password = "correct password") {
  await menuCommand(ui, "File", /Open/);
  await ui.waitFor(() => ui.getByRole(document.body, "dialog", { name: "Open document" }));
  await ui.user.type(ui.getByLabelText(document.body, "Document password"), password);
  await ui.user.click(ui.getByRole(document.body, "button", { name: "Open" }));
  await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog", { name: "Open document" }), null));
}

test("mounted shell has stable menus, disabled no-document editor, and status", async (t) => {
  const ui = await mount(t);
  const editor = ui.getByRole(document.body, "textbox", { name: "Document text" });
  assert.equal(editor.disabled, true);
  assert.match(document.body.textContent, /No document\. Use File → New or File → Open/);
  assert.match(document.body.textContent, /No document/);
  await ui.user.click(ui.getByRole(document.body, "menuitem", { name: "File" }));
  await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "menu", { name: "File" })));
  const fileMenu = ui.getByRole(document.body, "menu", { name: "File" });
  assert.deepEqual(ui.getAllByRole(fileMenu, "menuitem").map((item) => item.textContent),
    ["NewCtrl+N", "Open…Ctrl+O", "SaveCtrl+S", "Backup…", "Export Plaintext…", "CloseCtrl+W", "Exit"]);
  assert.equal(ui.getByRole(document.body, "menuitem", { name: /Save/ }).disabled, true);
  ui.fireEvent.keyDown(fileMenu, { key: "Escape" });
  await ui.user.click(ui.getByRole(document.body, "menuitem", { name: "Edit" }));
  const editMenu = ui.getByRole(document.body, "menu", { name: "Edit" });
  assert.deepEqual(ui.getAllByRole(editMenu, "menuitem").map((item) => item.textContent),
    ["Edit Contents", "UndoCtrl+Z", "RedoCtrl+Y", "Find…Ctrl+F", "Replace…Ctrl+H"]);
  assert.equal(ui.getByRole(editMenu, "menuitem", { name: "Edit Contents" }).disabled, true);
  ui.fireEvent.keyDown(editMenu, { key: "Escape" });
  await ui.user.click(ui.getByRole(document.body, "menuitem", { name: "Security" }));
  const securityMenu = ui.getByRole(document.body, "menu", { name: "Security" });
  assert.deepEqual(ui.getAllByRole(securityMenu, "menuitem").map((item) => item.textContent),
    ["Lock", "Passwords…", "Profile…"]);
  assert.equal(ui.getByRole(securityMenu, "menuitem", { name: "Lock" }).disabled, true);
});

test("mounted Open runs picker before password dialog and successful unlock enters read-only", async (t) => {
  const ui = await mount(t);
  await ui.user.click(ui.getByRole(document.body, "menuitem", { name: "File" }));
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
  await ui.user.click(ui.getByRole(document.body, "menuitem", { name: "File" }));
  await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "menu", { name: "File" })));
  await ui.user.click(ui.getByRole(document.body, "menuitem", { name: /Open/ }));
  await ui.waitFor(() => ui.getByLabelText(document.body, "Document password"));
  ui.fireEvent.change(ui.getByLabelText(document.body, "Document password"), { target: { value: "password" } });
  ui.fireEvent.submit(ui.getByLabelText(document.body, "Document password").form);
  await ui.waitFor(() => assert.match(document.body.textContent, /remove me now/));
  await ui.user.click(ui.getByRole(document.body, "menuitem", { name: "Security" }));
  await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "menu", { name: "Security" })));
  await ui.user.click(ui.getByRole(document.body, "menuitem", { name: "Lock" }));
  await ui.waitFor(() => assert.doesNotMatch(document.body.textContent, /remove me now/));
  assert.match(document.body.textContent, /securely locked/);
  await ui.user.click(ui.getByRole(document.body, "menuitem", { name: "Security" }));
  await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "menu", { name: "Security" })));
  assert.ok(ui.getByRole(document.body, "menuitem", { name: "Unlock" }));
  assert.equal(attempt, 0);
});

test("Alt access works from the editor and menu arrows focus enabled commands", async (t) => {
  const ui = await mount(t);
  await openThroughDialog(ui);
  ui.getByRole(document.body, "textbox", { name: "Document text" }).focus();
  await ui.user.keyboard("{Alt>}f{/Alt}");
  await ui.waitFor(() => assert.equal(document.activeElement.textContent, "NewCtrl+N"));
  ui.fireEvent.keyDown(document.activeElement, { key: "ArrowRight" });
  await ui.waitFor(() => assert.equal(ui.getByRole(document.body, "menuitem", { name: "Edit" }).getAttribute("aria-expanded"), "true"));
  await ui.waitFor(() => assert.match(document.activeElement.textContent, /Edit Contents/));
  ui.fireEvent.keyDown(document.activeElement, { key: "Escape" });
  assert.equal(document.activeElement, ui.getByRole(document.body, "menuitem", { name: "Edit" }));
});

test("wrong-password retry and dialog cancellation retain the mounted prior session", async (t) => {
  let attempts = 0;
  const ui = await mount(t, { openSelectedDocument: async () => {
    attempts += 1;
    if (attempts === 1) return { content: "original session", readOnly: true, canEdit: true, publicationState: "target-published" };
    throw new Error("Incorrect document password");
  } });
  await openThroughDialog(ui);
  assert.match(document.body.textContent, /original session/);
  await menuCommand(ui, "File", /Open/);
  await ui.user.type(ui.getByLabelText(document.body, "Document password"), "wrong password");
  await ui.user.click(ui.getByRole(document.body, "button", { name: "Open" }));
  const openDialog = ui.getByRole(document.body, "dialog", { name: "Open document" });
  await ui.waitFor(() => assert.match(ui.getByRole(openDialog, "alert").textContent, /Incorrect document password/));
  assert.equal(document.activeElement, ui.getByLabelText(document.body, "Document password"));
  assert.equal(ui.getByRole(document.body, "textbox", { name: "Document text", hidden: true }).value, "original session");
  await ui.user.click(ui.getByRole(document.body, "button", { name: "Cancel" }));
  assert.match(document.body.textContent, /original session/);
});

test("Edit, dirty title, Save shortcut, and modeless Find preserve editor access", async (t) => {
  const ui = await mount(t);
  await openThroughDialog(ui);
  await menuCommand(ui, "Edit", "Edit Contents");
  const editor = ui.getByRole(document.body, "textbox", { name: "Document text" });
  assert.equal(editor.readOnly, false);
  await ui.user.type(editor, " changed");
  await ui.waitFor(() => assert.match(document.title, /^\*/));
  ui.fireEvent.keyDown(window, { key: "f", ctrlKey: true });
  await ui.waitFor(() => ui.getByRole(document.body, "dialog", { name: "Find and replace" }));
  assert.equal(document.querySelector(".shell-chrome").hasAttribute("inert"), false);
  editor.focus(); assert.equal(document.activeElement, editor);
  ui.fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  await ui.waitFor(() => assert.doesNotMatch(document.title, /^\*/));
  assert.match(document.body.textContent, /Clean · Published/);
});

test("modal profile is inert, traps focus, and uses rendered reconciliation warning", async (t) => {
  const ui = await mount(t);
  await menuCommand(ui, "Security", /Profile/);
  const dialog = ui.getByRole(document.body, "dialog", { name: "Profile" });
  assert.equal(document.querySelector(".shell-chrome").hasAttribute("inert"), true);
  const saveButton = ui.getByRole(dialog, "button", { name: "Save" }); saveButton.focus();
  await ui.user.keyboard("{Tab}"); assert.equal(document.activeElement, ui.getByLabelText(dialog, "Name"));
  const name = ui.getByLabelText(dialog, "Name"); await ui.user.clear(name); await ui.user.type(name, "Grace");
  await ui.user.click(ui.getByRole(dialog, "button", { name: "Save" }));
  await ui.waitFor(() => ui.getByRole(document.body, "dialog", { name: "Change profile identity?" }));
  assert.match(document.body.textContent, /identity reconciliation/);
  await ui.user.click(ui.getByRole(document.body, "button", { name: "Cancel" }));
  assert.ok(ui.getByRole(document.body, "dialog", { name: "Profile" }));
});

test("pending publication, conflict, and provisional states remain visible and actionable", async (t) => {
  const ui = await mount(t, { openSelectedDocument: async () => ({ content: "pending text", readOnly: true, canEdit: true, publicationState: "pending-publication" }),
    reconnectPendingPublication: async () => ({ content: "pending text", publicationState: "pending-publication" }),
    discardPendingPublication: async () => ({ content: "published", readOnly: true, canEdit: true, publicationState: "target-published" }) });
  await menuCommand(ui, "File", /Open/); await ui.user.type(ui.getByLabelText(document.body, "Document password"), "password"); await ui.user.click(ui.getByRole(document.body, "button", { name: "Open" }));
  const pending = await ui.findByRole(document.body, "dialog", { name: "Manual save pending publication" });
  assert.match(document.body.textContent, /Pending publication · action required/);
  await ui.user.click(ui.getByRole(pending, "button", { name: "Retry publication" }));
  await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "dialog", { name: "Manual save pending publication" })));
  await ui.user.click(ui.getByRole(document.body, "button", { name: "Discard pending save" }));
  await ui.waitFor(() => assert.match(document.body.textContent, /Clean · Published/));
});

test("conflict and provisional openings block ordinary editing with explicit decisions", async (t) => {
  let count = 0;
  const ui = await mount(t, { openSelectedDocument: async () => {
    count += 1;
    return count === 1
      ? { content: "conflicted", readOnly: true, canEdit: true, publicationState: "conflict" }
      : { content: "provisional", readOnly: true, canEdit: true, publicationState: "target-published", provisional: true };
  }, beginDivergenceResolution: async () => ({ content: "merge draft", hasConflicts: true }) });
  await openThroughDialog(ui); const conflict = ui.getByRole(document.body, "dialog", { name: "Divergence needs resolution" });
  assert.match(document.body.textContent, /Conflict · action required/);
  await ui.user.click(ui.getByRole(conflict, "button", { name: "Begin conflict resolution" }));
  await ui.waitFor(() => assert.equal(ui.getByRole(document.body, "textbox", { name: "Document text" }).readOnly, false));
  await openThroughDialog(ui); assert.ok(ui.getByRole(document.body, "dialog", { name: "Provisional save needs attention" }));
  assert.match(document.body.textContent, /Provisional · manual save required/);
});

test("Edit Contents guard failure stays read-only in a focused reason dialog", async (t) => {
  const ui = await mount(t, { enterEditMode: async () => { throw new Error("Editing lease is held by another editor"); } });
  await openThroughDialog(ui); await menuCommand(ui, "Edit", "Edit Contents");
  const guard = await ui.findByRole(document.body, "dialog", { name: "Editing is unavailable" });
  assert.match(guard.textContent, /lease is held/);
  assert.equal(ui.getByRole(document.body, "textbox", { name: "Document text", hidden: true }).readOnly, true);
});

test("automatic lock callback removes plaintext exactly like manual lock", async (t) => {
  const ui = await mount(t);
  await openThroughDialog(ui); assert.match(document.body.textContent, /secret text/);
  ui.listeners.locked({ warning: "Automatically locked." });
  await ui.waitFor(() => assert.doesNotMatch(document.body.textContent, /secret text/));
  assert.match(document.body.textContent, /securely locked/); assert.match(document.body.textContent, /Automatically locked/);
});

test("recovered work remains dirty and pending/conflict decisions stay blocking", async (t) => {
  const ui = await mount(t, { openSelectedDocument: async () => ({ content: "published", readOnly: true, canEdit: true,
    publicationState: "target-published", recovery: { content: "recovered", state: "unsaved", updateTime: 1, cursor: { start: 0, end: 0 } } }),
    restoreRecoveredWork: async () => ({ content: "recovered", readOnly: false, canEdit: true, cursor: { start: 0, end: 0 } }) });
  await menuCommand(ui, "File", /Open/); await ui.user.type(ui.getByLabelText(document.body, "Document password"), "password");
  await ui.user.click(ui.getByRole(document.body, "button", { name: "Open" }));
  await ui.waitFor(() => ui.getByRole(document.body, "dialog", { name: "Recovered work" }));
  await ui.user.click(ui.getByRole(document.body, "button", { name: "Restore unsaved work" }));
  await ui.waitFor(() => assert.match(document.body.textContent, /Dirty · Published/));
  assert.equal(ui.getByRole(document.body, "textbox", { name: "Document text" }).value, "recovered");
});

test("picker-first New mounts #36 security dialog and mismatch never calls creation", async (t) => {
  let creates = 0;
  const ui = await mount(t, { chooseCreateTarget: async () => ({ selected: true }), createDocument: async () => { creates += 1; return null; } });
  await menuCommand(ui, "File", /^New/);
  const dialog = await ui.findByRole(document.body, "dialog", { name: "Secure new document" });
  await ui.user.type(ui.getByLabelText(dialog, "Owner password"), "owner password words");
  await ui.user.type(ui.getByLabelText(dialog, "Confirm owner password"), "mismatching password");
  await ui.user.click(ui.getByLabelText(dialog, "I understand that lost passwords cannot be recovered."));
  await ui.user.click(ui.getByRole(dialog, "button", { name: "Create" }));
  assert.equal(creates, 0); assert.match(ui.getByRole(dialog, "alert").textContent, /do not match/);
});

test("first-run Profile blocks the shell and later migration remains read-only", async (t) => {
  const ui = await mount(t, { getProfile: async () => null });
  const profile = await ui.findByRole(document.body, "dialog", { name: "Set up this client" });
  await ui.waitFor(() => assert.equal(document.querySelector(".shell-chrome").hasAttribute("inert"), true));
  assert.ok(ui.getByRole(profile, "button", { name: "Exit" }));
});

test("migration and authenticated-head decisions render as focused dialogs", async (t) => {
  let opened = 0;
  const ui = await mount(t, { openSelectedDocument: async () => {
    opened += 1;
    return opened === 1
      ? { content: "legacy", readOnly: true, canEdit: false, publicationState: "target-published", migrationRequired: true, migrationWarning: "Legacy format warning" }
      : { content: "observed", readOnly: true, canEdit: false, publicationState: "target-published", headMismatch: { title: "Authenticated head changed", explanation: "Review the authenticated replacement." } };
  } });
  await openThroughDialog(ui); assert.ok(ui.getByRole(document.body, "dialog", { name: "Older container" }));
  await ui.user.click(ui.getByRole(document.body, "button", { name: "Keep read-only" }));
  assert.equal(ui.getByRole(document.body, "textbox", { name: "Document text" }).readOnly, true);
  await openThroughDialog(ui); assert.ok(ui.getByRole(document.body, "dialog", { name: "Authenticated head changed" }));
});

test("Passwords preserves permission defaults and shows invitation passphrase once", async (t) => {
  const ui = await mount(t, { openSelectedDocument: async () => ({ content: "admin", readOnly: false, canEdit: true,
    canAddPasswords: true, canRemovePasswords: true, publicationState: "target-published", managedSlots: [{ slotId: "slot-1", identityName: "Grace", identityEmail: "grace@example.test",
      canEdit: true, canAddPasswords: true, canRemovePasswords: false, mustBeChanged: false }] }) });
  await openThroughDialog(ui); await menuCommand(ui, "Security", /Passwords/);
  const dialog = ui.getByRole(document.body, "dialog", { name: "Passwords" });
  assert.equal(ui.getByLabelText(dialog, "May add passwords").checked, true);
  assert.equal(ui.getByLabelText(dialog, "May remove passwords").checked, false);
  await ui.user.type(ui.getByLabelText(dialog, "Temporary label"), "Collaborator");
  await ui.user.click(ui.getByRole(dialog, "button", { name: "Create invitation" }));
  const result = await ui.findByRole(document.body, "dialog", { name: "Invitation created" });
  assert.match(result.textContent, /temporary secure phrase/); assert.ok(ui.getByRole(result, "button", { name: "Copy" }));
  await ui.user.click(ui.getByRole(result, "button", { name: "Done" }));
  assert.doesNotMatch(document.body.textContent, /temporary secure phrase/);
});

test("invitation claim blocks plaintext and external requests carry the safe filename", async (t) => {
  const ui = await mount(t, { openSelectedDocument: async () => ({ readOnly: true, invitationRequired: true }),
    claimInvitation: async () => ({ content: "claimed content", readOnly: true, canEdit: true, publicationState: "target-published" }),
    openExternalDocument: async () => ({ content: "external", readOnly: true, canEdit: true, publicationState: "target-published" }) });
  await menuCommand(ui, "File", /Open/); await ui.user.type(ui.getByLabelText(document.body, "Document password"), "invite password");
  await ui.user.click(ui.getByRole(document.body, "button", { name: "Open" }));
  const claim = await ui.findByRole(document.body, "dialog", { name: "Claim invitation" });
  assert.doesNotMatch(document.body.textContent, /claimed content/);
  await ui.user.type(ui.getByLabelText(claim, "New password"), "replacement password words");
  await ui.user.click(ui.getByRole(claim, "button", { name: /Replace password/ }));
  await ui.waitFor(() => assert.match(document.body.textContent, /claimed content/));
  ui.listeners.external({ token: "123", name: "external-safe.scpefe" });
  await ui.waitFor(() => ui.getByRole(document.body, "dialog", { name: "Open document" }));
  await ui.user.type(ui.getByLabelText(document.body, "Document password"), "external password");
  await ui.user.click(ui.getByRole(document.body, "button", { name: "Open" }));
  await ui.waitFor(() => assert.equal(document.title, "external-safe.scpefe — SCPEFE"));
  assert.doesNotMatch(document.title, /[\\/]/);
});

test("Backup, Export, Close, and Exit remain menu-driven", async (t) => {
  const calls = [];
  const ui = await mount(t, { backupDocument: async () => { calls.push("backup"); return { backedUp: true }; },
    exportPlaintext: async () => { calls.push("export"); return { exported: true }; }, closeDocument: async () => { calls.push("close"); return true; },
    exitApplication: async () => { calls.push("exit"); return true; } });
  await openThroughDialog(ui); await menuCommand(ui, "File", /Backup/); await menuCommand(ui, "File", /Export Plaintext/);
  await ui.user.click(ui.getByRole(document.body, "button", { name: "Export…" }));
  await menuCommand(ui, "File", /^Close/);
  await menuCommand(ui, "File", /^Exit$/);
  assert.deepEqual(calls, ["backup", "export", "close", "exit"]);
});

test("manual Save-produced pending publication is immediately actionable", async (t) => {
  const ui = await mount(t, { saveDocument: async (content) => ({ content,
    publicationState: "pending-publication" }), reconnectPendingPublication: async () => ({
    content: "secret text changed", publicationState: "target-published" }) });
  await openThroughDialog(ui); await menuCommand(ui, "Edit", "Edit Contents");
  const editor = ui.getByRole(document.body, "textbox", { name: "Document text" });
  ui.fireEvent.change(editor, { target: { value: "secret text changed" } });
  ui.fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  const decision = await ui.findByRole(document.body, "dialog", { name: "Manual save pending publication" });
  assert.match(document.body.textContent, /Pending publication · action required/);
  assert.equal(editor.readOnly, true);
  await ui.user.click(ui.getByRole(decision, "button", { name: "Retry publication" }));
  await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog", { name: "Manual save pending publication" }), null));
  assert.match(document.body.textContent, /Clean · Published/);
});

test("conflict resolution draft is dirty and saveable before another edit", async (t) => {
  const ui = await mount(t, { openSelectedDocument: async () => ({ content: "base", readOnly: true,
    canEdit: true, publicationState: "conflict" }), beginDivergenceResolution: async () => ({
    content: "accepted merge", hasConflicts: false }), saveDivergenceResolution: async (content) => ({
    content, publicationState: "target-published" }) });
  await openThroughDialog(ui);
  await ui.user.click(ui.getByRole(document.body, "button", { name: "Begin conflict resolution" }));
  await ui.waitFor(() => assert.match(document.body.textContent, /Dirty · Conflict/));
  await ui.user.click(ui.getByRole(document.body, "menuitem", { name: "File" }));
  const save = ui.getByRole(ui.getByRole(document.body, "menu", { name: "File" }), "menuitem", { name: /Save/ });
  assert.equal(save.disabled, false); await ui.user.click(save);
  await ui.waitFor(() => assert.match(document.body.textContent, /Clean · Published/));
});

test("regular save result becomes provisional and requires a manual-save decision", async (t) => {
  const ui = await mount(t);
  await openThroughDialog(ui); await menuCommand(ui, "Edit", "Edit Contents");
  ui.listeners.regularSave({ published: true, provisional: true, content: "regular checkpoint" });
  const decision = await ui.findByRole(document.body, "dialog", { name: "Provisional save needs attention" });
  assert.equal(ui.getByRole(document.body, "textbox", { name: "Document text", hidden: true }).value, "regular checkpoint");
  assert.match(document.body.textContent, /Dirty · Provisional · manual save required/);
  assert.ok(ui.getByRole(decision, "button", { name: "Enter edit mode and manually save" }));
});

test("Undo to saved content clears dirty state and Redo restores it", async (t) => {
  const ui = await mount(t); await openThroughDialog(ui); await menuCommand(ui, "Edit", "Edit Contents");
  const editor = ui.getByRole(document.body, "textbox", { name: "Document text" });
  ui.fireEvent.change(editor, { target: { value: "changed once" } });
  await ui.waitFor(() => assert.match(document.title, /^\*/));
  ui.fireEvent.keyDown(window, { key: "z", ctrlKey: true });
  await ui.waitFor(() => assert.equal(editor.value, "secret text"));
  assert.doesNotMatch(document.title, /^\*/); assert.match(document.body.textContent, /Clean · Published/);
  ui.fireEvent.keyDown(window, { key: "y", ctrlKey: true });
  await ui.waitFor(() => assert.equal(editor.value, "changed once"));
  assert.match(document.title, /^\*/); assert.match(document.body.textContent, /Dirty · Published/);
});

test("Find next, Replace, and Replace all operate on the mounted editor", async (t) => {
  const ui = await mount(t, { openSelectedDocument: async () => ({ content: "one two one", readOnly: true,
    canEdit: true, publicationState: "target-published" }), enterEditMode: async () => ({ content: "one two one",
    readOnly: false, canEdit: true, publicationState: "target-published" }) });
  await openThroughDialog(ui); await menuCommand(ui, "Edit", "Edit Contents");
  ui.fireEvent.keyDown(window, { key: "h", ctrlKey: true });
  const dialog = await ui.findByRole(document.body, "dialog", { name: "Find and replace" });
  await ui.user.type(ui.getByLabelText(dialog, "Find"), "one");
  await ui.user.type(ui.getByLabelText(dialog, "Replace with"), "ONE");
  await ui.user.click(ui.getByRole(dialog, "button", { name: "Find next" }));
  const editor = ui.getByRole(document.body, "textbox", { name: "Document text" });
  assert.equal(editor.selectionStart, 0); assert.equal(editor.selectionEnd, 3);
  await ui.user.click(ui.getByRole(dialog, "button", { name: "Replace" }));
  assert.equal(editor.value, "ONE two one");
  await ui.user.click(ui.getByRole(dialog, "button", { name: "Replace all" }));
  assert.equal(editor.value, "ONE two ONE");
});

test("New cancellation, creation retry, and success preserve then replace the session", async (t) => {
  let attempts = 0; let cancels = 0;
  const ui = await mount(t, { chooseCreateTarget: async () => ({ selected: true }),
    cancelCreateTarget: async () => { cancels += 1; }, createDocument: async () => {
      attempts += 1; if (attempts === 1) throw new Error("creation target changed");
      return { created: true, name: "blank.scpefe", opened: { content: "", readOnly: false,
        canEdit: true, publicationState: "target-published" } };
    } });
  await openThroughDialog(ui); await menuCommand(ui, "File", /^New/);
  let dialog = await ui.findByRole(document.body, "dialog", { name: "Secure new document" });
  await ui.user.click(ui.getByRole(dialog, "button", { name: "Cancel" }));
  await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog", { name: "Secure new document" }), null));
  assert.equal(cancels, 1); assert.equal(ui.getByRole(document.body, "textbox", { name: "Document text" }).value, "secret text");
  await menuCommand(ui, "File", /^New/); dialog = await ui.findByRole(document.body, "dialog", { name: "Secure new document" });
  await ui.user.type(ui.getByLabelText(dialog, "Owner password"), "owner password words");
  await ui.user.type(ui.getByLabelText(dialog, "Confirm owner password"), "owner password words");
  await ui.user.click(ui.getByLabelText(dialog, "I understand that lost passwords cannot be recovered."));
  await ui.user.click(ui.getByRole(dialog, "button", { name: "Create" }));
  await ui.waitFor(() => assert.match(ui.getByRole(dialog, "alert").textContent, /target changed/));
  assert.equal(ui.getByLabelText(dialog, "Owner password").value, "owner password words");
  assert.equal(ui.getByRole(document.body, "textbox", { name: "Document text", hidden: true }).value, "secret text");
  await ui.user.click(ui.getByRole(dialog, "button", { name: "Create" }));
  await ui.waitFor(() => assert.equal(document.title, "blank.scpefe — SCPEFE"));
  assert.equal(ui.getByRole(document.body, "textbox", { name: "Document text" }).value, "");
  assert.match(document.body.textContent, /Clean · Published/);
});

test("external open waits behind a creation dialog and chained modal focus stays inside", async (t) => {
  const ui = await mount(t, { chooseCreateTarget: async () => ({ selected: true }) });
  await menuCommand(ui, "File", /^New/);
  const creation = await ui.findByRole(document.body, "dialog", { name: "Secure new document" });
  ui.listeners.external({ token: "queued", name: "queued.scpefe" });
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  assert.equal(ui.getAllByRole(document.body, "dialog").length, 1);
  assert.equal(ui.queryByLabelText(document.body, "Document password"), null);
  await ui.user.click(ui.getByRole(creation, "button", { name: "Cancel" }));
  const incoming = await ui.findByRole(document.body, "dialog", { name: "Open document" });
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  assert.equal(incoming.contains(document.activeElement), true);
  assert.equal(document.activeElement, ui.getByLabelText(incoming, "Document password"));
});

test("password administration needs full authority and consumes update and removal results", async (t) => {
  const slot = { slotId: "ab".repeat(16), identityName: "Grace", identityEmail: "grace@example.test",
    canEdit: true, canAddPasswords: false, canRemovePasswords: false, mustBeChanged: false };
  let updated = false; let removed = false;
  const ui = await mount(t, { openSelectedDocument: async () => ({ content: "admin", readOnly: false, canEdit: true,
    canAddPasswords: true, canRemovePasswords: true, publicationState: "target-published", managedSlots: [slot] }),
    updateSlotPermissions: async () => { updated = true; return { content: "admin", readOnly: false, canEdit: true,
      canAddPasswords: true, canRemovePasswords: true, publicationState: "target-published",
      managedSlots: [{ ...slot, canEdit: false }] }; }, removeSlot: async () => { removed = true; return {
      removed: true, warning: "Removal cannot revoke older replicas." }; } });
  await openThroughDialog(ui); await menuCommand(ui, "Security", /Passwords/);
  const dialog = ui.getByRole(document.body, "dialog", { name: "Passwords" });
  await ui.user.click(ui.getByRole(dialog, "button", { name: "Publish permission changes" }));
  await ui.waitFor(() => assert.equal(updated, true));
  await ui.user.click(ui.getByRole(dialog, "button", { name: /Remove this password slot/ }));
  await ui.user.click(ui.getByRole(dialog, "button", { name: "Confirm slot removal" }));
  await ui.waitFor(() => assert.equal(removed, true)); assert.match(dialog.textContent, /cannot revoke older replicas/);
});

test("permission controls remain disabled unless both administration permissions are present", async (t) => {
  const ui = await mount(t, { openSelectedDocument: async () => ({ content: "admin", readOnly: false, canEdit: true,
    canAddPasswords: true, canRemovePasswords: false, publicationState: "target-published", managedSlots: [{
      slotId: "ab".repeat(16), identityName: "Grace", identityEmail: "grace@example.test", canEdit: true,
      canAddPasswords: false, canRemovePasswords: false, mustBeChanged: false }] }) });
  await openThroughDialog(ui); await menuCommand(ui, "Security", /Passwords/);
  const publish = ui.getByRole(document.body, "button", { name: "Publish permission changes" });
  assert.equal(publish.disabled, true);
});
