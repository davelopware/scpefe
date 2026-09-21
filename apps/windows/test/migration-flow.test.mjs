import assert from "node:assert/strict";
import test from "node:test";
import { migrateWithBackupSelection,
  registerMigrationHandler } from "../src/migration-flow.mjs";
import { LeaseTakeoverAuthorizations } from "../src/lease-takeover.mjs";

const authorization = "123e4567-e89b-42d3-a456-426614174000";
const validateAuthorization = (request) => {
  if (!request || typeof request !== "object"
      || Object.keys(request).some((key) => key !== "authorization")) {
    throw new TypeError("migration decision is invalid");
  }
  return request.authorization;
};

function register(options) {
  const authorizations = new LeaseTakeoverAuthorizations({ createId: () => authorization });
  registerMigrationHandler({ ...options, getService: () => options.service,
    authorizations, validateAuthorization });
}

test("migration retries a failed backup elsewhere", async () => {
  const calls = [];
  const initialToken = Object.freeze({ initial: true });
  const continuationToken = Object.freeze({ continuation: true });
  const service = { suggestedBackupTarget: () => "C:\\default.scpefe",
    async migrateDocument(target, options) {
      calls.push([target, options]);
      if (target === undefined) {
        const error = new Error("backup failed"); error.code = "MIGRATION_BACKUP_FAILED";
        error.takeoverToken = continuationToken;
        throw error;
      }
      return { migrated: true };
    } };
  const dialog = {
    async showSaveDialog() { return { canceled: false, filePath: "D:\\safe.scpefe" }; },
  };
  assert.deepEqual(await migrateWithBackupSelection({ service, dialog, window: {},
    takeoverToken: initialToken }),
    { migrated: true });
  assert.deepEqual(calls, [[undefined, { takeoverToken: initialToken }],
    ["D:\\safe.scpefe", { takeoverToken: continuationToken }]]);
});

test("trusted migration IPC boundary validates renderer decision", async () => {
  let handler;
  register({ ipcMain: { handle(channel, value) {
    assert.equal(channel, "document:migrate"); handler = value;
  } }, service: { async migrateDocument() { return { migrated: true }; } },
  dialog: {}, window: {} });
  await assert.rejects(handler({}, { extra: true }), /migration decision is invalid/);
  assert.deepEqual(await handler({}, {}), { migrated: true });
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
  const service = { cancelLeaseTakeover() { return true; },
    suggestedBackupTarget() { return "C:\\fallback.scpefe"; },
    async migrateDocument(target, options) {
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
  register({ ipcMain: { handle(_channel, value) { handler = value; } },
    service, dialog: {}, window: {} });
  assert.deepEqual(await handler({}, {}),
    { decisionRequired: "lease-takeover", operation: "migration",
      holderName: "Remote editor", authorization });
  assert.deepEqual(await handler({}, { authorization }), { migrated: true });
  assert.deepEqual(calls, [[undefined, { takeoverToken: undefined }],
    [undefined, { takeoverToken }]]);
});

test("migration authorization is one-shot and rejected without staged evidence", async () => {
  let handler;
  register({ ipcMain: { handle(_channel, value) { handler = value; } },
    service: { cancelLeaseTakeover() { return true; },
      async migrateDocument() { throw new Error("must not run"); } },
    dialog: {}, window: {} });
  await assert.rejects(handler({}, { authorization }), /No matching lease takeover/);
});

test("backup picker cancellation consumes takeover and fresh retry stages new evidence", async () => {
  const ids = ["123e4567-e89b-42d3-a456-426614174000",
    "223e4567-e89b-42d3-a456-426614174000"];
  const tokens = [Object.freeze({ sequence: 1 }), Object.freeze({ sequence: 2 })];
  let idIndex = 0;
  let observation = 0;
  const service = { cancelLeaseTakeover() { return true; },
    suggestedBackupTarget() { return "C:\\fallback.scpefe"; },
    async migrateDocument(_target, { takeoverToken }) {
      if (takeoverToken) {
        const error = new Error("backup failed");
        error.code = "MIGRATION_BACKUP_FAILED";
        error.takeoverToken = Object.freeze({ continuation: true });
        throw error;
      }
      const error = new Error("future lease");
      error.code = "LEASE_CLOCK_UNCERTAIN";
      error.lease = { holderName: `Remote editor ${observation + 1}` };
      error.takeoverToken = tokens[observation++];
      throw error;
    } };
  const authorizations = new LeaseTakeoverAuthorizations({
    createId: () => ids[idIndex++],
  });
  let handler;
  registerMigrationHandler({ ipcMain: { handle(_channel, value) { handler = value; } },
    getService: () => service, service, authorizations, validateAuthorization,
    dialog: { async showSaveDialog() { return { canceled: true }; } }, window: {} });
  const first = await handler({}, {});
  assert.equal(first.authorization, ids[0]);
  assert.equal(await handler({}, { authorization: first.authorization }), null);
  await assert.rejects(handler({}, { authorization: first.authorization }),
    /No matching lease takeover/);
  const fresh = await handler({}, {});
  assert.equal(fresh.authorization, ids[1]);
  assert.notEqual(fresh.authorization, first.authorization);
});
