import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentWithTarget } from "../src/creation-flow.mjs";

const request = Object.freeze({
  ownerPassword: "owner password words",
  ownerPasswordConfirmation: "owner password words",
  recoveryPassword: "different recovery words",
  recoveryPasswordConfirmation: "different recovery words",
  content: "hello",
  understandsIrrecoverable: true,
  storedRecoverySeparately: true,
});

test("matching creation secrets reach the picker and native-backed service", async () => {
  let pickerCalls = 0;
  let creationCalls = 0;
  const result = await createDocumentWithTarget(request, async () => {
    pickerCalls += 1;
    return "opaque-target";
  }, async (target, validated) => {
    creationCalls += 1;
    assert.equal(target, "opaque-target");
    assert.deepEqual(validated, {
      ownerPassword: request.ownerPassword,
      recoveryPassword: request.recoveryPassword,
      content: "hello", understandsIrrecoverable: true,
      storedRecoverySeparately: true,
    });
    assert.equal("ownerPasswordConfirmation" in validated, false);
    assert.equal("recoveryPasswordConfirmation" in validated, false);
    return { created: true };
  });
  assert.deepEqual(result, { created: true });
  assert.equal(pickerCalls, 1);
  assert.equal(creationCalls, 1);
});

test("owner or recovery mismatch reaches neither picker nor native-backed service",
  async () => {
    let pickerCalls = 0;
    let creationCalls = 0;
    const chooseTarget = async () => { pickerCalls += 1; return "opaque-target"; };
    const createDocument = async () => { creationCalls += 1; return { created: true }; };
    await assert.rejects(createDocumentWithTarget({ ...request,
      ownerPasswordConfirmation: "owner mismatch words" }, chooseTarget,
    createDocument), /owner passwords do not match/);
    await assert.rejects(createDocumentWithTarget({ ...request,
      recoveryPasswordConfirmation: "recovery mismatch words" }, chooseTarget,
    createDocument), /recovery passwords do not match/);
    assert.equal(pickerCalls, 0);
    assert.equal(creationCalls, 0);
  });

test("both empty recovery fields omit the optional recovery slot", async () => {
  let received;
  await createDocumentWithTarget({ ...request, recoveryPassword: "",
    recoveryPasswordConfirmation: "", storedRecoverySeparately: false },
  async () => "opaque-target", async (_target, validated) => {
    received = validated;
    return { created: true };
  });
  assert.equal(received.recoveryPassword, null);
  assert.equal(received.storedRecoverySeparately, false);
});
