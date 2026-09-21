import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

test("mounted security dialogs gate profile, filter administration, and clear one-time secrets",
  async (t) => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
      url: "https://scpefe.invalid/",
    });
    const globalKeys = ["window", "document", "HTMLElement", "Node", "MutationObserver",
      "FormData", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
      "IS_REACT_ACT_ENVIRONMENT"];
    const priorGlobals = new Map(globalKeys.map((key) =>
      [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const frames = new Map();
    let nextFrame = 0;
    let mountedRoot;
    t.after(async () => {
      mountedRoot?.unmount();
      await Promise.resolve();
      frames.clear();
      dom.window.close();
      for (const [key, descriptor] of priorGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    });
    const raf = (callback) => {
      const id = ++nextFrame;
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
      requestAnimationFrame: raf, cancelAnimationFrame: (id) => frames.delete(id),
      IS_REACT_ACT_ENVIRONMENT: true });

    let profile = null;
    let copied = "";
    const calls = [];
    const listeners = {};
    const managedSlot = { slotId: "ab".repeat(16), identityName: "Grace",
      identityEmail: "grace@example.test", canEdit: true, canAddPasswords: false,
      canRemovePasswords: false, mustBeChanged: false };
    const readOnly = { content: "protected content", readOnly: true, canEdit: true,
      canAddPasswords: true, canRemovePasswords: true,
      publicationState: "target-published", targetName: "notes.scpefe",
      slotIdentityName: "Ada", slotIdentityEmail: "ada@example.test",
      managedSlots: [managedSlot] };
    const editable = { ...readOnly, readOnly: false };
    let openResult = readOnly;
    const listen = (name, listener) => {
      listeners[name] = listener;
      return () => { delete listeners[name]; };
    };
    dom.window.scpefe = {
      getProfile: async () => profile,
      saveProfile: async (value) => { calls.push(["profile", value]); profile = value; return value; },
      getClientSettings: async () => ({ regularSaveEnabled: false,
        regularSaveIntervalMs: 120000 }),
      saveClientSettings: async (value) => value,
      getUnresolvedJournalSummary: async () => ({ total: 0, pendingPublications: 0 }),
      activity: async () => ({}), chooseCreateTarget: async () => null,
      cancelCreateTarget: async () => {}, createDocument: async () => null,
      chooseOpenTarget: async () => ({ selected: true, name: "notes.scpefe" }),
      cancelOpenTarget: async () => {}, openSelectedDocument: async () => openResult,
      unlockDocument: async () => openResult, openExternalDocument: async () => null,
      enterEditMode: async () => editable,
      changePassword: async (value) => { calls.push(["password", value]); return editable; },
      createInvitation: async (value) => { calls.push(["invitation", value]);
        return { created: true, temporaryPassword: "generated invitation secret" }; },
      copyInvitationPassphrase: async (value) => { copied = value; return true; },
      updateSlotPermissions: async (value) => { calls.push(["permissions", value]); return editable; },
      removeSlot: async (value) => { calls.push(["remove", value]);
        return { removed: true, warning: "removed safely" }; },
      reconcileIdentity: async () => { calls.push(["reconcile"]); return {
        ...readOnly, slotIdentityName: profile.name, slotIdentityEmail: profile.email,
      }; },
      compactDocument: async () => null, migrateDocument: async () => null,
      backupDocument: async () => null, exportPlaintext: async () => null,
      updateWorkingCopy: async () => ({}), lock: async () => ({ locked: true,
        journalSaved: true, warning: null }),
      onLocked: (listener) => listen("locked", listener),
      onJournalWarning: (listener) => listen("warning", listener),
      onRegularSave: (listener) => listen("regular", listener),
      onExternalOpenRequested: (listener) => listen("external", listener),
      onUnresolvedJournalSummary: (listener) => listen("summary", listener),
      onSwitchRetained: (listener) => listen("switch", listener),
    };
    dom.window[Symbol.for("scpefe.renderer.mount")] = (root) => { mountedRoot = root; };
    const assets = await fs.readdir(new URL("../dist/assets/", import.meta.url));
    const script = assets.find((entry) => /^index-.*\.js$/.test(entry));
    await import(`${pathToFileURL(path.resolve("dist/assets", script)).href}?security-workflows`);
    const ui = await import("@testing-library/dom");
    const userEvent = (await import("@testing-library/user-event")).default;
    const user = userEvent.setup({ document: dom.window.document });

    let dialog = await ui.findByRole(document.body, "dialog", { name: "Set up this client" });
    assert.equal(dialog.querySelector("[aria-modal='true']") !== null, false);
    assert.ok(ui.getByRole(dialog, "button", { name: "Exit application" }));
    await user.type(ui.getByLabelText(dialog, "Name"), "Ada");
    await user.type(ui.getByLabelText(dialog, "Email"), "ada@example.test");
    await user.type(ui.getByLabelText(dialog, "Device name"), "Desk");
    await user.click(ui.getByRole(dialog, "button", { name: "Save local profile" }));
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));

    async function command(menuName, itemName) {
      await user.click(ui.getByRole(document.body, "menuitem", { name: menuName }));
      const menu = ui.getByRole(document.body, "menu", { name: menuName });
      await user.click(ui.getByRole(menu, "menuitem", { name: itemName }));
    }
    await command("Security", /Profile/);
    dialog = await ui.findByRole(document.body, "dialog", { name: "Profile" });
    const device = ui.getByLabelText(dialog, "Device name");
    await user.clear(device); await user.type(device, "Laptop");
    await user.click(ui.getByRole(dialog, "button", { name: "Save local profile" }));
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
    assert.equal(calls.at(-1)[1].deviceName, "Laptop", "device-only change needs no warning");

    await command("File", /Open/);
    dialog = await ui.findByRole(document.body, "dialog", { name: "Open document" });
    await user.type(ui.getByLabelText(dialog, "Password"), "current password words");
    await user.click(ui.getByRole(dialog, "button", { name: "Open" }));
    await command("Edit", "Edit Contents");
    await command("Security", /Passwords/);
    dialog = await ui.findByRole(document.body, "dialog", { name: "Passwords" });
    await user.type(ui.getByLabelText(dialog, "Current password"), "current password words");
    await user.type(ui.getByLabelText(dialog, "New password"), "replacement password words");
    await user.type(ui.getByLabelText(dialog, "Confirm new password"),
      "replacement password words");
    await user.click(ui.getByRole(dialog, "button", { name: "Change password" }));
    await ui.waitFor(() => assert.equal(calls.some(([name]) => name === "password"), true));
    assert.equal(ui.getByLabelText(dialog, "Current password").value, "",
      "successful password change clears secrets immediately");

    const invitationForm = ui.getByRole(dialog, "heading",
      { name: "Invite another person" }).closest("form");
    await user.type(ui.getByLabelText(invitationForm, "Temporary label"), "New colleague");
    await user.click(ui.getByLabelText(invitationForm, "May edit"));
    await user.click(ui.getByRole(invitationForm, "button", { name: "Create invitation" }));
    const once = await ui.findByLabelText(dialog, "One-time temporary passphrase");
    assert.equal(once.value, "generated invitation secret");
    assert.doesNotMatch(ui.getByRole(document.body, "status").textContent,
      /generated invitation secret/);
    await user.click(ui.getByRole(dialog, "button", { name: "Copy" }));
    assert.equal(copied, "generated invitation secret");
    await user.click(ui.getByRole(dialog, "button", { name: "Done" }));
    await ui.waitFor(() => assert.equal(document.body.textContent.includes(
      "generated invitation secret"), false));
    const permissionGroup = ui.getByRole(dialog, "group",
      { name: /Permissions for Grace/ });
    await user.click(ui.getByLabelText(permissionGroup, "May add passwords"));
    await user.click(ui.getByRole(permissionGroup, "button",
      { name: "Publish permission changes" }));
    await ui.waitFor(() => assert.equal(calls.some(([name]) => name === "permissions"), true));
    await user.click(ui.getByRole(dialog, "button", { name: "Remove this password slot…" }));
    const removalAlert = ui.getByRole(dialog, "alert");
    await user.click(ui.getByRole(removalAlert, "button", { name: "Confirm slot removal" }));
    await ui.waitFor(() => assert.equal(calls.some(([name]) => name === "remove"), true));
    await user.click(ui.getByRole(dialog, "button", { name: "Close" }));

    await command("Security", /Profile/);
    dialog = await ui.findByRole(document.body, "dialog", { name: "Profile" });
    const name = ui.getByLabelText(dialog, "Name");
    await user.clear(name); await user.type(name, "Ada Lovelace");
    await user.click(ui.getByRole(dialog, "button", { name: "Save local profile" }));
    assert.ok(await ui.findByRole(dialog, "alert"));
    await user.click(ui.getByRole(dialog, "button", { name: "Save identity change" }));
    const mismatch = await ui.findByRole(document.body, "dialog", { name: "Profile mismatch" });
    await user.click(ui.getByRole(mismatch, "button", { name: "Open Passwords to reconcile" }));
    dialog = await ui.findByRole(document.body, "dialog", { name: "Passwords" });
    await user.click(ui.getByRole(dialog, "button", { name: "Reconcile identity and publish" }));
    await ui.waitFor(() => assert.equal(calls.some(([name]) => name === "reconcile"), true));

    listeners.locked({ locked: true, journalSaved: true, warning: null });
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
    assert.equal(document.querySelectorAll("input[type='password']").length, 0,
      "locking unmounts all secret fields");

    openResult = { ...readOnly, canEdit: false, canAddPasswords: false,
      canRemovePasswords: false, slotIdentityName: profile.name,
      slotIdentityEmail: profile.email };
    await command("Security", "Unlock");
    dialog = await ui.findByRole(document.body, "dialog", { name: "Unlock document" });
    await user.type(ui.getByLabelText(dialog, "Password"), "view only password words");
    await user.click(ui.getByRole(dialog, "button", { name: "Unlock" }));
    await command("Security", /Passwords/);
    dialog = await ui.findByRole(document.body, "dialog", { name: "Passwords" });
    assert.ok(ui.getByRole(dialog, "heading", { name: "Change this password" }),
      "every authenticated slot may change its own password");
    assert.equal(ui.queryByRole(dialog, "heading", { name: "Invite another person" }), null);
    assert.equal(ui.queryByRole(dialog, "button", { name: "Remove this password slot…" }), null);
    assert.equal(ui.queryByRole(dialog, "button", { name: "Compact history…" }), null);
    assert.equal(ui.getByRole(dialog, "group", { name: /Permissions for Grace/ }).disabled,
      true, "view-only slots cannot change another slot's permissions");
  });
