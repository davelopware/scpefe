import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const native = createRequire(import.meta.url)(process.argv[2]);
const owner = "owner passphrase with independent words";
const recovery = "offline recovery passphrase is different";
const legacy = Buffer.from(fs.readFileSync(new URL(
  "fixtures/password-container-v2.hex", import.meta.url), "utf8").trim(), "hex");
const beforeOwner = native.openDocument(legacy, owner);
const beforeRecovery = native.openDocument(legacy, recovery);
assert.equal(beforeOwner.containerFormatVersion, 2);
const migrated = native.migrateDocument(legacy, owner, {
  name: "Ada", email: "ada@example.test", deviceName: "Current PC",
  timestampMs: 2000, sessionId: "7a".repeat(16), heartbeatCounter: 1,
  holderUtcMs: 2000, durationMs: 600_000,
});
const afterOwner = native.openDocument(migrated, owner);
const afterRecovery = native.openDocument(migrated, recovery);
assert.equal(afterOwner.containerFormatVersion, 3);
assert.equal(afterOwner.documentId, beforeOwner.documentId);
assert.equal(afterOwner.content, beforeOwner.content);
assert.equal(afterRecovery.content, beforeRecovery.content);
assert.equal(afterOwner.historyEventType, "format-migration");
assert.equal(afterOwner.historyEventDetail, "container-version-2-to-3");
assert.equal(afterOwner.revisionGraph.at(-1).parentRevisionIds[0],
  beforeOwner.baseRevision);
assert.equal(afterOwner.lease.sessionId, "7a".repeat(16));
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
