import assert from "node:assert/strict";
import test from "node:test";
import { CreationTargetFlow } from "../src/creation-flow.mjs";

const request = Object.freeze({
  ownerPassword: "owner password words",
  ownerPasswordConfirmation: "owner password words",
  recoveryPassword: "different recovery words",
  recoveryPasswordConfirmation: "different recovery words",
  content: "",
  understandsIrrecoverable: true,
  storedRecoverySeparately: true,
});

test("the picker runs before matching secrets reach the native-backed service", async () => {
  const flow = new CreationTargetFlow();
  let pickerCalls = 0;
  let creationCalls = 0;
  assert.deepEqual(await flow.chooseTarget(async () => {
    pickerCalls += 1;
    return "opaque-target";
  }), { selected: true });
  assert.equal(creationCalls, 0);
  const result = await flow.create(request, async (target, validated) => {
    creationCalls += 1;
    assert.equal(target, "opaque-target");
    assert.deepEqual(validated, {
      ownerPassword: request.ownerPassword,
      recoveryPassword: request.recoveryPassword,
      content: "", understandsIrrecoverable: true,
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

test("owner or recovery mismatch occurs after the picker and reaches no native service",
  async () => {
    const flow = new CreationTargetFlow();
    let pickerCalls = 0;
    let creationCalls = 0;
    const chooseTarget = async () => { pickerCalls += 1; return "opaque-target"; };
    const createDocument = async () => { creationCalls += 1; return { created: true }; };
    await flow.chooseTarget(chooseTarget);
    await assert.rejects(flow.create({ ...request,
      ownerPasswordConfirmation: "owner mismatch words" }, createDocument),
    /owner passwords do not match/);
    await assert.rejects(flow.create({ ...request,
      recoveryPasswordConfirmation: "recovery mismatch words" }, createDocument),
    /recovery passwords do not match/);
    assert.equal(pickerCalls, 1);
    assert.equal(creationCalls, 0);
  });

test("both empty recovery fields omit the optional recovery slot", async () => {
  const flow = new CreationTargetFlow();
  let received;
  await flow.chooseTarget(async () => "opaque-target");
  await flow.create({ ...request, recoveryPassword: "",
    recoveryPasswordConfirmation: "", storedRecoverySeparately: false },
  async (_target, validated) => {
    received = validated;
    return { created: true };
  });
  assert.equal(received.recoveryPassword, null);
  assert.equal(received.storedRecoverySeparately, false);
});

test("picker and dialog cancellation create nothing and forget the host target", async () => {
  const flow = new CreationTargetFlow();
  let creationCalls = 0;
  assert.equal(await flow.chooseTarget(async () => null), null);
  await assert.rejects(flow.create(request, async () => {
    creationCalls += 1;
  }), /Choose a target/);
  await flow.chooseTarget(async () => "opaque-target");
  flow.cancel();
  await assert.rejects(flow.create(request, async () => {
    creationCalls += 1;
  }), /Choose a target/);
  assert.equal(creationCalls, 0);
});

test("creation failure retains the selected target for a recoverable retry", async () => {
  const flow = new CreationTargetFlow();
  let calls = 0;
  await flow.chooseTarget(async () => "opaque-target");
  await assert.rejects(flow.create(request, async () => {
    calls += 1;
    throw new Error("publication failed");
  }), /publication failed/);
  assert.deepEqual(await flow.create(request, async (target) => {
    calls += 1;
    assert.equal(target, "opaque-target");
    return { created: true };
  }), { created: true });
  assert.equal(calls, 2);
  await assert.rejects(flow.create(request, async () => ({ created: true })),
    /Choose a target/);
});
