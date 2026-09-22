import assert from "node:assert/strict";
import test from "node:test";
import { LeaseTakeoverAuthorizations,
  runLeaseOperation } from "../src/lease-takeover.mjs";

const ids = ["123e4567-e89b-42d3-a456-426614174000",
  "223e4567-e89b-42d3-a456-426614174000"];

function uncertain(token) {
  const error = new Error("future lease");
  error.code = "LEASE_CLOCK_UNCERTAIN";
  error.lease = { holderName: "Remote editor" };
  error.takeoverToken = token;
  return error;
}

test("opaque authorizations bind operation and service and are one-shot", async () => {
  const canceled = [];
  const service = { cancelLeaseTakeover(token) { canceled.push(token); return true; } };
  const otherService = { cancelLeaseTakeover(token) { canceled.push(token); return true; } };
  const token = Object.freeze({ native: true });
  const authorizations = new LeaseTakeoverAuthorizations({ createId: () => ids[0] });
  const decision = await runLeaseOperation({ authorizations, operation: "edit", service,
    perform: async () => { throw uncertain(token); } });
  assert.deepEqual(decision, { decisionRequired: "lease-takeover", operation: "edit",
    holderName: "Remote editor", authorization: ids[0] });
  assert.equal("takeoverToken" in decision, false);
  assert.throws(() => authorizations.consume("recovery", ids[0], service),
    /No matching lease takeover/);
  assert.deepEqual(canceled, [token]);
  assert.throws(() => authorizations.consume("edit", ids[0], service),
    /No matching lease takeover/);

  const second = new LeaseTakeoverAuthorizations({ createId: () => ids[1] });
  second.stage("edit", service, uncertain(token));
  assert.throws(() => second.consume("edit", ids[1], otherService),
    /No matching lease takeover/);
  assert.equal(canceled.length, 2);
});

test("cancellation clears native authority and cannot be replayed", () => {
  const token = Object.freeze({});
  let cancellations = 0;
  const service = { cancelLeaseTakeover(candidate) {
    assert.equal(candidate, token); cancellations += 1; return true;
  } };
  const authorizations = new LeaseTakeoverAuthorizations({ createId: () => ids[0] });
  authorizations.stage("recovery", service, uncertain(token));
  assert.equal(authorizations.cancel(ids[0], service), true);
  assert.equal(authorizations.cancel(ids[0], service), false);
  assert.equal(cancellations, 1);
  assert.throws(() => authorizations.consume("recovery", ids[0], service),
    /No matching lease takeover/);
});

test("changed lease evidence is re-observed and yields a fresh one-shot decision", async () => {
  const nativeTokens = [Object.freeze({ sequence: 1 }), Object.freeze({ sequence: 2 })];
  let idIndex = 0;
  const service = { cancelLeaseTakeover() { return true; } };
  const authorizations = new LeaseTakeoverAuthorizations({
    createId: () => ids[idIndex++],
  });
  let observation = 0;
  const perform = async (token) => {
    if (token === nativeTokens[0]) {
      const changed = new Error("lease changed"); changed.code = "LEASE_CHANGED";
      throw changed;
    }
    if (token === nativeTokens[1]) return { readOnly: false };
    throw uncertain(nativeTokens[observation++]);
  };
  const first = await runLeaseOperation({ authorizations, operation: "edit", service,
    perform });
  const refreshed = await runLeaseOperation({ authorizations, operation: "edit", service,
    authorization: first.authorization, perform });
  assert.equal(refreshed.authorization, ids[1]);
  assert.notEqual(refreshed.authorization, first.authorization);
  assert.deepEqual(await runLeaseOperation({ authorizations, operation: "edit", service,
    authorization: refreshed.authorization, perform }), { readOnly: false });
  await assert.rejects(runLeaseOperation({ authorizations, operation: "edit", service,
    authorization: refreshed.authorization, perform }), /No matching lease takeover/);
});

test("post-confirmation faults consume authority and fresh retry cannot replay it", async () => {
  const nativeTokens = [Object.freeze({ sequence: 1 }), Object.freeze({ sequence: 2 })];
  let idIndex = 0;
  let observation = 0;
  const service = { cancelLeaseTakeover() { return true; } };
  const authorizations = new LeaseTakeoverAuthorizations({
    createId: () => ids[idIndex++],
  });
  const stage = async () => runLeaseOperation({ authorizations, operation: "recovery",
    service, perform: async () => { throw uncertain(nativeTokens[observation++]); } });
  const first = await stage();
  await assert.rejects(runLeaseOperation({ authorizations, operation: "recovery", service,
    authorization: first.authorization,
    perform: async () => { throw new Error("post-confirmation journal fault"); } }),
  /post-confirmation journal fault/);
  await assert.rejects(runLeaseOperation({ authorizations, operation: "recovery", service,
    authorization: first.authorization, perform: async () => ({ restored: true }) }),
  /No matching lease takeover/);

  const fresh = await stage();
  assert.notEqual(fresh.authorization, first.authorization);
  assert.deepEqual(await runLeaseOperation({ authorizations, operation: "recovery", service,
    authorization: fresh.authorization,
    perform: async (token) => {
      assert.equal(token, nativeTokens[1]); return { restored: true };
    } }), { restored: true });
});
