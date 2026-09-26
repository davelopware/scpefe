import assert from "node:assert/strict";
import { createRequire } from "node:module";

const native = createRequire(import.meta.url)(process.argv[2]);
const expectedExports = [
  "addInvitation", "assessPasswordPolicy", "changePassword", "claimInvitation",
  "compactDocument", "createDocument", "discardProvisional", "mergeDocument",
  "migrateDocument", "openDocument", "passwordMeetsPolicy", "reconcileIdentity",
  "regularSaveDocument", "removeSlot", "saveDocument", "updateLease",
  "updateSlotPermissions",
];
assert.deepEqual(Object.getOwnPropertyNames(native).sort(), expectedExports,
  "the addon exports every declared operation");
const cases = [
  ["strong passphrase with several unrelated private words 2026!", true],
  ["passwordpassword", false],
  ["short", false],
  ["550e8400-e29b-41d4-a716-446655440000", true],
  ["550E8400-E29B-41D4-A716-446655440000", true],
  ["00000000-0000-1000-8000-000000000000", false],
  ["defenistration is the root of", true],
  ["01a0bf20-2424-73e9-a572-f2eded90be3e", true],
];
for (const [password, accepted] of cases) {
  assert.equal(native.passwordMeetsPolicy(password), accepted);
  assert.equal(native.assessPasswordPolicy(password), accepted ? "accepted"
    : Buffer.byteLength(password, "utf8") < 12 ? "minimum-length" : "predictable");
}
assert.equal(native.assessPasswordPolicy("ééééé"), "minimum-length");
assert.equal(native.assessPasswordPolicy("éééééé"), "predictable");

const owner = "owner passphrase with independent words and punctuation ! 42";
const recovery = "offline recovery phrase: separate, durable, and private # 73";
assert.doesNotThrow(() => native.createDocument({ name: "Ada", email: "ada@example.test",
  deviceName: "Ada PC", content: "", ownerPassword: owner,
  recoveryPassword: recovery, timestampMs: 1 }));
assert.throws(() => native.createDocument({ name: "Ada", email: "ada@example.test",
  deviceName: "Ada PC", content: "", ownerPassword: "passwordpassword",
  timestampMs: 1 }), /status 12/);

assert.doesNotThrow(() => native.createDocument({ name: "Ada", email: "ada@example.test",
  deviceName: "Ada PC", content: "", ownerPassword: "defenistration is the root of",
  recoveryPassword: "01a0bf20-2424-73e9-a572-f2eded90be3e", timestampMs: 1 }));
