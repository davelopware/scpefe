import assert from "node:assert/strict";
import test from "node:test";
import { DocumentLifecycleHost } from "../src/document-lifecycle-host.mjs";

function fixture() {
  const handlers = new Map();
  const events = [];
  const timers = new Map();
  let nextTimer = 0;
  const service = {
    active: null, inactivityMs: 120_000,
    setTimer(callback, delay) { assert.equal(delay, 120_000);
      const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimer(id) { timers.delete(id); },
    loadClientSettings: async () => ({}),
    unresolvedJournalSummary: async () => ({}),
    notifyActivity() { events.push("service-activity"); return { tracked: true }; },
    runLifecycleBarrier: (operation) => operation(),
    lock: async (reason) => ({ locked: true, journalSaved: true, warningCode: null, reason }),
  };
  const host = new DocumentLifecycleHost({
    ipc: { handle: (name, handler) => handlers.set(name, handler) },
    window: { on() {}, webContents: { send: (name) => events.push(name) } },
    serviceFactory: () => service,
    picker: { chooseCreateTarget: async () => "new.scpefe",
      chooseOpenTarget: async () => "old.scpefe" },
  });
  return { host, handlers, events, timers, service };
}

test("new and open password entry time out without an active document", async () => {
  for (const channel of ["document:choose-create-target", "document:choose-open-target"]) {
    const { host, handlers, events, timers } = fixture();
    await host.start();
    assert.equal(timers.size, 0, "the empty shell has no password workflow to protect");
    await handlers.get(channel)();
    host.notifyActivity();
    assert.equal(events.includes("document:locked"), false);
    assert.equal(timers.size, 1);
    const timeout = [...timers.values()][0];
    timeout();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.includes("document:locked"), true);
  }
});

test("focus-style activity restarts the inactive countdown and delegates to an active session", async () => {
  const { host, handlers, events, timers, service } = fixture();
  await host.start();
  await handlers.get("document:choose-create-target")();
  const oldTimeout = [...timers.values()][0];
  host.notifyActivity();
  assert.equal(timers.size, 1);
  assert.notEqual([...timers.values()][0], oldTimeout);
  service.active = { target: "opened.scpefe" };
  host.notifyActivity();
  assert.equal(timers.size, 0);
  assert.deepEqual(events.filter((event) => event === "service-activity"),
    ["service-activity"]);
});

test("canceling a password dialog disarms the no-document countdown", async () => {
  for (const [choose, cancel] of [
    ["document:choose-create-target", "document:cancel-create-target"],
    ["document:choose-open-target", "document:cancel-open-target"],
  ]) {
    const { host, handlers, timers } = fixture();
    await host.start();
    await handlers.get(choose)();
    assert.equal(timers.size, 1);
    await handlers.get(cancel)();
    assert.equal(timers.size, 0);
  }
});

test("an external password request starts a countdown from the idle empty shell", async () => {
  const { host, events, timers } = fixture();
  await host.start();
  assert.equal(timers.size, 0);
  await host.setReady();
  host.enqueueExternal({ target: "old.scpefe", source: "second-instance" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes("document:external-open-requested"), true);
  assert.equal(timers.size, 1);
});
