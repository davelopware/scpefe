import assert from "node:assert/strict";
import test from "node:test";
import { confirmAndMigrate, migrateWithBackupSelection,
  registerMigrationHandler } from "../src/migration-flow.mjs";

test("declining migration performs no write", async () => {
  let calls = 0;
  const result = await confirmAndMigrate({ service: { migrateDocument() { calls += 1; } },
    dialog: { async showMessageBox() { return { response: 0 }; } }, window: {} });
  assert.equal(result, null);
  assert.equal(calls, 0);
});

test("migration warns about older clients and retries a failed backup elsewhere", async () => {
  const calls = [];
  const service = { suggestedBackupTarget: () => "C:\\default.scpefe",
    async migrateDocument(target, options) {
      calls.push([target, options]);
      if (target === undefined) {
        const error = new Error("backup failed"); error.code = "MIGRATION_BACKUP_FAILED";
        throw error;
      }
      return { migrated: true };
    } };
  const dialog = {
    async showMessageBox(_window, options) {
      assert.match(options.detail, /Older SCPEFE clients/);
      assert.match(options.detail, /verified exact backup/);
      return { response: 1 };
    },
    async showSaveDialog() { return { canceled: false, filePath: "D:\\safe.scpefe" }; },
  };
  assert.deepEqual(await confirmAndMigrate({ service, dialog, window: {} }),
    { migrated: true });
  assert.deepEqual(calls, [[undefined, { forceTakeover: false }],
    ["D:\\safe.scpefe", { forceTakeover: false }]]);
});

test("trusted migration IPC boundary delegates through confirmation", async () => {
  let handler;
  registerMigrationHandler({ ipcMain: { handle(channel, value) {
    assert.equal(channel, "document:migrate"); handler = value;
  } }, service: { async migrateDocument() { return { migrated: true }; } },
  dialog: { async showMessageBox() { return { response: 1 }; } }, window: {} });
  assert.deepEqual(await handler(), { migrated: true });
});

test("only backup failures offer another destination", async () => {
  let prompted = false;
  await assert.rejects(migrateWithBackupSelection({
    service: { async migrateDocument() { throw new Error("lease changed"); } },
    dialog: { async showSaveDialog() { prompted = true; } }, window: {},
  }), /lease changed/);
  assert.equal(prompted, false);
});

test("uncertain migration lease requires trusted explicit force confirmation", async () => {
  const calls = [];
  const service = { async migrateDocument(target, options) {
    calls.push([target, options]);
    if (!options.forceTakeover) {
      const error = new Error("future lease");
      error.code = "LEASE_CLOCK_UNCERTAIN";
      error.lease = { holderName: "Remote editor" };
      throw error;
    }
    return { migrated: true };
  } };
  let prompts = 0;
  const dialog = { async showMessageBox(_window, options) {
    prompts += 1;
    if (prompts === 1) return { response: 1 };
    assert.match(options.message, /Remote editor/);
    assert.match(options.detail, /confirmed that no other client is editing/);
    return { response: 1 };
  } };
  assert.deepEqual(await confirmAndMigrate({ service, dialog, window: {} }),
    { migrated: true });
  assert.deepEqual(calls, [[undefined, { forceTakeover: false }],
    [undefined, { forceTakeover: true }]]);
});

test("canceling uncertain-clock takeover keeps migration read-only", async () => {
  let calls = 0;
  const service = { async migrateDocument() {
    calls += 1;
    const error = new Error("future lease");
    error.code = "LEASE_CLOCK_UNCERTAIN";
    error.lease = { holderName: "Remote editor" };
    throw error;
  } };
  let prompts = 0;
  const dialog = { async showMessageBox() {
    prompts += 1;
    return { response: prompts === 1 ? 1 : 0 };
  } };
  assert.equal(await confirmAndMigrate({ service, dialog, window: {} }), null);
  assert.equal(calls, 1);
});
