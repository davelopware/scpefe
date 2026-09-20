import assert from "node:assert/strict";
import test from "node:test";
import { applyCloseDecision, needsCloseDecision } from "../src/close-document.mjs";

function recoveredService() {
  const calls = [];
  const service = {
    active: { editMode: false, dirty: false, manuallySealed: false,
      recovery: { text: "provisional" }, pendingPublication: false },
    async restoreRecoveredWork() {
      calls.push("restore");
      this.active.recovery = null;
      this.active.editMode = true;
      this.active.working = { content: "provisional" };
    },
    async saveDocument(content) { calls.push(`save:${content}`); },
    async discardRecoveredWork() { calls.push("discard-recovery"); },
  };
  return { service, calls };
}

test("read-only provisional recovery surfaces and applies every close choice", async () => {
  const canceled = recoveredService();
  assert.equal(needsCloseDecision(canceled.service.active), true);
  assert.equal(await applyCloseDecision(canceled.service, "cancel"), false);
  assert.deepEqual(canceled.calls, []);

  const saved = recoveredService();
  assert.equal(await applyCloseDecision(saved.service, "save"), true);
  assert.deepEqual(saved.calls, ["restore", "save:provisional"]);

  const discarded = recoveredService();
  assert.equal(await applyCloseDecision(discarded.service, "discard"), true);
  assert.deepEqual(discarded.calls, ["discard-recovery"]);
});

test("regular-save pending close revalidates before manual sealing", async () => {
  const calls = [];
  const service = { active: { editMode: false, dirty: false, manuallySealed: true,
    recovery: null, pendingPublication: true, pendingRecord: {
      publication: { purpose: "regular-save" },
    } },
  async reconnectPendingPublication() {
    calls.push("reconnect");
    this.active.pendingPublication = false;
    return { publicationState: "conflict" };
  } };
  assert.equal(needsCloseDecision(service.active), true);
  await assert.rejects(applyCloseDecision(service, "save"), /Resolve the saved divergence/);
  assert.deepEqual(calls, ["reconnect"]);
});
