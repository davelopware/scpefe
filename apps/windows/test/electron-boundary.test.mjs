import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("sandboxed Electron loads a bundled CommonJS preload", async () => {
  const main = await fs.readFile(new URL("../src/main.mjs", import.meta.url), "utf8");
  const lifecycleHost = await fs.readFile(
    new URL("../src/document-lifecycle-host.mjs", import.meta.url), "utf8");
  const nativeLifecycle = await fs.readFile(
    new URL("../src/native-lifecycle.mjs", import.meta.url), "utf8");
  const config = await fs.readFile(
    new URL("../vite.preload.config.ts", import.meta.url), "utf8");
  const preload = await fs.readFile(
    new URL("../dist/preload.cjs", import.meta.url), "utf8");
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /powerMonitor\.on\(["']lock-screen["']/);
  assert.match(main, /window\.on\(["']blur["']/);
  assert.match(main, /new DocumentLifecycleHost/);
  assert.match(lifecycleHost, /lockActive\(["']app-lock["']\)/);
  assert.match(lifecycleHost, /onLockStart:/);
  assert.match(lifecycleHost, /document:lock-started/);
  assert.match(lifecycleHost, /#beginServiceLock\(current\)/);
  assert.match(main, /defaultPath:\s*["']Untitled\.scpefe["']/);
  assert.match(main, /extensions:\s*\[["']scpefe["']\]/);
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /app\.on\(["']second-instance["']/);
  assert.match(main, /existing instance remains authoritative/);
  assert.match(main, /Windows Task Manager/);
  assert.doesNotMatch(main, /taskkill|process\.kill|child_process/);
  assert.match(lifecycleHost, /SessionProtectionCoordinator/);
  assert.match(lifecycleHost, /NativeLifecycleCoordinator/);
  assert.match(nativeLifecycle, /protections\.authorize\(["']exit["'],/);
  assert.match(lifecycleHost, /#register\(["']document:close["']/);
  assert.doesNotMatch(lifecycleHost,
    /if \(closingAfterRelease \|\| !service\.active\?\.editMode\) return/);
  assert.match(main, /dist["'],\s*["']preload\.cjs/);
  assert.doesNotMatch(main, /preload\.mjs/);
  assert.match(config, /formats:\s*\[["']cjs["']\]/);
  assert.match(config, /external:\s*\[["']electron["']\]/);
  assert.doesNotMatch(preload, /(^|\n)\s*import\s/m);
  assert.match(preload, /require\(["']electron["']\)/);

  let exposed;
  const editOpened = { content: "", readOnly: false, canEdit: true,
    publicationState: "target-published" };
  let creationResult = { created: true, opened: editOpened,
    name: "C:\\Users\\Ada\\secret.scpefe" };
  let compactionResult = null;
  let editResult = editOpened;
  let recoveryResult = { content: "recovered", readOnly: false, canEdit: true,
    recoveredUnsaved: true, cursor: { start: 0, end: 0 } };
  let divergenceResult = { content: "merge", hasConflicts: false,
    ancestorRevision: "11".repeat(32), localRevision: "22".repeat(32),
    currentRevision: "33".repeat(32) };
  let migrationResult = null;
  let invitationResult = { created: true,
    temporaryPassword: "generated secret words" };
  const invocations = [];
  const rendererListeners = new Map();
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
    ipcRenderer: { on: (channel, listener) => rendererListeners.set(channel, listener),
      removeListener: (channel, listener) => {
        if (rendererListeners.get(channel) === listener) rendererListeners.delete(channel);
      },
      invoke: async (channel, request) => {
        invocations.push({ channel, request });
        if (channel === "profile:save") return { ...request,
          nativeProfilePath: "C:\\private\\profile.json" };
        if (channel === "document:choose-create-target") {
          return { selected: true };
        }
        if (channel === "profile:reconcile-active") return null;
        if (channel === "document:choose-open-target") {
          return { selected: true, name: "notes.scpefe" };
        }
        if (channel === "document:open-selected" || channel === "document:unlock") {
          return { content: "secret", readOnly: true, canEdit: true,
            publicationState: "target-published", targetName: "notes.scpefe" };
        }
        if (channel === "document:claim-invitation") {
          return { content: "claimed", readOnly: true, canEdit: true,
            publicationState: "target-published" };
        }
        if (channel === "document:cancel-invitation-claim") return true;
        if (channel === "document:change-password") {
          return { content: "secret", readOnly: true, canEdit: true,
            publicationState: "target-published" };
        }
        if (channel === "document:create-invitation") {
          return invitationResult;
        }
        if (channel === "document:copy-invitation-passphrase") return true;
        if (channel === "document:create") {
          return creationResult;
        }
        if (channel === "document:export-plaintext") {
          return { exported: true, target: "C:\\Users\\Ada\\secret.txt" };
        }
        if (channel === "document:backup") {
          return { backedUp: true, target: "C:\\Users\\Ada\\backup.scpefe" };
        }
        if (channel === "document:compact") return compactionResult;
        if (channel === "document:enter-edit-mode") return editResult;
        if (channel === "document:restore-recovery") return recoveryResult;
        if (channel === "document:begin-divergence-resolution") return divergenceResult;
        if (channel === "document:cancel-lease-takeover") return true;
        if (channel === "document:migrate") return migrationResult;
        if (channel === "document:remove-slot") {
          return { removed: true, warning: "Password slot removed." };
        }
        return null;
      } },
  };
  vm.runInNewContext(preload, {
    Buffer,
    require: (identifier) => {
      assert.equal(identifier, "electron");
      return electron;
    },
  });
  assert.deepEqual(Object.keys(exposed), [
    "getProfile", "saveProfile", "reconcileProfile", "getClientSettings", "saveClientSettings",
    "getUnresolvedJournalSummary", "chooseCreateTarget", "cancelCreateTarget",
    "createDocument", "chooseOpenTarget", "cancelOpenTarget",
    "openSelectedDocument", "unlockDocument",
    "openExternalDocument", "cancelExternalOpen",
    "enterEditMode", "saveDocument", "reconnectPendingPublication",
    "beginDivergenceResolution", "saveDivergenceResolution",
    "discardPendingPublication", "backupDocument", "compactDocument", "migrateDocument",
    "changePassword", "createInvitation", "copyInvitationPassphrase",
    "claimInvitation", "cancelInvitationClaim", "reconcileIdentity",
    "updateSlotPermissions", "removeSlot",
    "exportPlaintext", "updateWorkingCopy", "activity",
    "restoreRecoveredWork", "cancelLeaseTakeover", "discardRecoveredWork",
    "acceptHeadMismatch", "closeDocument", "exitApplication", "resolveProtection",
    "lock", "onLockStarted", "onLocked",
    "onJournalWarning", "onRegularSave", "onExternalOpenRequested",
    "onUnresolvedJournalSummary",
    "onSwitchRetained", "onProtectionRequested", "onDocumentClosed",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(await exposed.saveProfile({
    name: "Ada", email: "ada@example.test", deviceName: "Desk",
  }))), { name: "Ada", email: "ada@example.test", deviceName: "Desk" });
  assert.equal(JSON.stringify(await exposed.saveProfile({
    name: "Ada", email: "ada@example.test", deviceName: "Desk",
  })).includes("profile.json"), false, "host-only profile paths do not cross preload");
  let regularSave;
  const stopRegularSave = exposed.onRegularSave((value) => { regularSave = value; });
  rendererListeners.get("document:regular-saved")({}, { published: true,
    provisional: true, content: "exact\r\ntext", targetPath: "C:\\private\\notes.scpefe",
    password: "must not cross" });
  assert.deepEqual(JSON.parse(JSON.stringify(regularSave)), {
    published: true, provisional: true, content: "exact\ntext",
  });
  stopRegularSave();
  assert.equal(rendererListeners.has("document:regular-saved"), false);
  await assert.rejects(exposed.compactDocument(), /explicitly confirmed/);
  assert.equal(invocations.some(({ channel }) => channel === "document:compact"), false);
  assert.equal(await exposed.compactDocument({ confirmed: true }), null);
  assert.equal(await exposed.reconcileProfile(), null);
  assert.equal(invocations.at(-1).channel, "profile:reconcile-active");
  assert.deepEqual(JSON.parse(JSON.stringify(await exposed.chooseCreateTarget())),
    { selected: true });
  assert.deepEqual(JSON.parse(JSON.stringify(invocations.at(-1))), {
    channel: "document:choose-create-target",
  });
  await exposed.cancelCreateTarget();
  assert.deepEqual(JSON.parse(JSON.stringify(invocations.at(-1))), {
    channel: "document:cancel-create-target",
  });
  compactionResult = { compacted: true, backupCreated: true,
    previousHead: "12".repeat(32), head: "34".repeat(32) };
  assert.deepEqual(JSON.parse(JSON.stringify(await exposed.compactDocument(
    { confirmed: true }))),
    compactionResult);
  assert.deepEqual(JSON.parse(JSON.stringify(invocations.at(-1))), {
    channel: "document:compact", request: { confirmed: true },
  });
  compactionResult = { compacted: true, backupCreated: false,
    previousHead: "12".repeat(32), head: "34".repeat(32) };
  await assert.rejects(exposed.compactDocument({ confirmed: true }),
    /invalid compaction result/);
  assert.equal((await exposed.enterEditMode()).readOnly, false);
  assert.deepEqual(JSON.parse(JSON.stringify(invocations.at(-1))), {
    channel: "document:enter-edit-mode", request: {},
  });
  const authorization = "123e4567-e89b-42d3-a456-426614174000";
  editResult = { decisionRequired: "lease-takeover", operation: "edit",
    holderName: "Remote editor", authorization };
  assert.deepEqual(JSON.parse(JSON.stringify(await exposed.enterEditMode())), editResult);
  await assert.rejects(exposed.enterEditMode({ authorization, extra: true }),
    /lease takeover request is invalid/);
  recoveryResult = { decisionRequired: "lease-takeover", operation: "recovery",
    holderName: "Recovery editor", authorization };
  assert.deepEqual(JSON.parse(JSON.stringify(await exposed.restoreRecoveredWork(
    { authorization }))), recoveryResult);
  assert.deepEqual(JSON.parse(JSON.stringify(invocations.at(-1))), {
    channel: "document:restore-recovery", request: { authorization },
  });
  divergenceResult = { decisionRequired: "lease-takeover", operation: "divergence",
    holderName: "Merge editor", authorization };
  assert.deepEqual(JSON.parse(JSON.stringify(await exposed.beginDivergenceResolution())),
    divergenceResult);
  assert.deepEqual(JSON.parse(JSON.stringify(invocations.at(-1))), {
    channel: "document:begin-divergence-resolution", request: {},
  });
  assert.equal(await exposed.cancelLeaseTakeover(authorization), true);
  assert.deepEqual(JSON.parse(JSON.stringify(invocations.at(-1))), {
    channel: "document:cancel-lease-takeover", request: authorization,
  });
  await assert.rejects(exposed.cancelLeaseTakeover("not-an-authorization"),
    /lease takeover request is invalid/);
  migrationResult = { decisionRequired: "lease-takeover", operation: "migration",
    holderName: "Future editor", authorization };
  assert.deepEqual(JSON.parse(JSON.stringify(await exposed.migrateDocument())),
    migrationResult);
  assert.deepEqual(JSON.parse(JSON.stringify(invocations.at(-1))), {
    channel: "document:migrate", request: {},
  });
  await assert.rejects(exposed.createDocument({
    ownerPassword: "owner password words",
    ownerPasswordConfirmation: "owner password words",
    recoveryPassword: "",
    recoveryPasswordConfirmation: "",
    content: "",
    understandsIrrecoverable: true,
    storedRecoverySeparately: false,
  }), /invalid creation result/);
  assert.deepEqual(JSON.parse(JSON.stringify(invocations.at(-1))), {
    channel: "document:create",
    request: {
      ownerPassword: "owner password words",
      ownerPasswordConfirmation: "owner password words",
      recoveryPassword: "",
      recoveryPasswordConfirmation: "",
      content: "",
      understandsIrrecoverable: true,
      storedRecoverySeparately: false,
    },
  });
  creationResult = { created: true, opened: editOpened, name: "new.scpefe" };
  assert.deepEqual(JSON.parse(JSON.stringify(await exposed.createDocument({
    ownerPassword: "owner password words",
    ownerPasswordConfirmation: "owner password words",
    recoveryPassword: "different recovery words",
    recoveryPasswordConfirmation: "different recovery words",
    content: "",
    understandsIrrecoverable: true,
    storedRecoverySeparately: true,
  }))), { created: true, opened: editOpened, name: "new.scpefe" });
  assert.deepEqual(JSON.parse(JSON.stringify(invocations.at(-1))), {
    channel: "document:create",
    request: {
      ownerPassword: "owner password words",
      ownerPasswordConfirmation: "owner password words",
      recoveryPassword: "different recovery words",
      recoveryPasswordConfirmation: "different recovery words",
      content: "",
      understandsIrrecoverable: true,
      storedRecoverySeparately: true,
    },
  });
  await assert.rejects(exposed.createDocument({
    ownerPassword: "owner password words",
    ownerPasswordConfirmation: "owner password words",
    recoveryPassword: "different recovery words",
    recoveryPasswordConfirmation: "different recovery words",
    content: "",
    understandsIrrecoverable: true,
    storedRecoverySeparately: false,
  }), /recovery password storage must be acknowledged/);
  assert.equal(invocations.filter(({ channel }) =>
    channel === "document:create").length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(await exposed.chooseOpenTarget())),
    { selected: true, name: "notes.scpefe" });
  assert.equal(invocations.at(-1).channel, "document:choose-open-target");
  await exposed.cancelOpenTarget();
  assert.equal(invocations.at(-1).channel, "document:cancel-open-target");
  assert.equal((await exposed.openSelectedDocument("correct password")).content,
    "secret");
  assert.deepEqual(invocations.at(-1), {
    channel: "document:open-selected", request: "correct password" });
  assert.equal((await exposed.unlockDocument("correct password")).content, "secret");
  assert.deepEqual(invocations.at(-1), {
    channel: "document:unlock", request: "correct password" });
  assert.equal(await exposed.cancelInvitationClaim(), true);
  assert.equal(invocations.at(-1).channel, "document:cancel-invitation-claim");
  assert.deepEqual(JSON.parse(JSON.stringify(await exposed.removeSlot("ab".repeat(16)))), {
    removed: true, warning: "Password slot removed.",
  });
  await exposed.changePassword({ currentPassword: "current password words",
    newPassword: "replacement password words",
    newPasswordConfirmation: "replacement password words", ignored: "private" });
  assert.deepEqual(JSON.parse(JSON.stringify(invocations.at(-1))), {
    channel: "document:change-password", request: {
      currentPassword: "current password words", newPassword: "replacement password words",
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await exposed.createInvitation({
    temporaryLabel: "Colleague", temporaryPassword: "", canEdit: true,
    canAddPasswords: false, canRemovePasswords: false, ignored: "private",
  }))), { created: true, temporaryPassword: "generated secret words" });
  assert.deepEqual(JSON.parse(JSON.stringify(invocations.at(-1))), {
    channel: "document:create-invitation", request: {
      temporaryLabel: "Colleague", canEdit: true, canAddPasswords: false,
      canRemovePasswords: false,
    },
  });
  invitationResult = { created: true, temporaryPassword: "" };
  await assert.rejects(exposed.createInvitation({ temporaryLabel: "Colleague",
    canEdit: false, canAddPasswords: false, canRemovePasswords: false }),
  /invalid invitation result/);
  assert.equal(await exposed.copyInvitationPassphrase("generated secret words"), true);
  assert.deepEqual(invocations.at(-1), {
    channel: "document:copy-invitation-passphrase", request: "generated secret words" });
  await assert.rejects(exposed.claimInvitation({ newPassword: "short",
    newPasswordConfirmation: "short" }), /at least 12/);
  await assert.rejects(exposed.claimInvitation({
    newPassword: "replacement password words",
    newPasswordConfirmation: "mismatched password words",
  }), /do not match/);
  assert.equal((await exposed.claimInvitation({
    newPassword: "replacement password words",
    newPasswordConfirmation: "replacement password words", ignored: "private",
  })).content, "claimed");
  assert.deepEqual(invocations.at(-1), { channel: "document:claim-invitation",
    request: "replacement password words" });
  await assert.rejects(exposed.createDocument({
    ownerPassword: "owner password words",
    ownerPasswordConfirmation: "owner password typo",
    recoveryPassword: "", recoveryPasswordConfirmation: "",
    content: "", understandsIrrecoverable: true,
    storedRecoverySeparately: false,
  }), /owner passwords do not match/);
  assert.equal(invocations.filter(({ channel }) =>
    channel === "document:create").length, 2);
  await assert.rejects(exposed.backupDocument(), /invalid backup result/);
});
