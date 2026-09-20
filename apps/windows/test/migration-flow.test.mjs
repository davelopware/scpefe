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
    async migrateDocument(target) {
      calls.push(target);
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
  assert.deepEqual(calls, [undefined, "D:\\safe.scpefe"]);
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
