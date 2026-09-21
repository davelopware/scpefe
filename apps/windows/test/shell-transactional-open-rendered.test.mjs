import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

test("mounted shell keeps the session through picker, password, creation, and unlock failures",
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
    let frameId = 0;
    let mountedRoot;
    let closed = false;
    t.after(async () => {
      mountedRoot?.unmount();
      await Promise.resolve();
      for (const id of frames.keys()) frames.delete(id);
      if (!closed) dom.window.close();
      for (const [key, descriptor] of priorGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    });
    const raf = (callback) => {
      const id = ++frameId;
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

    const listeners = {};
    let stopped = 0;
    let pickerCalls = 0;
    let openCalls = 0;
    let unlockCalls = 0;
    let createCalls = 0;
    let cancelOpenCalls = 0;
    let cancelCreateCalls = 0;
    let lockCalls = 0;
    let claimCalls = 0;
    let cancelClaimCalls = 0;
    let createPickerCalls = 0;
    const pickerResults = [
      { selected: true, name: "first.scpefe" },
      null,
      { selected: true, name: "replacement.scpefe" },
      null,
      { selected: true, name: "invitation.scpefe" },
    ];
    const first = { content: "original plaintext", readOnly: true, canEdit: true,
      publicationState: "target-published", targetName: "first.scpefe" };
    const replacement = { content: "replacement plaintext", readOnly: true, canEdit: true,
      publicationState: "target-published", targetName: "replacement.scpefe" };
    const listen = (name, listener) => {
      listeners[name] = listener;
      return () => { stopped += 1; delete listeners[name]; };
    };
    dom.window.scpefe = {
      getProfile: async () => ({ name: "Ada", email: "ada@example.test", deviceName: "Desk" }),
      getClientSettings: async () => ({ regularSaveEnabled: false,
        regularSaveIntervalMs: 120000 }),
      getUnresolvedJournalSummary: async () => ({ total: 0, pendingPublications: 0 }),
      saveProfile: async (value) => value, saveClientSettings: async (value) => value,
      activity: async () => ({}),
      chooseOpenTarget: async () => { pickerCalls += 1; return pickerResults.shift() ?? null; },
      cancelOpenTarget: async () => { cancelOpenCalls += 1; },
      openSelectedDocument: async () => {
        openCalls += 1;
        if (openCalls === 1) return first;
        if (openCalls === 2) throw new Error("Password did not open this document");
        return { readOnly: true, invitationRequired: true,
          targetName: "invitation.scpefe" };
      },
      unlockDocument: async () => {
        unlockCalls += 1;
        if (unlockCalls === 1) throw new Error("Password did not open this document");
        return replacement;
      },
      chooseCreateTarget: async () => {
        createPickerCalls += 1;
        return createPickerCalls === 1 ? null : { selected: true };
      },
      cancelCreateTarget: async () => { cancelCreateCalls += 1; },
      createDocument: async () => {
        createCalls += 1;
        if (createCalls === 1) throw new Error("Encrypted publication failed safely");
        return { created: true, name: "new.scpefe",
          opened: { content: "", readOnly: false, canEdit: true,
            publicationState: "target-published" } };
      },
      openExternalDocument: async () => null,
      claimInvitation: async () => { claimCalls += 1;
        throw new Error("Invitation publication failed safely"); },
      cancelInvitationClaim: async () => { cancelClaimCalls += 1; return true; },
      enterEditMode: async () => ({ ...replacement, readOnly: false }),
      updateWorkingCopy: async () => ({}), saveDocument: async (content) =>
        ({ saved: true, content, publicationState: "target-published" }),
      backupDocument: async () => ({ backedUp: true }),
      exportPlaintext: async () => ({ exported: true }),
      lock: async () => { lockCalls += 1;
        return { locked: true, journalSaved: true, warning: null }; },
      onLocked: (listener) => listen("locked", listener),
      onJournalWarning: (listener) => listen("warning", listener),
      onRegularSave: (listener) => listen("regular", listener),
      onExternalOpenRequested: (listener) => listen("external", listener),
      onUnresolvedJournalSummary: (listener) => listen("summary", listener),
      onSwitchRetained: (listener) => listen("retained", listener),
    };
    dom.window[Symbol.for("scpefe.renderer.mount")] = (root) => { mountedRoot = root; };
    const assets = await fs.readdir(new URL("../dist/assets/", import.meta.url));
    const script = assets.find((entry) => /^index-.*\.js$/.test(entry));
    await import(`${pathToFileURL(path.resolve("dist/assets", script)).href}?transactional-open`);
    const ui = await import("@testing-library/dom");
    const userEvent = (await import("@testing-library/user-event")).default;
    const user = userEvent.setup({ document: dom.window.document });
    await ui.waitFor(() => assert.ok(ui.getByRole(document.body, "menubar")));

    const command = async (menu, name) => {
      await user.click(ui.getByRole(document.body, "menuitem", { name: menu }));
      await user.click(ui.getByRole(ui.getByRole(document.body, "menu", { name: menu }),
        "menuitem", { name }));
    };
    const submitPassword = async (dialogName, buttonName, password = "password words") => {
      const dialog = await ui.findByRole(document.body, "dialog", { name: dialogName });
      await user.clear(ui.getByLabelText(dialog, "Password"));
      await user.type(ui.getByLabelText(dialog, "Password"), password);
      await user.click(ui.getByRole(dialog, "button", { name: buttonName }));
      return dialog;
    };
    const editor = ui.getByRole(document.body, "textbox", { name: "Document text" });

    await command("File", /Open/);
    await submitPassword("Open document", "Open");
    await ui.waitFor(() => assert.equal(editor.value, "original plaintext"));

    await command("File", /Open/);
    assert.equal(ui.queryByRole(document.body, "dialog", { name: "Open document" }), null,
      "picker cancellation opens no password dialog");
    assert.equal(editor.value, "original plaintext");

    await command("File", /Open/);
    let dialog = await submitPassword("Open document", "Open", "wrong password");
    await ui.waitFor(() => assert.match(ui.getByRole(dialog, "alert").textContent,
      /did not open/));
    assert.equal(editor.value, "original plaintext");
    assert.equal(document.activeElement, ui.getByLabelText(dialog, "Password"));
    await user.click(ui.getByRole(dialog, "button", { name: "Cancel" }));
    assert.equal(cancelOpenCalls, 1);
    assert.equal(editor.value, "original plaintext");

    await command("File", /Open/);
    assert.equal(pickerCalls, 4, "a fresh Open starts with the picker again");
    assert.equal(editor.value, "original plaintext");

    await command("File", /Open/);
    await submitPassword("Open document", "Open", "temporary password");
    const claim = await ui.findByRole(document.body, "dialog", { name: "Claim invitation" });
    assert.equal(editor.value, "original plaintext",
      "staged invitation leaves the original renderer session mounted");
    await user.type(ui.getByLabelText(claim, "New password"), "replacement password");
    await user.click(ui.getByRole(claim, "button",
      { name: "Replace password and claim identity" }));
    await ui.waitFor(() => assert.equal(claimCalls, 1));
    assert.equal(editor.value, "original plaintext",
      "claim failure leaves the original renderer session intact");
    await user.click(ui.getByRole(claim, "button", { name: "Cancel" }));
    await ui.waitFor(() => assert.equal(cancelClaimCalls, 1));
    assert.equal(editor.value, "original plaintext",
      "claim cancellation leaves the original renderer session intact");

    listeners.locked({ locked: true, journalSaved: true, warning: null });
    assert.equal(editor.value, "");
    await command("Security", "Unlock");
    dialog = await ui.findByRole(document.body, "dialog", { name: "Unlock document" });
    await user.click(ui.getByRole(dialog, "button", { name: "Cancel" }));
    assert.equal(editor.value, "", "canceling Unlock leaves the target securely locked");
    assert.equal(ui.getByLabelText(document.body, "Document state").textContent, "Locked");
    assert.equal(pickerCalls, 5, "canceling Unlock does not invoke a picker");
    await command("Security", "Unlock");
    dialog = await submitPassword("Unlock document", "Unlock", "wrong password");
    await ui.waitFor(() => assert.ok(ui.getByRole(dialog, "alert")));
    assert.equal(editor.value, "");
    assert.equal(pickerCalls, 5, "Unlock does not invoke a picker");
    await submitPassword("Unlock document", "Unlock", "correct password");
    await ui.waitFor(() => assert.equal(editor.value, "replacement plaintext"));

    await command("File", /New/);
    assert.equal(ui.queryByRole(document.body, "dialog",
      { name: "Secure new document" }), null, "creation picker cancellation opens no dialog");
    assert.equal(editor.value, "replacement plaintext");
    assert.equal(createCalls, 0);

    await command("File", /New/);
    let createDialog = await ui.findByRole(document.body, "dialog",
      { name: "Secure new document" });
    await user.type(ui.getByLabelText(createDialog, "Owner password"), "owner password words");
    await user.type(ui.getByLabelText(createDialog, "Confirm owner password"), "owner typo words");
    await user.click(ui.getByLabelText(createDialog,
      "I understand that lost passwords cannot be recovered."));
    await user.click(ui.getByRole(createDialog, "button", { name: "Create" }));
    assert.equal(createCalls, 0, "mounted mismatch reaches no native creation boundary");
    assert.equal(editor.value, "replacement plaintext");
    await user.click(ui.getByRole(createDialog, "button", { name: "Cancel" }));
    assert.equal(cancelCreateCalls, 1);
    assert.equal(editor.value, "replacement plaintext");

    await command("File", /New/);
    createDialog = await ui.findByRole(document.body, "dialog",
      { name: "Secure new document" });
    await user.type(ui.getByLabelText(createDialog, "Owner password"), "owner password words");
    await user.type(ui.getByLabelText(createDialog, "Confirm owner password"),
      "owner password words");
    await user.click(ui.getByLabelText(createDialog,
      "I understand that lost passwords cannot be recovered."));
    await user.click(ui.getByRole(createDialog, "button", { name: "Create" }));
    await ui.waitFor(() => assert.match(ui.getByRole(createDialog, "alert").textContent,
      /publication failed safely/));
    assert.equal(editor.value, "replacement plaintext");
    assert.equal(ui.getByLabelText(createDialog, "Owner password").value,
      "owner password words");
    await user.click(ui.getByRole(createDialog, "button", { name: "Create" }));
    await ui.waitFor(() => assert.equal(editor.value, ""));
    assert.equal(ui.getByLabelText(document.body, "Document state").textContent, "Edit mode");
    assert.equal(ui.getByLabelText(document.body, "Working copy state").textContent, "Clean");
    ui.fireEvent.change(editor, { target: { value: "first typing",
      selectionStart: 12, selectionEnd: 12 } });
    await ui.waitFor(() => assert.equal(
      ui.getByLabelText(document.body, "Working copy state").textContent, "Dirty"));

    mountedRoot.unmount(); mountedRoot = null;
    await Promise.resolve();
    assert.equal(document.getElementById("root").childElementCount, 0);
    assert.equal(stopped, 6);
    assert.equal(frames.size, 0);
    dom.window.close(); closed = true;
  });
