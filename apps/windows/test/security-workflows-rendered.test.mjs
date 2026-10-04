import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { SafeBoundaryError } from "../src/error-boundary.mjs";

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
    let serviceOpened = null;
    let editing = false;
    let copied = "";
    let copyAttempts = 0;
    let passwordAttempts = 0;
    let invitationAttempts = 0;
    let permissionAttempts = 0;
    let removalAttempts = 0;
    let reconcileAttempts = 0;
    let claimAttempts = 0;
    let canceledClaims = 0;
    let compactionAttempts = 0;
    let resolveClaim;
    let deferInvitation = false;
    let resolveInvitation;
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
      saveProfile: async (value) => {
        calls.push(["profile", value]);
        if (profile && editing && (value.name !== profile.name || value.email !== profile.email)) {
          throw new Error("Leave edit mode before changing profile identity");
        }
        profile = value; return value;
      },
      reconcileProfile: async () => {
        if (!serviceOpened) return null;
        const mismatch = !serviceOpened.recoverySlot
          && (serviceOpened.slotIdentityName !== profile.name
            || serviceOpened.slotIdentityEmail !== profile.email)
          ? { slotName: serviceOpened.slotIdentityName,
            slotEmail: serviceOpened.slotIdentityEmail, profileName: profile.name,
            profileEmail: profile.email, editingBlocked: true } : null;
        serviceOpened = { ...serviceOpened, readOnly: true,
          canEdit: mismatch ? false : serviceOpened.canEdit,
          ...(mismatch ? { profileMismatch: mismatch } : {}) };
        return serviceOpened;
      },
      getClientSettings: async () => ({ regularSaveEnabled: false,
        regularSaveIntervalMs: 120000 }),
      saveClientSettings: async (value) => value,
      getUnresolvedJournalSummary: async () => ({ total: 0, pendingPublications: 0 }),
      activity: async () => ({}), chooseCreateTarget: async () => null,
      cancelCreateTarget: async () => {}, createDocument: async () => null,
      chooseOpenTarget: async () => ({ selected: true, name: "notes.scpefe" }),
      cancelOpenTarget: async () => {}, openSelectedDocument: async () => {
        serviceOpened = openResult; return serviceOpened;
      },
      unlockDocument: async () => { serviceOpened = openResult; return serviceOpened; },
      claimInvitation: async () => { claimAttempts += 1;
        return new Promise((resolve) => { resolveClaim = resolve; }); },
      cancelInvitationClaim: async () => { canceledClaims += 1; return true; },
      openExternalDocument: async () => null,
      enterEditMode: async () => { editing = true; serviceOpened = {
        ...(serviceOpened ?? editable), readOnly: false, canEdit: true };
        return serviceOpened; },
      changePassword: async (value) => { passwordAttempts += 1;
        if (passwordAttempts === 1) throw new Error("Password publication failed safely");
        calls.push(["password", value]); return editable; },
      assessPasswordPolicy: async (password) =>
        password === "界界界界" ? "accepted"
          : password === "predictable proposed password" ? "predictable"
          : password.length >= 20 ? "accepted" : "minimum-length",
      createInvitation: async (value) => { invitationAttempts += 1;
        if (invitationAttempts === 1) throw new SafeBoundaryError("WEAK_PASSWORD");
        if (invitationAttempts === 2) throw new SafeBoundaryError("PASSWORD_ALREADY_IN_USE");
        if (invitationAttempts === 3) throw new Error("Invitation publication failed safely");
        calls.push(["invitation", value]);
        if (deferInvitation) return new Promise((resolve) => { resolveInvitation = resolve; });
        serviceOpened = { ...editable, managedSlots: [managedSlot,
          { ...managedSlot, slotId: "cd".repeat(16), identityName: "Invite" }] };
        return { created: true, temporaryPassword: "generated invitation secret",
          opened: serviceOpened }; },
      copyInvitationPassphrase: async (value) => {
        copyAttempts += 1;
        if (copyAttempts === 1) throw new Error("Clipboard unavailable");
        copied = value; return true;
      },
      updateSlotPermissions: async (value) => { permissionAttempts += 1;
        if (permissionAttempts === 1) throw new Error("Permission publication failed safely");
        calls.push(["permissions", value]); return editable; },
      removeSlot: async (value) => { removalAttempts += 1;
        if (removalAttempts === 1) throw new Error("Removal publication failed safely");
        calls.push(["remove", value]);
        serviceOpened = { ...editable, managedSlots: [] };
        return { removed: true, warningCode: "SLOT_REMOVED", opened: serviceOpened }; },
      reconcileIdentity: async () => { reconcileAttempts += 1;
        if (reconcileAttempts === 1) throw new Error("Reconciliation publication failed safely");
        calls.push(["reconcile"]); serviceOpened = {
        ...readOnly, slotIdentityName: profile.name, slotIdentityEmail: profile.email,
      }; return serviceOpened; },
      compactDocument: async () => {
        compactionAttempts += 1;
        return compactionAttempts === 1 ? null : { opened: editable,
          previousHead: "previous", head: "compacted" };
      }, migrateDocument: async () => null,
      backupDocument: async () => null, exportPlaintext: async () => null,
      updateWorkingCopy: async () => ({}), lock: async () => { editing = false;
        return { locked: true, journalSaved: true, warning: null }; },
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
    await user.click(ui.getByRole(document.body, "menuitem", { name: "File" }));
    let fileMenu = ui.getByRole(document.body, "menu", { name: "File" });
    assert.equal(ui.getByRole(fileMenu, "menuitem", {
      name: "History Compaction…" }).disabled, true,
    "read-only sessions cannot compact history");
    await user.keyboard("{Escape}");
    await command("Edit", "Edit Contents");
    await user.click(ui.getByRole(document.body, "menuitem", { name: "File" }));
    fileMenu = ui.getByRole(document.body, "menu", { name: "File" });
    assert.equal(ui.getByRole(fileMenu, "menuitem", {
      name: "History Compaction…" }).disabled, false);
    await user.click(ui.getByRole(fileMenu, "menuitem", { name: "History Compaction…" }));
    dialog = await ui.findByRole(document.body, "dialog", {
      name: "Permanently compact document history?" });
    assert.match(dialog.textContent, /creates and verifies an exact backup first/);
    await user.keyboard("{Escape}");
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
    assert.equal(document.activeElement?.getAttribute("aria-label"), "File",
      "canceling the confirmation restores focus to File");
    await command("File", "History Compaction…");
    dialog = await ui.findByRole(document.body, "dialog", {
      name: "Permanently compact document history?" });
    await user.click(ui.getByRole(dialog, "button", {
      name: "Create verified backup and compact" }));
    assert.ok(ui.getByRole(document.body, "dialog", {
      name: "Permanently compact document history?" }),
    "canceling backup selection retains the confirmation for retry");
    await user.click(ui.getByRole(dialog, "button", { name: "Cancel" }));
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
    assert.equal(document.activeElement?.getAttribute("aria-label"), "File");
    await command("File", "History Compaction…");
    dialog = await ui.findByRole(document.body, "dialog", {
      name: "Permanently compact document history?" });
    await user.click(ui.getByRole(dialog, "button", {
      name: "Create verified backup and compact" }));
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
    assert.equal(compactionAttempts, 2);
    await ui.waitFor(() => assert.equal(
      document.activeElement?.getAttribute("aria-label"), "File",
      "successful compaction restores focus to File"));
    assert.match(ui.getByRole(document.body, "status").textContent,
      /Verified backup created and document history compacted/);
    await command("Security", /Passwords/);
    dialog = await ui.findByRole(document.body, "dialog", { name: "Passwords" });
    assert.equal(ui.queryByRole(dialog, "heading", { name: "History compaction" }), null);
    assert.equal(ui.getByLabelText(dialog, "New password").getAttribute("minlength"), null);
    assert.equal(ui.getByLabelText(dialog, "Confirm new password")
      .getAttribute("minlength"), null);
    for (const name of ["Current password", "New password", "Confirm new password"]) {
      const input = ui.getByLabelText(dialog, name);
      assert.equal(input.type, "password");
      await user.click(ui.getByRole(dialog, "button", { name: `Show ${name.toLowerCase()}` }));
      assert.equal(input.type, "text");
      await user.click(ui.getByRole(dialog, "button", { name: `Hide ${name.toLowerCase()}` }));
      assert.equal(input.type, "password");
    }
    await user.type(ui.getByLabelText(dialog, "Current password"), "current password words");
    await user.type(ui.getByLabelText(dialog, "New password"),
      "predictable proposed password");
    await user.type(ui.getByLabelText(dialog, "Confirm new password"),
      "predictable proposed password");
    await user.click(ui.getByRole(dialog, "button", { name: "Change password" }));
    assert.match(ui.getByRole(dialog, "alert").textContent, /too predictable/i);
    assert.equal(passwordAttempts, 0,
      "a rejected proposed password never reaches the change boundary");
    await user.clear(ui.getByLabelText(dialog, "New password"));
    await user.clear(ui.getByLabelText(dialog, "Confirm new password"));
    await user.type(ui.getByLabelText(dialog, "New password"), "current password words");
    await user.type(ui.getByLabelText(dialog, "Confirm new password"), "current password words");
    await user.click(ui.getByRole(dialog, "button", { name: "Change password" }));
    assert.match(ui.getByRole(dialog, "alert").textContent, /must differ from the current/i);
    assert.equal(document.activeElement === ui.getByLabelText(dialog, "New password"), true);
    await user.clear(ui.getByLabelText(dialog, "New password"));
    await user.clear(ui.getByLabelText(dialog, "Confirm new password"));
    await user.type(ui.getByLabelText(dialog, "New password"), "界界界界");
    await user.type(ui.getByLabelText(dialog, "Confirm new password"),
      "界界界界");
    await user.click(ui.getByRole(dialog, "button", { name: "Change password" }));
    assert.match((await ui.findByRole(dialog, "alert")).textContent,
      /operation could not be completed safely/i);
    assert.equal(ui.getByLabelText(dialog, "Current password").value,
      "current password words", "failed password publication retains a recoverable input");
    await user.click(ui.getByRole(dialog, "button", { name: "Change password" }));
    await ui.waitFor(() => assert.equal(calls.some(([name]) => name === "password"), true));
    assert.equal(calls.find(([name]) => name === "password")[1].newPassword, "界界界界",
      "the native-accepted multibyte password reaches the change boundary");
    assert.equal(ui.getByLabelText(dialog, "Current password").value, "",
      "successful password change clears secrets immediately");

    const invitationForm = ui.getByRole(dialog, "heading",
      { name: "Invite another person" }).closest("form");
    assert.equal(ui.getByLabelText(invitationForm, "May edit").checked, false);
    assert.equal(ui.getByLabelText(invitationForm, "May add passwords").checked, false);
    assert.equal(ui.getByLabelText(invitationForm, "May remove passwords").checked, false,
      "new invitations begin with least-privilege permission defaults");
    const temporary = ui.getByLabelText(invitationForm,
      "Temporary passphrase (leave blank to generate)");
    assert.equal(temporary.type, "password");
    await user.click(ui.getByRole(invitationForm, "button", { name: "Show temporary passphrase" }));
    assert.equal(temporary.type, "text");
    await user.click(ui.getByRole(invitationForm, "button", { name: "Hide temporary passphrase" }));
    await user.type(ui.getByLabelText(invitationForm, "Temporary label (required)"), "New colleague");
    await user.type(ui.getByLabelText(invitationForm,
      "Temporary passphrase (leave blank to generate)"), "predictable proposed password");
    await user.click(ui.getByRole(invitationForm, "button", { name: "Create invitation" }));
    assert.match(ui.getByRole(invitationForm, "alert").textContent, /too predictable/i);
    assert.equal(invitationAttempts, 0,
      "a rejected proposed password never reaches the invitation boundary");
    await user.clear(ui.getByLabelText(invitationForm,
      "Temporary passphrase (leave blank to generate)"));
    await user.type(ui.getByLabelText(invitationForm,
      "Temporary passphrase (leave blank to generate)"), "manual temporary phrase 2026!");
    await user.click(ui.getByLabelText(invitationForm, "May edit"));
    await user.click(ui.getByRole(invitationForm, "button", { name: "Create invitation" }));
    await ui.waitFor(() => assert.equal(invitationAttempts, 1));
    assert.equal(ui.getByLabelText(invitationForm, "Temporary label (required)").value,
      "New colleague");
    const temporaryInput = ui.getByLabelText(invitationForm,
      "Temporary passphrase (leave blank to generate)");
    assert.equal(temporaryInput.value, "manual temporary phrase 2026!");
    await ui.waitFor(() => assert.equal(document.activeElement === temporaryInput, true));
    assert.match(temporaryInput.getAttribute("aria-describedby"), /invitation-password-error/);
    await user.click(ui.getByRole(invitationForm, "button", { name: "Create invitation" }));
    await ui.waitFor(() => assert.equal(invitationAttempts, 2));
    await ui.waitFor(() => assert.equal(document.activeElement === temporaryInput, true));
    await user.clear(temporaryInput);
    await user.click(ui.getByRole(invitationForm, "button", { name: "Create invitation" }));
    await ui.waitFor(() => assert.equal(invitationAttempts, 3));
    await ui.waitFor(() => assert.equal(temporaryInput.getAttribute("aria-describedby"),
      "temporary-password-policy", "generic publication errors remain form-level"));
    await user.click(ui.getByRole(invitationForm, "button", { name: "Create invitation" }));
    const once = await ui.findByLabelText(dialog, "One-time temporary passphrase");
    assert.equal(once.value, "generated invitation secret");
    assert.doesNotMatch(ui.getByRole(document.body, "status").textContent,
      /generated invitation secret/);
    await user.click(ui.getByRole(dialog, "button", { name: "Copy" }));
    assert.match((await ui.findByRole(dialog, "alert")).textContent,
      /operation could not be completed safely/i);
    assert.equal(ui.getByLabelText(dialog, "One-time temporary passphrase").value,
      "generated invitation secret", "copy failure keeps the one-time result recoverable");
    await user.click(ui.getByRole(dialog, "button", { name: "Copy" }));
    assert.equal(copied, "generated invitation secret");
    await user.click(ui.getByRole(dialog, "button", { name: "Done" }));
    await ui.waitFor(() => assert.equal(document.body.textContent.includes(
      "generated invitation secret"), false));

    async function beginDeferredInvitation(label) {
      deferInvitation = true;
      resolveInvitation = null;
      const form = ui.getByRole(dialog, "heading",
        { name: "Invite another person" }).closest("form");
      await user.type(ui.getByLabelText(form, "Temporary label (required)"), label);
      await user.click(ui.getByRole(form, "button", { name: "Create invitation" }));
      await ui.waitFor(() => assert.equal(typeof resolveInvitation, "function"));
    }
    async function finishDeferredInvitation(secret) {
      resolveInvitation({ created: true, temporaryPassword: secret,
        opened: { ...editable, managedSlots: [managedSlot] } });
      const result = await ui.findByLabelText(dialog, "One-time temporary passphrase");
      assert.equal(result.value, secret,
        "a committed invitation must present its one-time passphrase");
      deferInvitation = false;
      await user.click(ui.getByRole(dialog, "button", { name: "Done" }));
    }
    await beginDeferredInvitation("Close race");
    await user.click(ui.getByRole(dialog, "button", { name: "Close" }));
    assert.equal(ui.queryByRole(document.body, "dialog", { name: "Passwords" }) !== null,
      true, "Close cannot discard a passphrase while publication is pending");
    await finishDeferredInvitation("close-race-secret");

    await beginDeferredInvitation("Escape race");
    await user.click(ui.getByLabelText(dialog,
      "Temporary passphrase (leave blank to generate)"));
    assert.equal(dialog.contains(document.activeElement), true);
    await user.keyboard("{Escape}");
    assert.equal(ui.queryByRole(document.body, "dialog", { name: "Passwords" }) !== null,
      true, "Escape cannot discard a passphrase while publication is pending");
    await finishDeferredInvitation("escape-race-secret");

    const permissionGroup = ui.getByRole(dialog, "group",
      { name: /Permissions for Grace/ });
    await user.click(ui.getByLabelText(permissionGroup, "May add passwords"));
    await user.click(ui.getByRole(permissionGroup, "button",
      { name: "Publish permission changes" }));
    assert.match((await ui.findByRole(dialog, "alert")).textContent,
      /operation could not be completed safely/i);
    await user.click(ui.getByRole(permissionGroup, "button",
      { name: "Publish permission changes" }));
    await ui.waitFor(() => assert.equal(calls.some(([name]) => name === "permissions"), true));
    await user.click(ui.getByRole(dialog, "button", { name: "Remove this password slot…" }));
    const removalAlert = ui.getByRole(dialog, "alert");
    await user.click(ui.getByRole(removalAlert, "button", { name: "Confirm slot removal" }));
    assert.match((await ui.findByRole(dialog, "alert")).textContent,
      /operation could not be completed safely/i);
    await user.click(ui.getByRole(dialog, "button", { name: "Remove this password slot…" }));
    const retryRemovalAlert = ui.getByText(dialog,
      /Removal blocks this password only in the updated document/).closest("[role='alert']");
    await user.click(ui.getByRole(retryRemovalAlert, "button",
      { name: "Confirm slot removal" }));
    await ui.waitFor(() => assert.equal(calls.some(([name]) => name === "remove"), true));
    const dismissForm = ui.getByRole(dialog, "heading",
      { name: "Invite another person" }).closest("form");
    await user.type(ui.getByLabelText(dismissForm, "Temporary label (required)"), "Dismissed result");
    await user.click(ui.getByRole(dismissForm, "button", { name: "Create invitation" }));
    await ui.findByLabelText(dialog, "One-time temporary passphrase");
    await user.keyboard("{Escape}");
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
    assert.equal(document.body.textContent.includes("generated invitation secret"), false,
      "Escape dismisses and clears the one-time secret");

    await command("Security", /Profile/);
    dialog = await ui.findByRole(document.body, "dialog", { name: "Profile" });
    const name = ui.getByLabelText(dialog, "Name");
    await user.clear(name); await user.type(name, "Ada Lovelace");
    await user.click(ui.getByRole(dialog, "button", { name: "Save local profile" }));
    assert.ok(await ui.findByRole(dialog, "alert"));
    await user.click(ui.getByRole(dialog, "button", { name: "Save identity change" }));
    await ui.waitFor(() => assert.match(ui.getByRole(dialog, "alert").textContent,
      /operation could not be completed safely/i));
    assert.equal(document.activeElement ===
      ui.getByRole(dialog, "button", { name: "Save identity change" }), true,
      "failed identity save focuses its retry action");
    await user.click(ui.getByRole(dialog, "button", { name: "Go back" }));
    await user.click(ui.getByRole(dialog, "button", { name: "Cancel" }));
    assert.equal(profile.name, "Ada", "canceling a failed later profile edit retains the profile");
    await command("Security", "Lock");
    openResult = readOnly;
    await command("Security", "Unlock");
    dialog = await ui.findByRole(document.body, "dialog", { name: "Unlock document" });
    await user.type(ui.getByLabelText(dialog, "Password"), "owner password words");
    await user.click(ui.getByRole(dialog, "button", { name: "Unlock" }));
    await command("Security", /Profile/);
    dialog = await ui.findByRole(document.body, "dialog", { name: "Profile" });
    const retryName = ui.getByLabelText(dialog, "Name");
    await user.clear(retryName); await user.type(retryName, "Ada Lovelace");
    await user.click(ui.getByRole(dialog, "button", { name: "Save local profile" }));
    await user.click(await ui.findByRole(dialog, "button", { name: "Save identity change" }));
    const mismatch = await ui.findByRole(document.body, "dialog", { name: "Profile mismatch" });
    await user.click(ui.getByRole(mismatch, "button", { name: "Open Passwords to reconcile" }));
    dialog = await ui.findByRole(document.body, "dialog", { name: "Passwords" });
    assert.equal(ui.queryByRole(dialog, "heading", { name: "Change this password" }), null,
      "authoritative mismatch blocks password administration");
    await user.click(ui.getByRole(dialog, "button", { name: "Reconcile identity and publish" }));
    assert.match((await ui.findByRole(dialog, "alert")).textContent,
      /operation could not be completed safely/i);
    await user.click(ui.getByRole(dialog, "button", { name: "Reconcile identity and publish" }));
    await ui.waitFor(() => assert.equal(calls.some(([name]) => name === "reconcile"), true));

    await user.click(ui.getByRole(dialog, "button", { name: "Close" }));
    serviceOpened = { ...serviceOpened, managedSlots: Array.from({ length: 7 },
      (_, index) => ({ ...managedSlot, slotId: index.toString(16).padStart(32, "0") })) };
    await command("Edit", "Edit Contents");
    await command("Security", /Passwords/);
    dialog = await ui.findByRole(document.body, "dialog", { name: "Passwords" });
    assert.match(ui.getByRole(dialog, "note").textContent,
      /limit of eight ordinary password slots/);
    assert.equal(ui.queryByRole(dialog, "heading", { name: "Invite another person" }), null);
    await user.click(ui.getByRole(dialog, "button", { name: "Close" }));

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
    assert.equal(ui.queryByRole(dialog, "heading", { name: "History compaction" }), null);
    assert.equal(ui.getByRole(dialog, "group", { name: /Permissions for Grace/ }).disabled,
      true, "view-only slots cannot change another slot's permissions");
    await user.click(ui.getByRole(dialog, "button", { name: "Close" }));
    listeners.locked({ locked: true, journalSaved: true, warning: null });
    openResult = { ...readOnly, recoverySlot: true, canEdit: true,
      canAddPasswords: true, canRemovePasswords: true,
      slotIdentityName: "", slotIdentityEmail: "" };
    await command("Security", "Unlock");
    dialog = await ui.findByRole(document.body, "dialog", { name: "Unlock document" });
    await user.type(ui.getByLabelText(dialog, "Password"), "recovery password words");
    await user.click(ui.getByRole(dialog, "button", { name: "Unlock" }));
    await command("Security", /Passwords/);
    dialog = await ui.findByRole(document.body, "dialog", { name: "Passwords" });
    assert.match(dialog.textContent, /This is the recovery\/master slot/);
    assert.equal(ui.queryByRole(dialog, "heading",
      { name: "Identity reconciliation required" }), null);
    await user.click(ui.getByRole(dialog, "button", { name: "Close" }));

    await command("Security", "Lock");
    openResult = { ...readOnly, readOnly: true, canEdit: false,
      migrationRequired: true, migrationCanEdit: true,
      migrationWarning: "This older container requires a verified backup before migration." };
    await command("Security", "Unlock");
    dialog = await ui.findByRole(document.body, "dialog", { name: "Unlock document" });
    await user.type(ui.getByLabelText(dialog, "Password"), "older container password words");
    await user.click(ui.getByRole(dialog, "button", { name: "Unlock" }));
    const migration = await ui.findByRole(document.body, "dialog", { name: "Older container" });
    assert.match(ui.getByRole(migration, "alert").textContent,
      /verified exact backup is required/i);
    assert.ok(ui.getByRole(migration, "button",
      { name: "Create verified backup and migrate…" }));
    await user.click(ui.getByRole(migration, "button", { name: "Keep read-only and close" }));
    await ui.waitFor(() => assert.equal(
      ui.getByLabelText(document.body, "Document state").textContent, "Locked"));
    assert.equal(ui.getByRole(document.body, "textbox", { name: "Document text" }).value, "",
      "declining migration immediately removes the older document plaintext");

    openResult = readOnly;
    await command("Security", "Unlock");
    dialog = await ui.findByRole(document.body, "dialog", { name: "Unlock document" });
    await user.type(ui.getByLabelText(dialog, "Password"), "owner password words");
    await user.click(ui.getByRole(dialog, "button", { name: "Unlock" }));
    openResult = { readOnly: true, invitationRequired: true };
    await command("File", /Open/);
    dialog = await ui.findByRole(document.body, "dialog", { name: "Open document" });
    await user.type(ui.getByLabelText(dialog, "Password"), "invitation password words");
    await user.click(ui.getByRole(dialog, "button", { name: "Open" }));
    dialog = await ui.findByRole(document.body, "dialog", { name: "Claim invitation" });
    for (const name of ["New password", "Confirm new password"]) {
      const input = ui.getByLabelText(dialog, name);
      assert.equal(input.type, "password");
      await user.click(ui.getByRole(dialog, "button", { name: `Show ${name.toLowerCase()}` }));
      assert.equal(input.type, "text");
      await user.click(ui.getByRole(dialog, "button", { name: `Hide ${name.toLowerCase()}` }));
    }
    await user.type(ui.getByLabelText(dialog, "New password"), "界界界界");
    await user.click(ui.getByRole(dialog, "button", { name: "Cancel" }));
    await ui.waitFor(() => assert.equal(ui.queryByRole(document.body, "dialog"), null));
    assert.equal(canceledClaims, 1);
    assert.equal(ui.getByRole(document.body, "textbox", { name: "Document text" }).value,
      "protected content", "canceling a staged claim retains the prior document");
    assert.equal(document.body.textContent.includes("界界界界"), false);

    await command("File", /Open/);
    dialog = await ui.findByRole(document.body, "dialog", { name: "Open document" });
    await user.type(ui.getByLabelText(dialog, "Password"), "invitation password words");
    await user.click(ui.getByRole(dialog, "button", { name: "Open" }));
    dialog = await ui.findByRole(document.body, "dialog", { name: "Claim invitation" });
    await user.type(ui.getByLabelText(dialog, "New password"), "界界界界");
    await user.type(ui.getByLabelText(dialog, "Confirm new password"), "界界界界");
    await user.click(ui.getByRole(dialog, "button", { name: "Replace password and claim identity" }));
    await ui.waitFor(() => assert.equal(claimAttempts, 1));
    listeners.locked({ locked: true, journalSaved: true, warningCode: null });
    resolveClaim({ ...readOnly, content: "claim completed too late" });
    await ui.waitFor(() => assert.equal(
      ui.getByLabelText(document.body, "Document state").textContent, "Locked"));
    assert.equal(ui.getByRole(document.body, "textbox", { name: "Document text" }).value, "");
  });
