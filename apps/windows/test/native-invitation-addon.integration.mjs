import assert from "node:assert/strict";
import fs from "node:fs";
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
assert.equal(native.openDocument(saved, owner).slotIdentityName, "Ada");
assert.equal(native.openDocument(saved, owner).slotIdentityEmail, "ada@example.test");
const managed = native.openDocument(saved, owner).managedSlots;
assert.equal(managed.length, 1);
assert.equal(managed[0].identityName, "Grace Hopper");
assert.throws(() => native.updateSlotPermissions(saved, owner, {
  slotId: managed[0].slotId, canEdit: false, canAddPasswords: true,
  canRemovePasswords: false,
}));
const viewOnly = native.updateSlotPermissions(saved, owner, {
  slotId: managed[0].slotId, canEdit: false, canAddPasswords: false,
  canRemovePasswords: false,
});
assert.equal(native.openDocument(viewOnly, replacement).canEdit, false);
const reconciled = native.reconcileIdentity(viewOnly, replacement, {
  name: "Rear Admiral Grace Hopper", email: "hopper@example.test",
});
assert.equal(native.openDocument(reconciled, replacement).slotIdentityName,
  "Rear Admiral Grace Hopper");
const identityRevision = native.saveDocument(reconciled, replacement, {
  name: "Rear Admiral Grace Hopper", email: "hopper@example.test",
  deviceName: "Grace PC", content: "claimed edit", timestampMs: 4,
});
assert.equal(native.openDocument(identityRevision, replacement).canEdit, false);
assert.equal(native.openDocument(identityRevision, recovery).recoverySlot, true);
const removed = native.removeSlot(identityRevision, owner, managed[0].slotId);
assert.throws(() => native.openDocument(removed, replacement));
assert.equal(native.openDocument(removed, owner).canRemovePasswords, true);

function firstInvitationPasswordRecord(container) {
  const slotCount = container.readUInt32LE(32);
  const offset = 160 + slotCount * 65 + 12;
  const ciphertextSize = container.readUInt32LE(offset + 40);
  return container.subarray(offset, offset + 44 + ciphertextSize);
}

const legacyFixture = Buffer.from(fs.readFileSync(new URL(
  "fixtures/legacy-invitation-v2.hex", import.meta.url), "utf8").trim(), "hex");
const legacyOpened = native.openDocument(legacyFixture, owner);
assert.equal(legacyOpened.managedSlots.length, 1);
assert.equal(legacyOpened.managedSlots[0].slotIdKnown, false);
assert.equal(legacyOpened.managedSlots[0].permissionsKnown, false);
assert.equal(legacyOpened.managedSlots[0].mustBeChangedKnown, false);
assert.equal(legacyOpened.managedSlots[0].identityKnown, false);
assert.match(legacyOpened.managedSlots[0].identityName, /Legacy invitation 1/);
const legacyHandle = legacyOpened.managedSlots[0].slotId;
const legacyWrapper = firstInvitationPasswordRecord(legacyFixture);
const legacyClaimBeforeMigration = native.claimInvitation(legacyFixture, temporary, {
  newPassword: "legacy claim password before migration words",
  name: "Grace Hopper", email: "grace@example.test",
});
assert.equal(native.openDocument(legacyClaimBeforeMigration, owner)
  .managedSlots[0].slotId, legacyHandle);
const legacyRestricted = native.updateSlotPermissions(legacyFixture, owner, {
  slotId: legacyHandle, canEdit: false, canAddPasswords: false,
  canRemovePasswords: false,
});
const restrictedTemporary = native.openDocument(legacyRestricted, temporary);
assert.equal(restrictedTemporary.mustBeChanged, true);
assert.equal(restrictedTemporary.content, "");
const restrictedClaimed = native.claimInvitation(legacyRestricted, temporary, {
  newPassword: "violet-cascade-orbit-tundra-8492",
  name: "Grace Hopper", email: "grace@example.test",
});
assert.equal(native.openDocument(restrictedClaimed,
  "violet-cascade-orbit-tundra-8492").canEdit, false);
const legacyUpgraded = native.updateSlotPermissions(legacyFixture, owner, {
  slotId: legacyHandle, canEdit: true, canAddPasswords: false,
  canRemovePasswords: false,
});
assert.equal(legacyUpgraded.includes(Buffer.from("SCPINV03")), true);
assert.deepEqual(firstInvitationPasswordRecord(legacyUpgraded), legacyWrapper);
const legacyManaged = native.openDocument(legacyUpgraded, owner).managedSlots[0];
assert.equal(legacyManaged.slotId, legacyHandle);
assert.equal(legacyManaged.permissionsKnown, true);
const legacyClaimed = native.claimInvitation(legacyUpgraded, temporary, {
  newPassword: replacement, name: "Grace Hopper", email: "grace@example.test",
});
const legacyClaimedOpened = native.openDocument(legacyClaimed, replacement);
assert.equal(legacyClaimedOpened.canEdit, true);
assert.equal(legacyClaimedOpened.slotIdentityName, "Grace Hopper");
const legacyReconciled = native.reconcileIdentity(legacyClaimed, replacement, {
  name: "Rear Admiral Grace Hopper", email: "hopper@example.test",
});
assert.equal(native.openDocument(legacyReconciled, replacement).slotIdentityName,
  "Rear Admiral Grace Hopper");
const legacyLeased = native.updateLease(legacyReconciled, replacement, {
  active: true, sessionId: "34".repeat(16), heartbeatCounter: 1,
  holderUtcMs: 5, durationMs: 600_000, holderName: "Rear Admiral Grace Hopper",
  holderEmail: "hopper@example.test", deviceName: "Grace PC",
});
const legacySaved = native.saveDocument(legacyLeased, replacement, {
  name: "Rear Admiral Grace Hopper", email: "hopper@example.test",
  deviceName: "Grace PC", content: "legacy invited edit", timestampMs: 6,
});
assert.equal(native.openDocument(legacySaved, owner).slotIdentityName, "Ada");
assert.equal(native.openDocument(legacySaved, owner).slotIdentityEmail,
  "ada@example.test");
const legacyRemoved = native.removeSlot(legacySaved, owner, legacyHandle);
assert.throws(() => native.openDocument(legacyRemoved, replacement));
assert.equal(native.openDocument(legacyRemoved, owner).content,
  "legacy invited edit");

const ownerReconciled = native.reconcileIdentity(saved, owner, {
  name: "Ada Lovelace", email: "lovelace@example.test",
});
assert.equal(native.openDocument(ownerReconciled, owner).slotIdentityName,
  "Ada Lovelace");
assert.equal(native.openDocument(ownerReconciled, recovery).recoverySlot, true);

const removeAdministratorTemporary = "marble-cedar-quartz-signal-4821";
const removeAdministratorPassword = "ember-harbor-velvet-planet-9506";
const removalTargetTemporary = "falcon-iris-meadow-cipher-3718";
const removeAdministratorInvitation = native.addInvitation(original, owner, {
  temporaryPassword: removeAdministratorTemporary,
  temporaryLabel: "Remove-only administrator", canEdit: true,
  canAddPasswords: false, canRemovePasswords: true,
});
const withRemovalTarget = native.addInvitation(removeAdministratorInvitation, owner, {
  temporaryPassword: removalTargetTemporary, temporaryLabel: "Removal target",
  canEdit: false, canAddPasswords: false, canRemovePasswords: false,
});
const removeAdministratorClaimed = native.claimInvitation(withRemovalTarget,
  removeAdministratorTemporary, { newPassword: removeAdministratorPassword,
    name: "Remove Administrator", email: "remove@example.test" });
const removeAdministratorOpened = native.openDocument(
  removeAdministratorClaimed, removeAdministratorPassword);
assert.equal(removeAdministratorOpened.canAddPasswords, false);
assert.equal(removeAdministratorOpened.canRemovePasswords, true);
assert.equal(removeAdministratorOpened.managedSlots.length, 2);
const removalTarget = removeAdministratorOpened.managedSlots.find(
  (slot) => slot.identityName === "Removal target");
assert.ok(removalTarget);
assert.throws(() => native.updateSlotPermissions(removeAdministratorClaimed,
  removeAdministratorPassword, { slotId: removalTarget.slotId, canEdit: true,
    canAddPasswords: false, canRemovePasswords: false }));
const removedByRemoveOnly = native.removeSlot(removeAdministratorClaimed,
  removeAdministratorPassword, removalTarget.slotId);
assert.throws(() => native.openDocument(removedByRemoveOnly,
  removalTargetTemporary));
assert.equal(native.openDocument(removedByRemoveOnly,
  removeAdministratorPassword).canRemovePasswords, true);
