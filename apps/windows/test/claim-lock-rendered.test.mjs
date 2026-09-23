import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

test("mounted lock-start clears invitation secrets before a late claim can settle",
  async (t) => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
      url: "https://scpefe.invalid/",
    });
    const globalKeys = ["window", "document", "HTMLElement", "Node", "MutationObserver",
      "FormData", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
      "IS_REACT_ACT_ENVIRONMENT"];
    const priorGlobals = new Map(globalKeys.map((key) =>
      [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    let mountedRoot;
    t.after(async () => {
      mountedRoot?.unmount();
      await Promise.resolve();
      dom.window.close();
      for (const [key, descriptor] of priorGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document,
      HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver, FormData: dom.window.FormData,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      requestAnimationFrame: (callback) => { queueMicrotask(() => callback(performance.now()));
        return 1; },
      cancelAnimationFrame: () => {}, IS_REACT_ACT_ENVIRONMENT: true });

    const listeners = {};
    let openCount = 0;
    let disposedClaims = 0;
    let claimCalls = 0;
    let rejectClaim;
    const ordinary = { content: "original plaintext", readOnly: true, canEdit: true,
      publicationState: "target-published", targetName: "original.scpefe" };
    const lockResult = { locked: true, journalSaved: true, warning: null };
    const hostLock = () => {
      disposedClaims += 1;
      listeners.lockStarted();
      listeners.locked(lockResult);
      return lockResult;
    };
    const listen = (name, listener) => {
      listeners[name] = listener;
      return () => { delete listeners[name]; };
    };
    dom.window.scpefe = {
      getProfile: async () => ({ name: "Ada", email: "ada@example.test", deviceName: "Desk" }),
      saveProfile: async (value) => value, reconcileProfile: async () => null,
      getClientSettings: async () => ({ regularSaveEnabled: false,
        regularSaveIntervalMs: 120000 }),
      saveClientSettings: async (value) => value,
      getUnresolvedJournalSummary: async () => ({ total: 0, pendingPublications: 0 }),
      activity: async () => ({}),
      chooseCreateTarget: async () => null, cancelCreateTarget: async () => {},
      createDocument: async () => null,
      chooseOpenTarget: async () => ({ selected: true, name: "selected.scpefe" }),
      cancelOpenTarget: async () => {},
      openSelectedDocument: async () => {
        openCount += 1;
        return openCount === 2 ? ordinary
          : { readOnly: true, invitationRequired: true, targetName: "invitation.scpefe" };
      },
      unlockDocument: async () => ordinary,
      openExternalDocument: async () => null,
      claimInvitation: () => {
        claimCalls += 1;
        return new Promise((_resolve, reject) => { rejectClaim = () => reject(
          Object.assign(new Error("The session locked while the claim was running"),
            { code: "DOCUMENT_SESSION_INVALIDATED" })); });
      },
      cancelInvitationClaim: async () => { disposedClaims += 1; return true; },
      enterEditMode: async () => ({ ...ordinary, readOnly: false }),
      passwordMeetsPolicy: async (password) => password.length >= 20,
      updateWorkingCopy: async () => ({}), saveDocument: async () => null,
      backupDocument: async () => null, exportPlaintext: async () => null,
      lock: async () => hostLock(),
      onLockStarted: (listener) => listen("lockStarted", listener),
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
    await import(`${pathToFileURL(path.resolve("dist/assets", script)).href}?claim-lock`);
    const ui = await import("@testing-library/dom");
    const userEvent = (await import("@testing-library/user-event")).default;
    const user = userEvent.setup({ document: dom.window.document });
    await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "menubar")));

    const openInvitation = async () => {
      await user.click(ui.getByRole(document.body, "menuitem", { name: "File" }));
      await user.click(ui.getByRole(ui.getByRole(document.body, "menu", { name: "File" }),
        "menuitem", { name: /Open/ }));
      let dialog = await ui.findByRole(document.body, "dialog", { name: "Open document" });
      await user.type(ui.getByLabelText(dialog, "Password"), "temporary password words");
      await user.click(ui.getByRole(dialog, "button", { name: "Open" }));
      dialog = await ui.findByRole(document.body, "dialog", { name: "Claim invitation" });
      const password = ui.getByLabelText(dialog, "New password");
      const confirmation = ui.getByLabelText(dialog, "Confirm new password");
      await user.type(password, "private replacement words");
      await user.type(confirmation, "private replacement words");
      return { dialog, password, confirmation };
    };

    let claim = await openInvitation();
    await user.clear(claim.confirmation);
    await user.type(claim.confirmation, "private replacement typo");
    await user.click(ui.getByRole(claim.dialog, "button",
      { name: "Replace password and claim identity" }));
    assert.match(ui.getByRole(claim.dialog, "alert").textContent, /do not match/i);
    assert.equal(document.activeElement === claim.confirmation, true);
    assert.equal(claimCalls, 0);
    await user.clear(claim.confirmation);
    await user.type(claim.confirmation, "private replacement words");
    await user.click(ui.getByRole(claim.dialog, "button",
      { name: "Replace password and claim identity" }));
    await ui.waitFor(() => assert.equal(claimCalls, 1));
    disposedClaims += 1;
    listeners.lockStarted();
    assert.equal(claim.password.value, "");
    assert.equal(claim.confirmation.value, "");
    assert.equal(claim.dialog.isConnected, false);
    assert.equal(document.querySelectorAll("input[type='password']").length, 0);
    assert.equal(ui.getByLabelText(document.body, "Document state").textContent, "No document");
    rejectClaim();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ui.getByRole(document.body, "textbox", { name: "Document text" }).value, "",
      "a late claim failure cannot re-expose plaintext after lock teardown");
    listeners.locked(lockResult);

    await user.click(ui.getByRole(document.body, "menuitem", { name: "File" }));
    await user.click(ui.getByRole(ui.getByRole(document.body, "menu", { name: "File" }),
      "menuitem", { name: /Open/ }));
    let dialog = await ui.findByRole(document.body, "dialog", { name: "Open document" });
    await user.type(ui.getByLabelText(dialog, "Password"), "ordinary password words");
    await user.click(ui.getByRole(dialog, "button", { name: "Open" }));
    await ui.waitFor(() => assert.equal(
      ui.getByRole(document.body, "textbox", { name: "Document text" }).value,
      "original plaintext"));

    claim = await openInvitation();
    await dom.window.scpefe.lock();
    assert.equal(claim.password.value, "");
    assert.equal(claim.confirmation.value, "");
    assert.equal(claim.dialog.isConnected, false);
    assert.equal(ui.getByRole(document.body, "textbox", { name: "Document text" }).value, "");
    assert.equal(ui.getByLabelText(document.body, "Document state").textContent, "Locked");
    assert.equal(disposedClaims, 2);

    await user.click(ui.getByRole(document.body, "menuitem", { name: "Security" }));
    await user.click(ui.getByRole(ui.getByRole(document.body, "menu", { name: "Security" }),
      "menuitem", { name: "Unlock" }));
    dialog = await ui.findByRole(document.body, "dialog", { name: "Unlock document" });
    await user.type(ui.getByLabelText(dialog, "Password"), "ordinary password words");
    await user.click(ui.getByRole(dialog, "button", { name: "Unlock" }));
    await ui.waitFor(() => assert.equal(
      ui.getByRole(document.body, "textbox", { name: "Document text" }).value,
      "original plaintext"));
  });
