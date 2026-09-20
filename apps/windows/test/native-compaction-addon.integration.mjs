import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require(process.argv[2]);
const owner = "owner passphrase with independent words";
const recovery = "offline recovery passphrase is different";
const temporary = "Correct horse battery staple for invited colleague 8742!";
const colleague = "A distinct private replacement phrase for Grace 5931!";
const sessionId = "5a".repeat(16);

let container = native.createDocument({ name: "Ada", email: "ada@example.test",
  deviceName: "Desk", content: "initial", timestampMs: 1000,
  ownerPassword: owner, recoveryPassword: recovery });
container = native.updateLease(container, owner, { active: true, sessionId,
  heartbeatCounter: 4, holderUtcMs: 2000, durationMs: 600_000,
  holderName: "Ada", holderEmail: "ada@example.test", deviceName: "Desk" });
container = native.saveDocument(container, owner, { name: "Ada",
  email: "ada@example.test", deviceName: "Desk", content: "current text",
  timestampMs: 3000 });
container = native.addInvitation(container, owner, {
  temporaryPassword: temporary,
  temporaryLabel: "Colleague", canEdit: true,
  canAddPasswords: false, canRemovePasswords: false,
});
const before = native.openDocument(container, owner);
assert.ok(before.revisionGraph.length > 1);

const compacted = native.compactDocument(container, owner, {
  sessionId, heartbeatCounter: 4,
});
const after = native.openDocument(compacted, owner);
assert.equal(after.documentId, before.documentId);
assert.equal(after.content, "current text");
assert.equal(after.manuallySealed, true);
assert.deepEqual(after.managedSlots, before.managedSlots);
assert.deepEqual(after.revisionGraph, [{ revisionId: after.baseRevision,
  parentRevisionIds: [before.baseRevision] }]);
assert.equal(after.lease.sessionId, sessionId);
assert.equal(after.lease.heartbeatCounter, 4);
assert.equal(native.openDocument(compacted, recovery).content, "current text");
assert.throws(() => native.compactDocument(container, owner, {
  sessionId, heartbeatCounter: 5,
}), /SCPEFE operation failed/);
const claimed = native.claimInvitation(compacted, temporary, {
  newPassword: colleague, name: "Grace", email: "grace@example.test",
});
assert.throws(() => native.compactDocument(claimed, colleague, {
  sessionId, heartbeatCounter: 4,
}), /SCPEFE operation failed/);
