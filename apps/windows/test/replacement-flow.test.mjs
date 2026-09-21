import assert from "node:assert/strict";
import test from "node:test";
import { createReplacement, openReplacement } from "../src/replacement-flow.mjs";

function candidate(log, overrides = {}) {
  return {
    active: null,
    async loadClientSettings() { log.push("candidate:settings"); },
    async createDocument(target, request) {
      log.push(`candidate:create:${target}:${request.content}`);
    },
    async openDocument(target, password) {
      log.push(`candidate:open:${target}:${password}`);
      this.active = { target };
      return { content: "replacement", readOnly: true, canEdit: true };
    },
    async enterEditMode() {
      log.push("candidate:edit");
      return { content: "", readOnly: false, canEdit: true };
    },
    async lock(reason) { log.push(`candidate:lock:${reason}`); this.active = null; },
    ...overrides,
  };
}

test("open authenticates the isolated candidate before committing the current session",
  async () => {
    const log = [];
    const current = { content: "original", dirty: true };
    const result = await openReplacement({ makeCandidate: () => candidate(log),
      target: "opaque-target", password: "password words",
      commitCurrent: async () => {
        log.push("current:commit");
        assert.deepEqual(current, { content: "original", dirty: true });
        return true;
      } });
    assert.deepEqual(log, ["candidate:settings",
      "candidate:open:opaque-target:password words", "current:commit"]);
    assert.equal(result.opened.content, "replacement");
  });

test("wrong passwords and native open failures never ask the current session to switch",
  async () => {
    const log = [];
    let commits = 0;
    await assert.rejects(openReplacement({ makeCandidate: () => candidate(log, {
      async openDocument() { log.push("candidate:wrong-password");
        throw new Error("wrong password"); },
    }), target: "opaque-target", password: "wrong",
    commitCurrent: async () => { commits += 1; return true; } }), /wrong password/);
    assert.equal(commits, 0);
    assert.deepEqual(log, ["candidate:settings", "candidate:wrong-password"]);
  });

test("a canceled switch disposes the candidate and preserves current state", async () => {
  const log = [];
  const current = { content: "original", dirty: true };
  await assert.rejects(openReplacement({ makeCandidate: () => candidate(log),
    target: "opaque-target", password: "password words",
    commitCurrent: async () => false }), /current document remains open/);
  assert.deepEqual(current, { content: "original", dirty: true });
  assert.deepEqual(log.slice(-1), ["candidate:lock:replacement-failed"]);
});

test("new publishes a blank candidate and enters edit mode before switching", async () => {
  const log = [];
  const request = { ownerPassword: "owner password words", content: "" };
  const result = await createReplacement({ makeCandidate: () => candidate(log),
    target: "new-target", request,
    commitCurrent: async () => { log.push("current:commit"); return true; } });
  assert.deepEqual(log, ["candidate:settings", "candidate:create:new-target:",
    "candidate:open:new-target:owner password words", "candidate:edit", "current:commit"]);
  assert.deepEqual(result.opened, { content: "", readOnly: false, canEdit: true });
});

test("creation and edit failures do not commit or replace the current session", async () => {
  let commits = 0;
  await assert.rejects(createReplacement({ makeCandidate: () => candidate([], {
    async createDocument() { throw new Error("publication failure"); },
  }), target: "new-target", request: { ownerPassword: "owner", content: "" },
  commitCurrent: async () => { commits += 1; return true; } }), /publication failure/);
  await assert.rejects(createReplacement({ makeCandidate: () => candidate([], {
    async enterEditMode() { throw new Error("lease failure"); },
  }), target: "new-target", request: { ownerPassword: "owner", content: "" },
  commitCurrent: async () => { commits += 1; return true; } }), /lease failure/);
  assert.equal(commits, 0);
});
