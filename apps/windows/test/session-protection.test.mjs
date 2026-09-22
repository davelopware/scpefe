import assert from "node:assert/strict";
import test from "node:test";
import { describeProtection, SessionProtectionCoordinator }
  from "../src/session-protection.mjs";
import { LifecycleBarrier } from "../src/lifecycle-barrier.mjs";
import { SessionGeneration } from "../src/session-generation.mjs";

function serviceFor(state = {}) {
  const calls = [];
  const service = { active: { editMode: true, dirty: true, manuallySealed: true,
    working: { content: "working" },
    recovery: null, pendingPublication: false, unresolvedJournal: false, ...state },
  async saveDocument() { calls.push("save"); this.active.dirty = false; },
  async enterEditMode() { calls.push("edit"); this.active.editMode = true; },
  async restoreRecoveredWork() { calls.push("restore"); this.active.recovery = null;
    this.active.editMode = true; this.active.working = { content: "recovered" }; },
  async discardUnsavedForClose() { calls.push("discard"); this.active.dirty = false;
    this.active.recovery = null; this.active.manuallySealed = true;
    this.active.pendingPublication = false; this.active.unresolvedJournal = false; },
  async reconnectPendingPublication() { calls.push("retry");
    this.active.pendingPublication = false; return { publicationState: "target-published" }; } };
  return { service, calls };
}

test("describes every protected domain state without treating clean sessions as dirty", () => {
  assert.equal(describeProtection({ dirty: false, manuallySealed: true }), null);
  assert.deepEqual(describeProtection({ dirty: true, manuallySealed: false,
    recovery: {}, pendingPublication: true, unresolvedJournal: true,
    pendingRecord: { state: "conflict", publication: { purpose: "regular-save" } } }), {
    dirty: true, provisional: true, pendingPublication: true, recovered: true,
    conflict: true, unresolvedJournal: true,
    activePublication: false,
  });
  assert.equal(describeProtection({ dirty: false, manuallySealed: true }, true)
    .activePublication, true);
});

test("clean, dirty, provisional, publication, recovery, and conflict states classify distinctly", () => {
  const base = { dirty: false, manuallySealed: true, pendingPublication: false,
    recovery: null, unresolvedJournal: false };
  const cases = [
    ["clean", base, null],
    ["dirty", { ...base, dirty: true }, "dirty"],
    ["provisional", { ...base, manuallySealed: false }, "provisional"],
    ["pending publication", { ...base, pendingPublication: true,
      pendingRecord: { state: "pending", publication: { purpose: "manual-save" } } },
    "pendingPublication"],
    ["recovered", { ...base, recovery: { content: "recovered" } }, "recovered"],
    ["conflict", { ...base, pendingPublication: true,
      pendingRecord: { state: "conflict", publication: { purpose: "manual-save" } } },
    "conflict"],
    ["unreadable journal", { ...base, unresolvedJournal: true,
      unreadableJournal: true }, "unresolvedJournal"],
    ["regular provisional", { ...base, pendingPublication: true,
      pendingRecord: { state: "pending", publication: { purpose: "regular-save" } } },
    "provisional"],
  ];
  for (const [name, active, expected] of cases) {
    const described = describeProtection(active);
    if (expected === null) assert.equal(described, null, name);
    else assert.equal(described[expected], true, name);
  }
});

test("all lifecycle operations proceed immediately for no-document and clean read-only states", async () => {
  for (const active of [null, { editMode: false, dirty: false, manuallySealed: true }]) {
    const service = { active, hasActivePublication: () => false };
    let presentations = 0;
    const policy = new SessionProtectionCoordinator({ getService: () => service,
      present: () => { presentations += 1; } });
    for (const operation of ["new", "open", "external-open", "close", "exit"]) {
      assert.equal(await policy.authorize(operation), true);
    }
    assert.equal(presentations, 0);
  }
});

test("clean-session operations are claimed synchronously and concurrent destruction is rejected", async () => {
  let release; const events = [];
  const service = { active: { editMode: false, dirty: false, manuallySealed: true },
    hasActivePublication: () => false,
    runLifecycleBarrier: (operation) => operation() };
  const policy = new SessionProtectionCoordinator({ getService: () => service,
    present: () => assert.fail("clean state must not prompt") });
  const first = policy.authorize("open", async () => {
    events.push("first"); await new Promise((resolve) => { release = resolve; });
  });
  await assert.rejects(policy.authorize("close", async () => events.push("second")),
    /already in progress/);
  release(); assert.equal(await first, true);
  assert.deepEqual(events, ["first"]);
});

test("auto-lock cancels a clean replacement queued behind maintenance", async () => {
  const barrier = new LifecycleBarrier(); let releaseMaintenance;
  const service = { active: { editMode: false, dirty: false, manuallySealed: true },
    hasActivePublication: () => barrier.hasMaintenance,
    runLifecycleBarrier: (operation) => barrier.runExclusive(operation) };
  const maintenance = barrier.runMaintenance(() => new Promise((resolve) => {
    releaseMaintenance = resolve;
  }));
  await new Promise((resolve) => setImmediate(resolve));
  let committed = false;
  const policy = new SessionProtectionCoordinator({ getService: () => service,
    present: () => assert.fail("clean state must not prompt") });
  // Maintenance makes this a presented decision; model its completion before authorizing clean work.
  releaseMaintenance(); await maintenance;
  const blocker = barrier.runMaintenance(() => new Promise((resolve) => {
    releaseMaintenance = resolve;
  }));
  await new Promise((resolve) => setImmediate(resolve));
  service.hasActivePublication = () => false;
  const replacement = policy.authorize("open", async () => { committed = true; });
  const rejected = assert.rejects(replacement, /locked/);
  assert.equal(policy.cancelForLock(), true);
  releaseMaintenance(); await blocker; await rejected;
  assert.equal(committed, false);
});

test("all lifecycle operations use one captured-session decision and remain retryable", async () => {
  for (const operation of ["new", "open", "external-open", "close", "exit"]) {
    const current = serviceFor();
    let request;
    const policy = new SessionProtectionCoordinator({ getService: () => current.service,
      present: (value) => { request = value; } });
    const authorized = policy.authorize(operation);
    assert.equal(request.operation, operation);
    const result = await policy.decide({ token: request.token, decision: "save" });
    assert.deepEqual(result, { completed: true, proceed: true });
    assert.equal(await authorized, true);
    assert.deepEqual(current.calls, ["save"]);
  }
});

test("cancel changes nothing, stale decisions fail closed, and failures can retry", async () => {
  const current = serviceFor();
  let request;
  const policy = new SessionProtectionCoordinator({ getService: () => current.service,
    present: (value) => { request = value; } });
  const canceled = policy.authorize("open");
  assert.deepEqual(await policy.decide({ token: request.token, decision: "cancel" }),
    { completed: true, proceed: false });
  assert.equal(await canceled, false); assert.deepEqual(current.calls, []);

  current.service.active.dirty = true;
  const failed = policy.authorize("exit");
  const originalSave = current.service.saveDocument;
  current.service.saveDocument = async () => { throw new Error("publication unavailable"); };
  const firstFailure = await policy.decide({ token: request.token, decision: "save" });
  assert.equal(firstFailure.completed, false);
  assert.match(firstFailure.error, /publication unavailable/);
  await assert.rejects(policy.decide({ token: request.token, decision: "save" }),
    /no longer active/);
  current.service.saveDocument = originalSave;
  await policy.decide({ token: firstFailure.retryToken, decision: "save" });
  assert.equal(await failed, true);

  current.service.active.dirty = true;
  const raced = policy.authorize("close");
  current.service.active = { ...current.service.active };
  await assert.rejects(policy.decide({ token: request.token, decision: "discard" }),
    /document changed/);
  await assert.rejects(raced, /document changed/);
});

test("lock rejects an outstanding operation without applying destructive choices", async () => {
  const current = serviceFor({ recovery: { content: "recover me" } });
  let request;
  const policy = new SessionProtectionCoordinator({ getService: () => current.service,
    present: (value) => { request = value; } });
  const pending = policy.authorize("new");
  assert.equal(typeof request.token, "string");
  assert.equal(policy.cancelForLock(), true);
  await assert.rejects(pending, /locked/);
  assert.deepEqual(current.calls, []);
});

test("an active publication finishes before a clean session can be abandoned", async () => {
  const calls = [];
  const service = { active: { dirty: false, manuallySealed: true },
    hasActivePublication: () => true,
    async runLifecycleBarrier(operation) { calls.push("barrier"); return operation(); } };
  let request;
  const policy = new SessionProtectionCoordinator({ getService: () => service,
    present: (value) => { request = value; } });
  const authorized = policy.authorize("exit");
  assert.equal(request.state.activePublication, true);
  await policy.decide({ token: request.token, decision: "save" });
  assert.equal(await authorized, true);
  assert.deepEqual(calls, ["barrier"]);
});

test("a decision token is consumed before awaiting and concurrent replay is rejected", async () => {
  const current = serviceFor();
  let request; let release;
  current.service.runLifecycleBarrier = async (operation) => {
    await new Promise((resolve) => { release = resolve; });
    return operation();
  };
  const policy = new SessionProtectionCoordinator({ getService: () => current.service,
    present: (value) => { request = value; } });
  const authorized = policy.authorize("close");
  const first = policy.decide({ token: request.token, decision: "save" });
  await assert.rejects(policy.decide({ token: request.token, decision: "discard" }),
    /no longer active/);
  release();
  assert.deepEqual(await first, { completed: true, proceed: true });
  assert.equal(await authorized, true);
  assert.deepEqual(current.calls, ["save"]);
  await assert.rejects(policy.decide({ token: request.token, decision: "save" }),
    /no longer active/);
});

test("auto-lock aborts an in-flight decision behind maintenance without abandoning plaintext", async () => {
  const current = serviceFor({ recovery: { content: "recover me" } });
  const barrier = new LifecycleBarrier(); let request; let releaseMaintenance;
  current.service.runLifecycleBarrier = (operation) => barrier.runExclusive(operation);
  const maintenance = barrier.runMaintenance(() => new Promise((resolve) => {
    releaseMaintenance = resolve;
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const policy = new SessionProtectionCoordinator({ getService: () => current.service,
    present: (value) => { request = value; } });
  const authorized = policy.authorize("external-open", async () => {
    current.calls.push("replace");
  });
  const decision = policy.decide({ token: request.token, decision: "discard" });
  const decisionRejected = assert.rejects(decision, /locked/);
  const authorizationRejected = assert.rejects(authorized, /locked/);
  assert.equal(policy.cancelForLock(), true);
  releaseMaintenance(); await maintenance;
  await decisionRejected;
  await authorizationRejected;
  assert.deepEqual(current.calls, []);
});

test("a lifecycle commit excludes maintenance queued after authorization", async () => {
  const current = serviceFor(); const barrier = new LifecycleBarrier();
  const events = []; let request; let releaseCommit;
  current.service.runLifecycleBarrier = (operation) => barrier.runExclusive(operation);
  const policy = new SessionProtectionCoordinator({ getService: () => current.service,
    present: (value) => { request = value; } });
  const authorized = policy.authorize("open", async () => {
    events.push("commit-start");
    await new Promise((resolve) => { releaseCommit = resolve; });
    events.push("commit-end");
  });
  const decision = policy.decide({ token: request.token, decision: "save" });
  await new Promise((resolve) => setImmediate(resolve));
  const maintenance = barrier.runMaintenance(async () => { events.push("maintenance"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["commit-start"]);
  releaseCommit();
  await Promise.all([decision, authorized, maintenance]);
  assert.deepEqual(events, ["commit-start", "commit-end", "maintenance"]);
});

test("generation invalidation during a non-cancellable commit never authorizes its result", async () => {
  const current = serviceFor(); const generation = new SessionGeneration();
  let request; let releaseCommit; let commitFinished = false;
  const policy = new SessionProtectionCoordinator({ getService: () => current.service,
    generation, present: (value) => { request = value; } });
  const authorized = policy.authorize("open", async () => {
    await new Promise((resolve) => { releaseCommit = resolve; });
    commitFinished = true;
  });
  const decision = policy.decide({ token: request.token, decision: "save" });
  const decisionRejected = assert.rejects(decision, /session locked/);
  const authorizationRejected = assert.rejects(authorized, /session locked/);
  await new Promise((resolve) => setImmediate(resolve));
  generation.invalidate(); policy.cancelForLock(); releaseCommit();
  await decisionRejected; await authorizationRejected;
  assert.equal(commitFinished, true, "backend completion is fenced rather than reported as authorized");
});

test("null and clean originals fence late replacement results and remain reusable", async () => {
  for (const active of [null, { editMode: false, dirty: false, manuallySealed: true }]) {
    const generation = new SessionGeneration(); let release; let committed = 0;
    const service = { active, hasActivePublication: () => false,
      runLifecycleBarrier: (operation) => operation() };
    const policy = new SessionProtectionCoordinator({ getService: () => service,
      generation, present: () => assert.fail("clean state must not prompt") });
    const first = policy.authorize("open", async () => {
      await new Promise((resolve) => { release = resolve; }); committed += 1;
    });
    const rejected = assert.rejects(first, /session locked/);
    await new Promise((resolve) => setImmediate(resolve));
    generation.invalidate(); policy.cancelForLock(); release(); await rejected;
    assert.equal(committed, 1);
    assert.equal(await policy.authorize("open", async () => { committed += 1; }), true);
    assert.equal(committed, 2);
  }
});
