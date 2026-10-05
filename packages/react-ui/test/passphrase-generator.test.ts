import assert from "node:assert/strict";
import test from "node:test";
import { BIP39_ENGLISH_WORDS } from "../src/security/bip39-english.ts";
import { generateAcceptedPassphrase, randomPassphrase }
  from "../src/security/passphrase-generator.ts";

test("BIP-39 passphrases use eight independent lowercase words from the complete list", () => {
  assert.equal(BIP39_ENGLISH_WORDS.length, 2048);
  assert.equal(new Set(BIP39_ENGLISH_WORDS).size, 2048);
  const words = new Set(BIP39_ENGLISH_WORDS);
  const samples = new Set<string>();
  for (let sample = 0; sample < 32; ++sample) {
    const candidate = randomPassphrase();
    assert.match(candidate, /^[a-z]+(?: [a-z]+){7}$/);
    assert.ok(candidate.split(" ").every((word) => words.has(word)));
    samples.add(candidate);
  }
  assert.equal(samples.size, 32, "successive clicks draw new candidates");
});

test("generation retries rejected and duplicate candidates using the policy result", async () => {
  let calls = 0;
  const result = await generateAcceptedPassphrase(async (candidate) => {
    calls += 1;
    return calls === 1 ? { status: "rejected" }
      : { status: "accepted", password: candidate };
  });
  assert.equal(calls, 2);
  assert.match(result, /^[a-z]+(?: [a-z]+){7}$/);

  let unavailableCalls = 0;
  await assert.rejects(generateAcceptedPassphrase(async () => {
    unavailableCalls += 1;
    return { status: "unavailable" };
  }), /Could not generate/);
  assert.equal(unavailableCalls, 1);
});
