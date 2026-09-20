import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("sandboxed Electron loads a bundled CommonJS preload", async () => {
  const main = await fs.readFile(new URL("../src/main.mjs", import.meta.url), "utf8");
  const config = await fs.readFile(
    new URL("../vite.preload.config.ts", import.meta.url), "utf8");
  const preload = await fs.readFile(
    new URL("../dist/preload.cjs", import.meta.url), "utf8");
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /powerMonitor\.on\(["']lock-screen["']/);
  assert.match(main, /window\.on\(["']blur["']/);
  assert.match(main, /service\.lock\(["']app-lock["']\)/);
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /app\.on\(["']second-instance["']/);
  assert.match(main, /existing instance remains authoritative/);
  assert.match(main, /Windows Task Manager/);
  assert.doesNotMatch(main, /taskkill|process\.kill|child_process/);
  assert.match(main, /needsCloseDecision\(active\)/);
  assert.match(main, /applyCloseDecision\(service/);
  assert.match(main, /Manual save and exit/);
  assert.match(main, /Discard and exit/);
  assert.doesNotMatch(main,
    /if \(closingAfterRelease \|\| !service\.active\?\.editMode\) return/);
  assert.match(main, /dist["'],\s*["']preload\.cjs/);
  assert.doesNotMatch(main, /preload\.mjs/);
  assert.match(config, /formats:\s*\[["']cjs["']\]/);
  assert.match(config, /external:\s*\[["']electron["']\]/);
  assert.doesNotMatch(preload, /(^|\n)\s*import\s/m);
  assert.match(preload, /require\(["']electron["']\)/);

  let exposed;
  let creationResult = { created: true, target: "C:\\Users\\Ada\\secret.scpefe" };
  let compactionResult = null;
  const invocations = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
    ipcRenderer: { on: () => {}, removeListener: () => {},
      invoke: async (channel, request) => {
        invocations.push({ channel, request });
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
    "getProfile", "saveProfile", "getClientSettings", "saveClientSettings",
    "getUnresolvedJournalSummary", "createDocument", "openDocument",
    "openExternalDocument",
    "enterEditMode", "saveDocument", "reconnectPendingPublication",
    "beginDivergenceResolution", "saveDivergenceResolution",
    "discardPendingPublication", "backupDocument", "compactDocument", "migrateDocument",
    "createInvitation",
    "claimInvitation", "reconcileIdentity", "updateSlotPermissions", "removeSlot",
    "exportPlaintext", "updateWorkingCopy", "activity",
    "restoreRecoveredWork", "discardRecoveredWork", "acceptHeadMismatch", "lock", "onLocked",
    "onJournalWarning", "onRegularSave", "onExternalOpenRequested",
    "onUnresolvedJournalSummary",
    "onSwitchRetained",
  ]);
  assert.equal(await exposed.compactDocument(), null);
  compactionResult = { compacted: true, backupCreated: true,
    previousHead: "12".repeat(32), head: "34".repeat(32) };
  assert.deepEqual(JSON.parse(JSON.stringify(await exposed.compactDocument())),
    compactionResult);
  compactionResult = { compacted: true, backupCreated: false,
    previousHead: "12".repeat(32), head: "34".repeat(32) };
  await assert.rejects(exposed.compactDocument(), /invalid compaction result/);
  await assert.rejects(exposed.createDocument({
    ownerPassword: "owner password words",
    recoveryPassword: "",
    content: "hello",
    understandsIrrecoverable: true,
    storedRecoverySeparately: false,
  }), /invalid creation result/);
  assert.deepEqual(JSON.parse(JSON.stringify(invocations.at(-1))), {
    channel: "document:create",
    request: {
      ownerPassword: "owner password words",
      recoveryPassword: null,
      content: "hello",
      understandsIrrecoverable: true,
      storedRecoverySeparately: false,
    },
  });
  creationResult = { created: true };
  assert.deepEqual(JSON.parse(JSON.stringify(await exposed.createDocument({
    ownerPassword: "owner password words",
    recoveryPassword: "different recovery words",
    content: "hello",
    understandsIrrecoverable: true,
    storedRecoverySeparately: true,
  }))), { created: true });
  assert.deepEqual(JSON.parse(JSON.stringify(invocations.at(-1))), {
    channel: "document:create",
    request: {
      ownerPassword: "owner password words",
      recoveryPassword: "different recovery words",
      content: "hello",
      understandsIrrecoverable: true,
      storedRecoverySeparately: true,
    },
  });
  await assert.rejects(exposed.createDocument({
    ownerPassword: "owner password words",
    recoveryPassword: "different recovery words",
    content: "hello",
    understandsIrrecoverable: true,
    storedRecoverySeparately: false,
  }), /recovery password storage must be acknowledged/);
  assert.equal(invocations.filter(({ channel }) =>
    channel === "document:create").length, 2);
  await assert.rejects(exposed.backupDocument(), /invalid backup result/);
});
