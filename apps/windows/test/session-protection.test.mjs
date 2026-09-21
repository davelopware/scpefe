import assert from "node:assert/strict";
import test from "node:test";
import { describeProtection, SessionProtectionCoordinator }
  from "../src/session-protection.mjs";

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
  await assert.rejects(policy.decide({ token: request.token, decision: "save" }),
    /publication unavailable/);
  current.service.saveDocument = originalSave;
  await policy.decide({ token: request.token, decision: "save" });
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
    async waitForPublications() { calls.push("wait"); } };
  let request;
  const policy = new SessionProtectionCoordinator({ getService: () => service,
    present: (value) => { request = value; } });
  const authorized = policy.authorize("exit");
  assert.equal(request.state.activePublication, true);
  await policy.decide({ token: request.token, decision: "save" });
  assert.equal(await authorized, true);
  assert.deepEqual(calls, ["wait"]);
});
