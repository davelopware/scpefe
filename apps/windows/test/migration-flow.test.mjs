import assert from "node:assert/strict";
import test from "node:test";
import { migrateWithBackupSelection,
  registerMigrationHandler } from "../src/migration-flow.mjs";

test("migration retries a failed backup elsewhere", async () => {
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
    async showSaveDialog() { return { canceled: false, filePath: "D:\\safe.scpefe" }; },
  };
  assert.deepEqual(await migrateWithBackupSelection({ service, dialog, window: {} }),
    { migrated: true });
  assert.deepEqual(calls, [[undefined, { takeoverToken: undefined }],
    ["D:\\safe.scpefe", { takeoverToken: undefined }]]);
});

test("trusted migration IPC boundary validates renderer decision", async () => {
  let handler;
  registerMigrationHandler({ ipcMain: { handle(channel, value) {
    assert.equal(channel, "document:migrate"); handler = value;
  } }, service: { async migrateDocument() { return { migrated: true }; } },
  dialog: {}, window: {} });
  await assert.rejects(handler({}, {}), /migration decision is invalid/);
  assert.deepEqual(await handler({}, { forceTakeover: false }), { migrated: true });
});

test("only backup failures offer another destination", async () => {
  let prompted = false;
  await assert.rejects(migrateWithBackupSelection({
    service: { async migrateDocument() { throw new Error("lease changed"); } },
    dialog: { async showSaveDialog() { prompted = true; } }, window: {},
  }), /lease changed/);
  assert.equal(prompted, false);
});

test("uncertain migration lease requires a staged renderer confirmation", async () => {
  const calls = [];
  const takeoverToken = Object.freeze({});
  const service = { async migrateDocument(target, options) {
    calls.push([target, options]);
    if (options.takeoverToken !== takeoverToken) {
      const error = new Error("future lease");
      error.code = "LEASE_CLOCK_UNCERTAIN";
      error.lease = { holderName: "Remote editor" };
      error.takeoverToken = takeoverToken;
      throw error;
    }
    return { migrated: true };
  } };
  let handler;
  registerMigrationHandler({ ipcMain: { handle(_channel, value) { handler = value; } },
    service, dialog: {}, window: {} });
  assert.deepEqual(await handler({}, { forceTakeover: false }),
    { decisionRequired: "lease-takeover", holderName: "Remote editor" });
  assert.deepEqual(await handler({}, { forceTakeover: true }), { migrated: true });
  assert.deepEqual(calls, [[undefined, { takeoverToken: undefined }],
    [undefined, { takeoverToken }]]);
});

test("force migration is rejected without a staged uncertain lease", async () => {
  let handler;
  registerMigrationHandler({ ipcMain: { handle(_channel, value) { handler = value; } },
    service: { async migrateDocument() { throw new Error("must not run"); } },
    dialog: {}, window: {} });
  await assert.rejects(handler({}, { forceTakeover: true }),
    /No migration lease takeover/);
});
