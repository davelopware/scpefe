import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

test("mounted shell keeps save, recovery, conflict, lease, migration, and compaction decisions truthful",
  async (t) => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
      url: "https://scpefe.invalid/",
    });
    const keys = ["window", "document", "HTMLElement", "Node", "MutationObserver",
      "FormData", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
      "IS_REACT_ACT_ENVIRONMENT"];
    const prior = new Map(keys.map((key) =>
      [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const frames = new Map();
    let nextFrame = 0;
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

    const listeners = {};
    const base = { content: "sealed text", readOnly: true, canEdit: true,
      canAddPasswords: true, canRemovePasswords: true,
      publicationState: "target-published", targetName: "decisions.scpefe" };
    let openResult = { ...base, recovery: { content: "recovered private text",
      state: "unsaved", updateTime: 1, cursor: { start: 3, end: 3 } } };
    let saveAttempts = 0;
    let publicationAttempts = 0;
    let editAttempts = 0;
    let migrationAttempts = 0;
    let compactionAttempts = 0;
    let recoveryDiscards = 0;
    let recoveryRestores = 0;
    let publicationDiscards = 0;
    let divergenceAttempts = 0;
    let divergenceSaveAttempts = 0;
    let headAccepts = 0;
    let cancelAttempts = 0;
    const calls = [];
    const listen = (name, listener) => {
      listeners[name] = listener;
      return () => { delete listeners[name]; };
    };
    dom.window.scpefe = {
      getProfile: async () => ({ name: "Ada", email: "ada@example.test",
        deviceName: "Desk" }),
      saveProfile: async (value) => value, reconcileProfile: async () => null,
      getClientSettings: async () => ({ regularSaveEnabled: true,
        regularSaveIntervalMs: 120000 }),
      saveClientSettings: async (value) => value,
      getUnresolvedJournalSummary: async () => ({ total: 1, pendingPublications: 0 }),
      chooseCreateTarget: async () => null, cancelCreateTarget: async () => {},
      createDocument: async () => null,
      chooseOpenTarget: async () => ({ selected: true, name: "decisions.scpefe" }),
      cancelOpenTarget: async () => {}, openSelectedDocument: async () => openResult,
      unlockDocument: async () => openResult, openExternalDocument: async () => null,
      enterEditMode: async ({ authorization } = {}) => {
        calls.push(["edit", Boolean(authorization)]); editAttempts += 1;
        if (!authorization && editAttempts <= 2) {
          return { decisionRequired: "lease-takeover", operation: "edit",
            holderName: "Remote editor",
            authorization: "123e4567-e89b-42d3-a456-426614174000" };
        }
        if (authorization && editAttempts === 3) {
          throw new Error("lease publication flush failed");
        }
        if (!authorization && editAttempts === 4) {
          return { decisionRequired: "lease-takeover", operation: "edit",
            holderName: "Fresh remote editor",
            authorization: "623e4567-e89b-42d3-a456-426614174000" };
        }
        if (authorization && editAttempts === 5) {
          return { decisionRequired: "lease-takeover", operation: "edit",
            holderName: "Updated remote editor",
            authorization: "723e4567-e89b-42d3-a456-426614174000" };
        }
        return { ...base, readOnly: false };
      },
      restoreRecoveredWork: async ({ authorization } = {}) => {
        recoveryRestores += 1;
        if (recoveryRestores === 1) throw new Error("recovery journal read failed");
        if (!authorization) return { decisionRequired: "lease-takeover",
          operation: "recovery", holderName: "Recovery lease holder",
          authorization: recoveryRestores < 5
            ? "323e4567-e89b-42d3-a456-426614174000"
            : "823e4567-e89b-42d3-a456-426614174000" };
        if (recoveryRestores === 4) throw new Error("recovery lease write failed");
        return { ...base, content: "recovered private text",
          readOnly: false, recoveredUnsaved: true, cursor: { start: 3, end: 3 } };
      },
      discardRecoveredWork: async () => {
        recoveryDiscards += 1;
        if (recoveryDiscards === 1) throw new Error("journal cleanup failed");
        return base;
      },
      saveDocument: async (content) => {
        saveAttempts += 1;
        if (saveAttempts === 1) throw new Error("flush failed before replacement");
        if (saveAttempts === 3 || saveAttempts === 4 || saveAttempts === 5) {
          return { saved: true, content, publicationState: "pending-publication" };
        }
        return { saved: true, content, publicationState: "target-published" };
      },
      reconnectPendingPublication: async () => {
        publicationAttempts += 1;
        if (publicationAttempts === 1) throw new Error("provider is still offline");
        return { content: "offline manual save",
          publicationState: publicationAttempts === 2 ? "pending-publication" : "conflict" };
      },
      beginDivergenceResolution: async ({ authorization } = {}) => {
        divergenceAttempts += 1;
        if (divergenceAttempts === 1) throw new Error("merge ancestor unavailable");
        if (!authorization) return { decisionRequired: "lease-takeover",
          operation: "divergence", holderName: "Divergence lease holder",
          authorization: divergenceAttempts < 5
            ? "423e4567-e89b-42d3-a456-426614174000"
            : "923e4567-e89b-42d3-a456-426614174000" };
        if (divergenceAttempts === 4) throw new Error("merge lease publication failed");
        return { content: "merged exact text", hasConflicts: false,
          ancestorRevision: "11".repeat(32), localRevision: "22".repeat(32),
          currentRevision: "33".repeat(32) };
      },
      saveDivergenceResolution: async (content) => {
        divergenceSaveAttempts += 1;
        if (divergenceSaveAttempts === 1) throw new Error("merge publication failed");
        return { saved: true, content, publicationState: "target-published" };
      },
      discardPendingPublication: async () => {
        publicationDiscards += 1;
        if (publicationDiscards === 1) throw new Error("pending journal cleanup failed");
        return base;
      },
      acceptHeadMismatch: async () => {
        headAccepts += 1;
        if (headAccepts === 1) throw new Error("witness write failed");
        return base;
      },
      backupDocument: async () => null, exportPlaintext: async () => null,
      compactDocument: async (request) => {
        calls.push(["compact", request]); compactionAttempts += 1;
        if (compactionAttempts === 1) throw new Error("backup verification failed");
        return { compacted: true, backupCreated: true,
          previousHead: "44".repeat(32), head: "55".repeat(32) };
      },
      migrateDocument: async ({ authorization } = {}) => {
        calls.push(["migrate", Boolean(authorization)]); migrationAttempts += 1;
        if (!authorization) {
          return { decisionRequired: "lease-takeover", operation: "migration",
            holderName: "Future clock holder",
            authorization: migrationAttempts < 4
              ? "223e4567-e89b-42d3-a456-426614174000"
              : migrationAttempts < 6
                ? "a23e4567-e89b-42d3-a456-426614174000"
                : "b23e4567-e89b-42d3-a456-426614174000" };
        }
        if (migrationAttempts === 3) return null;
        if (migrationAttempts === 5) throw new Error("alternate backup verification failed");
        return { migrated: true, backupCreated: true,
          compatibilityWarning: "Migration published after a verified backup.",
          opened: { ...base, content: "legacy private text", readOnly: false } };
      },
      cancelLeaseTakeover: async (authorization) => {
        calls.push(["cancel-takeover", authorization]); cancelAttempts += 1;
        return cancelAttempts !== 1;
      },
      changePassword: async () => base, createInvitation: async () => ({ created: true,
        temporaryPassword: "temporary words" }), copyInvitationPassphrase: async () => true,
      claimInvitation: async () => base, cancelInvitationClaim: async () => true,
      reconcileIdentity: async () => base, updateSlotPermissions: async () => base,
      removeSlot: async () => ({ removed: true, warning: "removed" }),
      updateWorkingCopy: async () => ({}), activity: async () => ({}),
      lock: async () => ({ locked: true, journalSaved: true, warning: null }),
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
    await import(`${pathToFileURL(path.resolve("dist/assets", script)).href}?issue-42-decisions`);
    const ui = await import("@testing-library/dom");
    const userEvent = (await import("@testing-library/user-event")).default;
    const user = userEvent.setup({ document: dom.window.document });
    await ui.findByRole(document.body, "menubar");
    const editor = ui.getByRole(document.body, "textbox", { name: "Document text" });
    const status = (name) => ui.getByLabelText(document.body, name).textContent;
    const command = async (menuName, itemName) => {
      await user.click(ui.getByRole(document.body, "menuitem", { name: menuName }));
      await user.click(ui.getByRole(ui.getByRole(document.body, "menu", { name: menuName }),
        "menuitem", { name: itemName }));
    };

    await command("File", /Open/);
    let dialog = await ui.findByRole(document.body, "dialog", { name: "Open document" });
    await user.type(ui.getByLabelText(dialog, "Password"), "correct password words");
    await user.click(ui.getByRole(dialog, "button", { name: "Open" }));
    dialog = await ui.findByRole(document.body, "dialog", { name: "Recovered work" });
    assert.equal(editor.value, "");
    assert.equal(document.body.textContent.includes("recovered private text"), false);
    await ui.waitFor(() => assert.equal(document.activeElement?.textContent?.trim(),
      "Discard recovered work"));
    let action = ui.getByRole(dialog, "button", { name: "Discard recovered work" });
    await user.click(action);
    assert.match((await ui.findByRole(dialog, "alert")).textContent, /journal cleanup failed/);
    await ui.waitFor(() => assert.equal(document.activeElement === action, true));
    await user.click(action);
    await ui.waitFor(() => assert.equal(status("Document state"), "Read-only"));
    assert.equal(recoveryDiscards, 2);
    await command("Security", "Lock");
    openResult = { ...base, recovery: { content: "recovered private text",
      state: "unsaved", updateTime: 1, cursor: { start: 3, end: 3 } } };
    await command("Security", "Unlock");
    dialog = await ui.findByRole(document.body, "dialog", { name: "Unlock document" });
    await user.type(ui.getByLabelText(dialog, "Password"), "correct password words");
    await user.click(ui.getByRole(dialog, "button", { name: "Unlock" }));
    dialog = await ui.findByRole(document.body, "dialog", { name: "Recovered work" });
    action = ui.getByRole(dialog, "button", { name: "Restore unsaved work" });
    await user.click(action);
    assert.match((await ui.findByRole(dialog, "alert")).textContent,
      /recovery journal read failed/);
    await ui.waitFor(() => assert.equal(document.activeElement === action, true));
    await user.click(action);
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Confirm editing-lease takeover" });
    assert.match(ui.getByRole(dialog, "alert").textContent, /Recovery lease holder/);
    await user.click(ui.getByRole(dialog, "button", { name: "Cancel" }));
    assert.match(ui.getByRole(document.body, "status").textContent, /already inactive/);
    dialog = await ui.findByRole(document.body, "dialog", { name: "Recovered work" });
    await user.click(ui.getByRole(dialog, "button", { name: "Restore unsaved work" }));
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Confirm editing-lease takeover" });
    await user.click(ui.getByRole(dialog, "button", { name: "Force takeover" }));
    dialog = await ui.findByRole(document.body, "dialog", { name: "Recovered work" });
    assert.ok(await ui.findByText(dialog, /recovery lease write failed/));
    action = ui.getByRole(dialog, "button", { name: "Restore unsaved work" });
    await ui.waitFor(() => assert.equal(document.activeElement === action, true));
    await user.click(action);
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Confirm editing-lease takeover" });
    await user.click(ui.getByRole(dialog, "button", { name: "Force takeover" }));
    await ui.waitFor(() => assert.equal(editor.value, "recovered private text"));
    assert.equal(status("Working copy state"), "Dirty");

    editor.focus();
    await user.keyboard("{Control>}s{/Control}");
    dialog = await ui.findByRole(document.body, "dialog", { name: "Manual save failed" });
    assert.match(ui.getByRole(dialog, "alert").textContent, /flush failed/);
    assert.equal(editor.value, "");
    await user.click(ui.getByRole(dialog, "button", { name: "Retry manual save" }));
    await ui.waitFor(() => assert.equal(status("Working copy state"), "Clean"));
    assert.match(ui.getByRole(document.body, "status").textContent, /published and verified/);

    await command("Security", /Passwords/);
    dialog = await ui.findByRole(document.body, "dialog", { name: "Passwords" });
    await user.click(ui.getByRole(dialog, "button", { name: "Compact history…" }));
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Permanently compact document history?" });
    assert.match(ui.getByRole(dialog, "alert").textContent, /exact backup/);
    await user.click(ui.getByRole(dialog, "button", { name: "Cancel" }));
    dialog = await ui.findByRole(document.body, "dialog", { name: "Passwords" });
    assert.match(ui.getByRole(document.body, "status").textContent, /Compaction canceled/);
    await user.click(ui.getByRole(dialog, "button", { name: "Compact history…" }));
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Permanently compact document history?" });
    await user.click(ui.getByRole(dialog, "button",
      { name: "Create verified backup and compact" }));
    assert.ok(await ui.findByText(dialog, "backup verification failed"));
    await user.click(ui.getByRole(dialog, "button",
      { name: "Create verified backup and compact" }));
    await ui.findByRole(document.body, "dialog", { name: "Passwords" });
    assert.deepEqual(calls.filter(([name]) => name === "compact"), [
      ["compact", { confirmed: true }], ["compact", { confirmed: true }],
    ]);
    await user.click(ui.getByRole(document.body, "button", { name: "Close" }));

    openResult = base;
    await command("Security", "Lock");
    await command("Security", "Unlock");
    dialog = await ui.findByRole(document.body, "dialog", { name: "Unlock document" });
    await user.type(ui.getByLabelText(dialog, "Password"), "correct password words");
    await user.click(ui.getByRole(dialog, "button", { name: "Unlock" }));
    await command("Edit", "Edit Contents");
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Confirm editing-lease takeover" });
    assert.equal(editor.value, "");
    assert.match(ui.getByRole(dialog, "alert").textContent, /Remote editor/);
    await user.click(ui.getByRole(dialog, "button", { name: "Cancel" }));
    assert.equal(status("Document state"), "Read-only");
    await command("Edit", "Edit Contents");
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Confirm editing-lease takeover" });
    await user.click(ui.getByRole(dialog, "button", { name: "Force takeover" }));
    dialog = await ui.findByRole(document.body, "dialog", { name: "Editing unavailable" });
    assert.match(ui.getByRole(dialog, "alert").textContent, /lease publication flush failed/);
    action = ui.getByRole(dialog, "button", { name: "Retry editing" });
    await ui.waitFor(() => assert.equal(document.activeElement === action, true));
    await user.click(action);
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Confirm editing-lease takeover" });
    assert.match(dialog.textContent, /Fresh remote editor/);
    await user.click(ui.getByRole(dialog, "button", { name: "Force takeover" }));
    assert.ok(await ui.findByText(dialog, /The lease changed/));
    assert.match(dialog.textContent, /Updated remote editor/);
    await user.click(ui.getByRole(dialog, "button", { name: "Force takeover" }));
    await ui.waitFor(() => assert.equal(status("Document state"), "Edit mode"));

    ui.fireEvent.change(editor, { target: { value: "offline manual save",
      selectionStart: 19, selectionEnd: 19 } });
    await command("File", /Save/);
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Manual save pending publication" });
    assert.equal(editor.value, "");
    action = ui.getByRole(dialog, "button", { name: "Discard pending save" });
    await user.click(action);
    assert.match((await ui.findByRole(dialog, "alert")).textContent,
      /pending journal cleanup failed/);
    await ui.waitFor(() => assert.equal(document.activeElement === action, true));
    await user.click(action);
    await ui.waitFor(() => assert.equal(status("Publication state"), "Published"));

    await command("Edit", "Edit Contents");
    ui.fireEvent.change(editor, { target: { value: "offline manual save",
      selectionStart: 19, selectionEnd: 19 } });
    await command("File", /Save/);
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Manual save pending publication" });
    action = ui.getByRole(dialog, "button", { name: "Retry publication" });
    await user.click(action);
    assert.match((await ui.findByRole(dialog, "alert")).textContent,
      /provider is still offline/);
    await ui.waitFor(() => assert.equal(document.activeElement === action, true));
    await user.click(action);
    assert.ok(await ui.findByRole(document.body, "dialog",
      { name: "Manual save pending publication" }));
    await user.click(ui.getByRole(document.body, "button", { name: "Retry publication" }));
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Divergence needs resolution" });
    await user.click(ui.getByRole(dialog, "button", { name: "Discard pending save" }));
    await ui.waitFor(() => assert.equal(status("Publication state"), "Published"));
    await command("Edit", "Edit Contents");
    ui.fireEvent.change(editor, { target: { value: "offline manual save",
      selectionStart: 19, selectionEnd: 19 } });
    await command("File", /Save/);
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Manual save pending publication" });
    await user.click(ui.getByRole(dialog, "button", { name: "Retry publication" }));
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Divergence needs resolution" });
    action = ui.getByRole(dialog, "button", { name: "Retry publication" });
    await user.click(action);
    assert.match((await ui.findByRole(dialog, "alert")).textContent,
      /merge ancestor unavailable/);
    await ui.waitFor(() => assert.equal(document.activeElement === action, true));
    await user.click(action);
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Confirm editing-lease takeover" });
    assert.match(ui.getByRole(dialog, "alert").textContent, /Divergence lease holder/);
    await user.click(ui.getByRole(dialog, "button", { name: "Cancel" }));
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Divergence needs resolution" });
    await user.click(ui.getByRole(dialog, "button", { name: "Retry publication" }));
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Confirm editing-lease takeover" });
    await user.click(ui.getByRole(dialog, "button", { name: "Force takeover" }));
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Divergence needs resolution" });
    assert.ok(await ui.findByText(dialog, /merge lease publication failed/));
    action = ui.getByRole(dialog, "button", { name: "Retry publication" });
    await ui.waitFor(() => assert.equal(document.activeElement === action, true));
    await user.click(action);
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Confirm editing-lease takeover" });
    await user.click(ui.getByRole(dialog, "button", { name: "Force takeover" }));
    await ui.waitFor(() => assert.equal(editor.value, "merged exact text"));
    assert.equal(ui.queryByRole(document.body, "dialog"), null);
    assert.equal(status("Publication state"), "Publication conflict");
    await command("File", /Save/);
    dialog = await ui.findByRole(document.body, "dialog", { name: "Manual save failed" });
    assert.match(ui.getByRole(dialog, "alert").textContent, /merge publication failed/);
    await user.click(ui.getByRole(dialog, "button", { name: "Retry manual save" }));
    await ui.waitFor(() => assert.equal(status("Publication state"), "Published"));
    assert.match(ui.getByRole(document.body, "status").textContent,
      /published and verified/);

    listeners.locked({ locked: true, journalSaved: true, warning: null });
    openResult = { ...base, content: "authenticated private text", canEdit: false,
      headMismatch: { kind: "rollback", title: "Authenticated rollback detected",
        explanation: "The authenticated head is older than the witnessed head.",
        editingBlocked: true } };
    await command("Security", "Unlock");
    dialog = await ui.findByRole(document.body, "dialog", { name: "Unlock document" });
    await user.type(ui.getByLabelText(dialog, "Password"), "head password words");
    await user.click(ui.getByRole(dialog, "button", { name: "Unlock" }));
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Authenticated rollback detected" });
    assert.equal(editor.value, "");
    assert.equal(document.body.textContent.includes("authenticated private text"), false);
    action = ui.getByRole(dialog, "button", { name: "Accept current authenticated head" });
    await user.click(action);
    assert.match((await ui.findByRole(dialog, "alert")).textContent, /witness write failed/);
    await ui.waitFor(() => assert.equal(document.activeElement === action, true));
    await user.click(action);
    await ui.waitFor(() => assert.equal(headAccepts, 2));
    for (const mismatch of [
      ["divergence", "Authenticated divergence detected"],
      ["replacement", "Document identity replacement detected"],
      ["witness-error", "Authenticated witness needs attention"],
    ]) {
      await command("Security", "Lock");
      openResult = { ...base, content: `${mismatch[0]} private text`, canEdit: false,
        headMismatch: { kind: mismatch[0], title: mismatch[1],
          explanation: `${mismatch[0]} evidence requires a decision.`, editingBlocked: true } };
      await command("Security", "Unlock");
      dialog = await ui.findByRole(document.body, "dialog", { name: "Unlock document" });
      await user.type(ui.getByLabelText(dialog, "Password"), "head password words");
      await user.click(ui.getByRole(dialog, "button", { name: "Unlock" }));
      dialog = await ui.findByRole(document.body, "dialog", { name: mismatch[1] });
      assert.equal(editor.value, "");
      assert.equal(document.body.textContent.includes(`${mismatch[0]} private text`), false);
      await user.click(ui.getByRole(dialog, "button",
        { name: "Accept current authenticated head" }));
    }
    await command("Security", "Lock");
    openResult = { ...base, content: "legacy private text", canEdit: false,
      migrationRequired: true,
      migrationWarning: "A verified exact backup is required before migration." };
    await command("Security", "Unlock");
    dialog = await ui.findByRole(document.body, "dialog", { name: "Unlock document" });
    await user.type(ui.getByLabelText(dialog, "Password"), "legacy password words");
    await user.click(ui.getByRole(dialog, "button", { name: "Unlock" }));
    dialog = await ui.findByRole(document.body, "dialog", { name: "Older container" });
    assert.equal(editor.value, "");
    await user.click(ui.getByRole(dialog, "button",
      { name: "Create verified backup and migrate…" }));
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Confirm editing-lease takeover" });
    assert.match(ui.getByRole(dialog, "alert").textContent, /Future clock holder/);
    await user.click(ui.getByRole(dialog, "button", { name: "Cancel" }));
    dialog = await ui.findByRole(document.body, "dialog", { name: "Older container" });
    await user.click(ui.getByRole(dialog, "button",
      { name: "Create verified backup and migrate…" }));
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Confirm editing-lease takeover" });
    await user.click(ui.getByRole(dialog, "button", { name: "Force takeover and migrate" }));
    dialog = await ui.findByRole(document.body, "dialog", { name: "Older container" });
    assert.ok(await ui.findByText(dialog, /Migration was canceled before publication/));
    action = ui.getByRole(dialog, "button", { name: "Create verified backup and migrate…" });
    await ui.waitFor(() => assert.equal(document.activeElement === action, true));
    await user.click(action);
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Confirm editing-lease takeover" });
    await user.click(ui.getByRole(dialog, "button", { name: "Force takeover and migrate" }));
    dialog = await ui.findByRole(document.body, "dialog", { name: "Older container" });
    assert.ok(await ui.findByText(dialog, /alternate backup verification failed/));
    action = ui.getByRole(dialog, "button", { name: "Create verified backup and migrate…" });
    await ui.waitFor(() => assert.equal(document.activeElement === action, true));
    await user.click(action);
    dialog = await ui.findByRole(document.body, "dialog",
      { name: "Confirm editing-lease takeover" });
    await user.click(ui.getByRole(dialog, "button", { name: "Force takeover and migrate" }));
    await ui.waitFor(() => assert.equal(status("Document state"), "Edit mode"));
    assert.equal(editor.value, "legacy private text");
    assert.deepEqual(calls.filter(([name]) => name === "migrate"), [
      ["migrate", false], ["migrate", false], ["migrate", true],
      ["migrate", false], ["migrate", true], ["migrate", false], ["migrate", true],
    ]);
    assert.deepEqual(calls.filter(([name]) => name === "cancel-takeover").map((call) => call[1]), [
      "323e4567-e89b-42d3-a456-426614174000",
      "123e4567-e89b-42d3-a456-426614174000",
      "423e4567-e89b-42d3-a456-426614174000",
      "223e4567-e89b-42d3-a456-426614174000",
    ]);

    listeners.locked({ locked: true, journalSaved: true, warning: null });
    assert.equal(editor.value, "");
    assert.equal(document.body.textContent.includes("legacy private text"), false);
  });
