import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const native = createRequire(import.meta.url)(process.argv[2]);
const owner = "owner passphrase with independent words";
const recovery = "offline recovery passphrase is different";
const guestOne = "violet zeppelin compass orchid museum glacier";
const guestTwo = "amber telescope violin winter harbor quartz";
const newOwner = "renewed owner credential maple canyon satellite";
const legacy = Buffer.from(fs.readFileSync(new URL(
  "fixtures/password-container-v2-history-invitations.hex",
  import.meta.url), "utf8").trim(), "hex");

function baseWrappers(bytes) {
  return [Buffer.from(bytes.subarray(160, 225)), Buffer.from(bytes.subarray(225, 290))];
}

function invitationWrappers(bytes) {
  const magic = Buffer.from("SCPINV03");
  let offset = bytes.indexOf(magic);
  assert.notEqual(offset, -1);
  const count = bytes.readUInt32LE(offset + 8);
  offset += 12;
  const records = [];
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    offset += 44 + bytes.readUInt32LE(offset + 40);
    offset += 28 + bytes.readUInt32LE(offset + 24);
    records.push(Buffer.from(bytes.subarray(start, offset)));
  }
  return records;
}

function baseWrapperVersions(bytes) {
  const offset = 290;
  assert.equal(bytes.subarray(offset, offset + 8).toString(), "SCPMIG01");
  assert.equal(bytes.readUInt32LE(offset + 8), 2);
  return [bytes.readUInt32LE(offset + 12), bytes.readUInt32LE(offset + 16)];
}

const beforeOwner = native.openDocument(legacy, owner);
const beforeRecovery = native.openDocument(legacy, recovery);
const beforeGuestOne = native.openDocument(legacy, guestOne);
const beforeGuestTwo = native.openDocument(legacy, guestTwo);
const beforeBaseWrappers = baseWrappers(legacy);
const beforeInvitationWrappers = invitationWrappers(legacy);
assert.equal(beforeOwner.containerFormatVersion, 2);
assert.equal(beforeOwner.content, "third historical version");
assert.equal(beforeOwner.revisionGraph.length, 3);
assert.equal(beforeGuestOne.mustBeChanged, true);
assert.equal(beforeGuestTwo.mustBeChanged, true);
const migrated = native.migrateDocument(legacy, owner, {
  name: "Ada", email: "ada@example.test", deviceName: "Current PC",
  timestampMs: 2000, sessionId: "7a".repeat(16), heartbeatCounter: 1,
  holderUtcMs: 2000, durationMs: 600_000,
});
const afterOwner = native.openDocument(migrated, owner);
const afterRecovery = native.openDocument(migrated, recovery);
const afterGuestOne = native.openDocument(migrated, guestOne);
const afterGuestTwo = native.openDocument(migrated, guestTwo);
assert.equal(afterOwner.containerFormatVersion, 3);
assert.equal(afterOwner.documentId, beforeOwner.documentId);
assert.equal(afterOwner.content, beforeOwner.content);
assert.equal(afterRecovery.content, beforeRecovery.content);
assert.equal(afterRecovery.documentId, beforeRecovery.documentId);
assert.equal(afterGuestOne.documentId, beforeOwner.documentId);
assert.equal(afterGuestTwo.documentId, beforeOwner.documentId);
assert.equal(afterGuestOne.mustBeChanged, true);
assert.equal(afterGuestTwo.mustBeChanged, true);
assert.equal(afterOwner.historyEventType, "format-migration");
assert.equal(afterOwner.historyEventDetail, "container-version-2-to-3");
assert.deepEqual(afterOwner.revisionGraph.slice(0, -1), beforeOwner.revisionGraph);
assert.equal(afterOwner.revisionGraph.at(-1).parentRevisionIds[0],
  beforeOwner.baseRevision);
assert.equal(afterOwner.lease.sessionId, "7a".repeat(16));
assert.deepEqual(baseWrappers(migrated), beforeBaseWrappers);
assert.deepEqual(invitationWrappers(migrated), beforeInvitationWrappers);
assert.deepEqual(baseWrapperVersions(migrated), [2, 2]);

const rewrapped = native.changePassword(migrated, owner, newOwner);
assert.throws(() => native.openDocument(rewrapped, owner));
assert.equal(native.openDocument(rewrapped, newOwner).content, beforeOwner.content);
assert.equal(native.openDocument(rewrapped, recovery).content, beforeOwner.content);
assert.equal(native.openDocument(rewrapped, guestOne).mustBeChanged, true);
assert.equal(native.openDocument(rewrapped, guestTwo).mustBeChanged, true);
assert.notDeepEqual(baseWrappers(rewrapped)[0], beforeBaseWrappers[0]);
assert.deepEqual(baseWrappers(rewrapped)[1], beforeBaseWrappers[1]);
assert.deepEqual(invitationWrappers(rewrapped), beforeInvitationWrappers);
assert.deepEqual(baseWrapperVersions(rewrapped), [3, 2]);

const saved = native.saveDocument(migrated, owner, { name: "Ada",
  email: "ada@example.test", deviceName: "Current PC",
  content: "saved after migration", timestampMs: 2500 });
assert.equal(native.openDocument(saved, owner).content, "saved after migration");
assert.equal(native.openDocument(saved, recovery).content, "saved after migration");
assert.throws(() => native.migrateDocument(migrated, owner, {
  name: "Ada", email: "ada@example.test", deviceName: "Current PC",
  timestampMs: 3000, sessionId: "7b".repeat(16), heartbeatCounter: 1,
  holderUtcMs: 3000, durationMs: 600_000,
}));
