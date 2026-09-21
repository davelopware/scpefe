import assert from "node:assert/strict";
import test from "node:test";
import { completeOpenReplacement, createReplacement, disposeReplacement,
  stageOpenReplacement } from "../src/replacement-flow.mjs";

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
    async enterEditMode() { log.push("candidate:edit");
      return { content: "", readOnly: false, canEdit: true }; },
    async revalidateTargetForReplacement() { log.push("candidate:revalidate"); },
    async abandonCreatedDocument() { log.push("candidate:remove-created");
      this.active = null; },
    async lock(reason) { log.push(`candidate:lock:${reason}`); this.active = null; },
    ...overrides,
  };
}

test("open authenticates in isolation and revalidates only after authorization", async () => {
  const log = [];
  const current = { content: "original", dirty: true };
  const staged = await stageOpenReplacement({ makeCandidate: () => candidate(log),
    target: "opaque-target", password: "password words" });
  const result = await completeOpenReplacement({ staged,
    authorizeCurrent: async () => { log.push("current:authorize");
      assert.deepEqual(current, { content: "original", dirty: true }); return true; } });
  assert.deepEqual(log, ["candidate:settings",
    "candidate:open:opaque-target:password words", "current:authorize",
    "candidate:revalidate"]);
  assert.equal(result.opened.content, "replacement");
});

test("wrong passwords never ask the current session to authorize replacement", async () => {
  const log = [];
  await assert.rejects(stageOpenReplacement({ makeCandidate: () => candidate(log, {
    async openDocument() { log.push("candidate:wrong-password");
      throw new Error("wrong password"); },
  }), target: "opaque-target", password: "wrong" }), /wrong password/);
  assert.deepEqual(log, ["candidate:settings", "candidate:wrong-password"]);
});

test("a canceled authorization disposes the candidate and preserves current state", async () => {
  const log = [];
  const current = { content: "original", dirty: true };
  const staged = await stageOpenReplacement({ makeCandidate: () => candidate(log),
    target: "opaque-target", password: "password words" });
  await assert.rejects(completeOpenReplacement({ staged,
    authorizeCurrent: async () => false }), /current document remains open/);
  assert.deepEqual(current, { content: "original", dirty: true });
  assert.deepEqual(log.slice(-1), ["candidate:lock:replacement-canceled"]);
});

test("an authorization fault disposes the candidate and preserves current state", async () => {
  const log = [];
  const current = { content: "original", dirty: true };
  const staged = await stageOpenReplacement({ makeCandidate: () => candidate(log),
    target: "opaque-target", password: "password words" });
  await assert.rejects(completeOpenReplacement({ staged,
    authorizeCurrent: async () => { throw new Error("authorization failed"); } }),
  /authorization failed/);
  assert.deepEqual(current, { content: "original", dirty: true });
  assert.deepEqual(log.slice(-1), ["candidate:lock:replacement-canceled"]);
});

test("new authorizes before publication and revalidates its blank edit candidate", async () => {
  const log = [];
  const request = { ownerPassword: "owner password words", content: "" };
  const result = await createReplacement({ makeCandidate: () => candidate(log),
    target: "new-target", request,
    authorizeCurrent: async () => { log.push("current:authorize"); return true; } });
  assert.deepEqual(log, ["current:authorize", "candidate:settings",
    "candidate:create:new-target:", "candidate:open:new-target:owner password words",
    "candidate:edit", "candidate:revalidate"]);
  assert.deepEqual(result.opened, { content: "", readOnly: false, canEdit: true });
});

test("creation and edit failures remove the exact created target", async () => {
  const first = [];
  await assert.rejects(createReplacement({ makeCandidate: () => candidate(first, {
    async createDocument() { throw new Error("publication failure"); },
  }), target: "new-target", request: { ownerPassword: "owner", content: "" },
  authorizeCurrent: async () => true }), /publication failure/);
  assert.deepEqual(first.slice(-1), ["candidate:remove-created"]);
  const second = [];
  await assert.rejects(createReplacement({ makeCandidate: () => candidate(second, {
    async enterEditMode() { throw new Error("lease failure"); },
  }), target: "new-target", request: { ownerPassword: "owner", content: "" },
  authorizeCurrent: async () => true }), /lease failure/);
  assert.deepEqual(second.slice(-1), ["candidate:remove-created"]);
});

test("target mutation after authorization fails and disposes only the candidate", async () => {
  const log = [];
  const current = { content: "original" };
  const staged = await stageOpenReplacement({ makeCandidate: () => candidate(log, {
    async revalidateTargetForReplacement() { log.push("candidate:changed");
      throw new Error("selected target changed"); },
  }), target: "opaque-target", password: "password words" });
  await assert.rejects(completeOpenReplacement({ staged,
    authorizeCurrent: async () => true }), /target changed/);
  assert.deepEqual(current, { content: "original" });
  assert.deepEqual(log.slice(-2), ["candidate:changed", "candidate:lock:replacement-canceled"]);
});

test("staged invitation cancellation never touches the current session", async () => {
  const log = [];
  const current = { content: "original" };
  const staged = await stageOpenReplacement({ makeCandidate: () => candidate(log, {
    async openDocument(target) { this.active = { target };
      return { readOnly: true, invitationRequired: true }; },
  }), target: "invitation-target", password: "temporary password" });
  await disposeReplacement(staged);
  assert.deepEqual(current, { content: "original" });
  assert.deepEqual(log.slice(-1), ["candidate:lock:replacement-canceled"]);
});
