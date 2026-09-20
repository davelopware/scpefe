import assert from "node:assert/strict";
import { createRequire } from "node:module";

const native = createRequire(import.meta.url)(process.argv[2]);
const owner = "owner passphrase with independent words";
const recovery = "offline recovery passphrase is different";
const temporary = "cobalt-lantern-river-planet-73";
const replacement = "new invited passphrase with private words";
const original = native.createDocument({ name: "Ada", email: "ada@example.test",
  deviceName: "Ada PC", content: "not visible before claim", ownerPassword: owner,
  recoveryPassword: recovery, timestampMs: 1 });
const invited = native.addInvitation(original, owner, { temporaryPassword: temporary,
  temporaryLabel: "New colleague", canEdit: true, canAddPasswords: false,
  canRemovePasswords: false });
assert.throws(() => native.addInvitation(invited, "wrong creator password words", {
  temporaryPassword: "another temporary invitation password", temporaryLabel: "No one",
  canEdit: false, canAddPasswords: false, canRemovePasswords: false,
}));
assert.throws(() => native.claimInvitation(invited, "wrong temporary password words", {
  newPassword: "unused replacement password words", name: "Grace Hopper",
  email: "grace@example.test",
}));
assert.equal(native.openDocument(invited, owner).content, "not visible before claim");
assert.equal(native.openDocument(invited, recovery).content, "not visible before claim");
const firstUse = native.openDocument(invited, temporary);
assert.equal(firstUse.mustBeChanged, true);
assert.equal(firstUse.content, "");
assert.equal(firstUse.canEdit, false);
assert.equal(firstUse.slotIdentityName, "New colleague");
const claimed = native.claimInvitation(invited, temporary, { newPassword: replacement,
  name: "Grace Hopper", email: "grace@example.test" });
assert.throws(() => native.openDocument(claimed, temporary));
const opened = native.openDocument(claimed, replacement);
assert.equal(opened.mustBeChanged, false);
assert.equal(opened.content, "not visible before claim");
assert.equal(opened.canEdit, true);
assert.equal(opened.slotIdentityName, "Grace Hopper");
assert.equal(opened.slotIdentityEmail, "grace@example.test");
const leased = native.updateLease(claimed, replacement, {
  active: true, sessionId: "12".repeat(16), heartbeatCounter: 1,
  holderUtcMs: 2, durationMs: 600_000, holderName: "Grace Hopper",
  holderEmail: "grace@example.test", deviceName: "Grace PC",
});
const saved = native.saveDocument(leased, replacement, { name: "Grace Hopper",
  email: "grace@example.test", deviceName: "Grace PC", content: "claimed edit",
  timestampMs: 3 });
assert.equal(native.openDocument(saved, replacement).content, "claimed edit");
