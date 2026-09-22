import assert from "node:assert/strict";
import test from "node:test";
import { ExternalOpenLifecycle } from "../src/external-open-lifecycle.mjs";
import { OrderedOpenRequests } from "../src/single-instance.mjs";

function fixture() {
  let number = 0;
  const requests = new OrderedOpenRequests({ randomToken: () => `request-${++number}` });
  const events = [];
  let lifecycle;
  const drain = () => {
    events.push("drain");
    const next = requests.take();
    if (next) events.push(`present:${next.token}`);
  };
  lifecycle = new ExternalOpenLifecycle({ requests,
    acknowledge: async (request, status, sequence) => {
      events.push(`ack:${request.token}:${status}:${sequence}`);
    },
    record: async (request, outcome) => events.push(`record:${request.token}:${outcome}`),
    drain });
  requests.setReady();
  return { requests, lifecycle, events };
}

test("invitation keeps the authenticated FIFO request active until claim succeeds", async () => {
  const { requests, lifecycle, events } = fixture();
  const first = requests.enqueue({ target: "invitation.scpefe", source: "second-instance" });
  const second = requests.enqueue({ target: "next.scpefe", source: "second-instance" });
  assert.equal(requests.take(), first);
  lifecycle.stageInvitation(first);

  // Wrong passwords and native claim failures do not invent a terminal outcome.
  assert.equal(lifecycle.current(first.token), first);
  assert.equal(requests.size, 2);
  assert.deepEqual(events, []);

  await lifecycle.finishInvitation("opened", "claim-opened");
  assert.deepEqual(events, [
    `ack:${first.token}:opened:3`, `record:${first.token}:claim-opened`,
    "drain", `present:${second.token}`,
  ]);
  assert.equal(lifecycle.current(second.token), second);
  assert.equal(lifecycle.invitation, null);
});

test("claim cancellation is terminal only after its authenticated acknowledgement", async () => {
  const { requests, lifecycle, events } = fixture();
  const request = requests.enqueue({ target: "invitation.scpefe", source: "open-file" });
  requests.take(); lifecycle.stageInvitation(request);
  await lifecycle.finishInvitation("canceled", "claim-canceled");
  assert.deepEqual(events, [
    `ack:${request.token}:canceled:3`, `record:${request.token}:claim-canceled`, "drain",
  ]);
  assert.equal(requests.size, 0);
});

test("renderer cancellation rejects stale, concurrent, and invitation request IDs", async () => {
  const { requests, lifecycle, events } = fixture();
  const request = requests.enqueue({ target: "one.scpefe", source: "open-url" });
  requests.take();
  await assert.rejects(() => lifecycle.cancel("forged"), /no longer cancelable/);
  await assert.rejects(() => lifecycle.cancel(request.token, { blocked: true }),
    /no longer cancelable/);
  assert.deepEqual(events, []);
  lifecycle.stageInvitation(request);
  await assert.rejects(() => lifecycle.cancel(request.token), /no longer cancelable/);
  await lifecycle.finishInvitation("failed", "claim-failed");
  assert.equal(events[0], `ack:${request.token}:failed:3`);
});

test("session lock terminally cancels an active invitation and advances FIFO", async () => {
  const { requests, lifecycle, events } = fixture();
  const first = requests.enqueue({ target: "invitation.scpefe", source: "second-instance" });
  const second = requests.enqueue({ target: "next.scpefe", source: "open-file" });
  requests.take(); lifecycle.stageInvitation(first);
  assert.equal(await lifecycle.cancelForLock(), true);
  assert.deepEqual(events, [
    `ack:${first.token}:canceled:3`, `record:${first.token}:session-locked`,
    "drain", `present:${second.token}`,
  ]);
  assert.equal(lifecycle.invitation, null);
  assert.equal(lifecycle.current(second.token), second);
});

test("exit terminally acknowledges active password, invitation, and queued requests in FIFO", async () => {
  const { requests, lifecycle, events } = fixture();
  const password = requests.enqueue({ target: "password.scpefe", source: "second-instance" });
  const invitation = requests.enqueue({ target: "invitation.scpefe", source: "open-file" });
  const focus = requests.enqueue({ source: "second-instance" });
  requests.take();
  await lifecycle.terminateAll("application-exit");
  assert.deepEqual(events, [
    `ack:${password.token}:canceled:3`, `record:${password.token}:application-exit`,
    `ack:${invitation.token}:canceled:3`, `record:${invitation.token}:application-exit`,
    `ack:${focus.token}:canceled:3`, `record:${focus.token}:application-exit`,
  ]);
  assert.equal(requests.size, 0);
});

test("exit acknowledgement fault preserves the active request for a successful retry", async () => {
  const requests = new OrderedOpenRequests({ randomToken: () => "request-1" });
  requests.setReady(); const request = requests.enqueue({ target: "password.scpefe",
    source: "second-instance" }); requests.take();
  let attempts = 0; const events = [];
  const lifecycle = new ExternalOpenLifecycle({ requests,
    acknowledge: async () => { attempts += 1;
      if (attempts === 1) throw new Error("ack store unavailable");
      events.push("terminal"); },
    record: async () => events.push("record"), drain: async () => events.push("drain") });
  await assert.rejects(lifecycle.terminateAll(), /ack store unavailable/);
  assert.equal(requests.current(request.token), request);
  await lifecycle.terminateAll();
  assert.deepEqual(events, ["terminal", "record"]);
  assert.equal(requests.size, 0);
});
