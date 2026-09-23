import assert from "node:assert/strict";
import { createRequire } from "node:module";

const native = createRequire(import.meta.url)(process.argv[2]);
const cases = [
  ["strong passphrase with several unrelated private words 2026!", true],
  ["passwordpassword", false],
  ["short", false],
  ["550e8400-e29b-41d4-a716-446655440000", true],
  ["550E8400-E29B-41D4-A716-446655440000", true],
  ["00000000-0000-1000-8000-000000000000", false],
];
for (const [password, accepted] of cases) {
  assert.equal(native.passwordMeetsPolicy(password), accepted);
}

const owner = "owner passphrase with independent words and punctuation ! 42";
const recovery = "offline recovery phrase: separate, durable, and private # 73";
assert.doesNotThrow(() => native.createDocument({ name: "Ada", email: "ada@example.test",
  deviceName: "Ada PC", content: "", ownerPassword: owner,
  recoveryPassword: recovery, timestampMs: 1 }));
assert.throws(() => native.createDocument({ name: "Ada", email: "ada@example.test",
  deviceName: "Ada PC", content: "", ownerPassword: "passwordpassword",
  timestampMs: 1 }), /status 12/);
