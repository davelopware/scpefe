import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DocumentService } from "../src/document-service.mjs";
import { ReplacementCoordinator } from "../src/replacement-coordinator.mjs";
import { SessionGeneration } from "../src/session-generation.mjs";

const publicationCapabilities = Object.freeze({ sameFilesystemTransaction: true,
  replacementGuarantee: "atomic-replace" });

async function realInvitationCandidate(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-replacement-invite-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "invitation.scpefe");
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(profilePath, JSON.stringify({ name: "Grace",
    email: "grace@example.test", deviceName: "Private PC" }));
  await fs.writeFile(target, "invited");
  const temporary = "temporary invitation password";
  const replacement = "private replacement password";
  const documentId = "31".repeat(16);
  const oldHead = "42".repeat(32);
  const claimedHead = "43".repeat(32);
  const journalKey = Buffer.alloc(32, 7);
  const native = {
    openDocument(bytes, password) {
      if (bytes.toString() === "invited" && password === temporary) {
        return { content: "", readOnly: true, canEdit: false,
          canAddPasswords: false, mustBeChanged: true, manuallySealed: true,
          documentId, baseRevision: oldHead,
          revisionGraph: [{ revisionId: oldHead, parentRevisionIds: [] }],
          journalKey: Buffer.from(journalKey) };
      }
      if (bytes.toString() === "claimed" && password === replacement) {
        return { content: "claimed plaintext", readOnly: true, canEdit: true,
          canAddPasswords: false, mustBeChanged: false, manuallySealed: true,
          slotIdentityName: "Grace", slotIdentityEmail: "grace@example.test",
          documentId, baseRevision: claimedHead,
          revisionGraph: [{ revisionId: oldHead, parentRevisionIds: [] },
            { revisionId: claimedHead, parentRevisionIds: [oldHead] }],
          journalKey: Buffer.from(journalKey) };
      }
      throw new Error("authentication failed");
    },
    claimInvitation(bytes, password, request) {
      assert.equal(bytes.toString(), "invited");
      assert.equal(password, temporary);
      assert.equal(request.newPassword, replacement);
      return Buffer.from("claimed");
    },
  };
  const candidate = new DocumentService({ native, fs, profilePath,
    publicationCapabilities, journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses") });
  return { candidate, target, temporary, replacement, documentId, claimedHead,
    journalKey };
}

function invitationCandidate({ claimFails = false, cancelFailsOnce = false } = {}) {
  let lockAttempts = 0;
  return { active: null,
    async loadClientSettings() {},
    async openDocument(target) { this.active = { target };
      return { readOnly: true, invitationRequired: true }; },
    async claimInvitation() {
      if (claimFails) throw new Error("claim publication failed");
      return { content: "claimed", readOnly: true, canEdit: true,
        publicationState: "target-published" };
    },
    async revalidateTargetForReplacement() {},
    async lock() {
      lockAttempts += 1;
      if (cancelFailsOnce && lockAttempts === 1) throw new Error("cancel cleanup failed");
      this.active = null;
    },
  };
}

test("invitation open, failed claim, and cancellation retain the authoritative session",
  async () => {
    const original = { id: "original", content: "original plaintext" };
    let authoritative = original;
    const coordinator = new ReplacementCoordinator({
      makeCandidate: () => invitationCandidate({ claimFails: true }),
      authorizeCurrent: async (_operation, commit) => { await commit(); return true; },
      adopt: (staged) => { authoritative = staged.candidate; },
    });
    assert.deepEqual(await coordinator.open("invitation.scpefe", "temporary password"),
      { readOnly: true, invitationRequired: true });
    assert.equal(authoritative, original);
    await assert.rejects(coordinator.claim("replacement password"),
      /claim publication failed/);
    assert.equal(authoritative, original);
    assert.equal(await coordinator.cancelClaim(), true);
    assert.equal(authoritative, original);
  });

test("real invitation claim refreshes its authenticated baseline before adoption",
  async (t) => {
  const log = [];
  let authoritative = { id: "original" };
  const fixture = await realInvitationCandidate(t);
  const { candidate } = fixture;
  const revalidate = candidate.revalidateTargetForReplacement.bind(candidate);
  candidate.revalidateTargetForReplacement = async () => {
    log.push("revalidate");
    return revalidate();
  };
  const coordinator = new ReplacementCoordinator({ makeCandidate: () => candidate,
    authorizeCurrent: async (_operation, commit) => { await commit(); return true; },
    adopt: (staged) => { log.push("adopt"); authoritative = staged.candidate; } });
  await coordinator.open(fixture.target, fixture.temporary);
  const opened = await coordinator.claim(fixture.replacement);
  assert.deepEqual(log, ["revalidate", "adopt"]);
  assert.equal(authoritative, candidate);
  assert.equal(opened.content, "claimed plaintext");
  assert.equal(candidate.active.password, fixture.replacement);
  assert.equal(candidate.active.documentId, fixture.documentId);
  assert.equal(candidate.active.baseRevision, fixture.claimedHead);
  assert.equal(candidate.active.observation.headRevision, fixture.claimedHead);
  assert.equal(candidate.active.baseContainer.toString(), "claimed");
  assert.equal(candidate.active.targetContent, "claimed plaintext");
  assert.equal(candidate.active.journalKey.equals(fixture.journalKey), true);
  assert.equal(await fs.readFile(fixture.target, "utf8"), "claimed");
});

test("failed invitation cancellation stays staged for a recoverable retry", async () => {
  const coordinator = new ReplacementCoordinator({
    makeCandidate: () => invitationCandidate({ cancelFailsOnce: true }),
    authorizeCurrent: async (_operation, commit) => { await commit(); return true; },
    adopt: () => assert.fail("must not adopt"),
  });
  await coordinator.open("invitation.scpefe", "temporary password");
  await assert.rejects(coordinator.cancelClaim(), /cancel cleanup failed/);
  assert.equal(await coordinator.cancelClaim(), true);
  assert.equal(await coordinator.cancelClaim(), false);
});

test("external mutation after a real claim prevents adoption and preserves the original",
  async (t) => {
    const original = { id: "original", content: "original plaintext" };
    let authoritative = original;
    const fixture = await realInvitationCandidate(t);
    const revalidate = fixture.candidate.revalidateTargetForReplacement
      .bind(fixture.candidate);
    fixture.candidate.revalidateTargetForReplacement = async () => {
      await fs.writeFile(fixture.target, "externally changed");
      return revalidate();
    };
    const coordinator = new ReplacementCoordinator({
      makeCandidate: () => fixture.candidate,
      authorizeCurrent: async (_operation, commit) => { await commit(); return true; },
      adopt: (staged) => { authoritative = staged.candidate; },
    });
    await coordinator.open(fixture.target, fixture.temporary);
    await assert.rejects(coordinator.claim(fixture.replacement),
      (error) => error.code === "DOCUMENT_REPLACEMENT_TARGET_CHANGED");
    assert.equal(authoritative, original);
    assert.equal(await fs.readFile(fixture.target, "utf8"), "externally changed");
    assert.equal(await coordinator.cancelClaim(), true);
    assert.equal(authoritative, original);
  });

test("unsafe current state cancels New before a candidate or target can exist", async () => {
  let candidates = 0;
  const coordinator = new ReplacementCoordinator({
    makeCandidate: () => { candidates += 1; return {}; },
    authorizeCurrent: async () => false, adopt: () => assert.fail("must not adopt") });
  await assert.rejects(coordinator.create("new.scpefe", {
    ownerPassword: "owner password words", content: "",
  }), /current document remains open/);
  assert.equal(candidates, 0);
});

function delayedCandidate({ invitation = false, delay = "open" } = {}) {
  let release; const calls = [];
  const wait = () => new Promise((resolve) => { release = resolve; });
  const candidate = { active: null,
    async loadClientSettings() {},
    async createDocument(target) { calls.push("create"); this.active = { target };
      if (delay === "create") await wait(); },
    async openDocument(target) { calls.push("open"); this.active = { target };
      if (delay === "open") await wait();
      return invitation ? { readOnly: true, invitationRequired: true }
        : { content: "candidate plaintext", readOnly: true, canEdit: true,
          publicationState: "target-published" }; },
    async enterEditMode() { return { content: "", readOnly: false, canEdit: true,
      publicationState: "target-published" }; },
    async claimInvitation() { calls.push("claim"); if (delay === "claim") await wait();
      return { content: "claimed plaintext", readOnly: true, canEdit: true,
        publicationState: "target-published" }; },
    async revalidateTargetForReplacement() { calls.push("revalidate");
      if (delay === "commit") await wait(); },
    async lock() { calls.push("dispose"); this.active = null; },
    async abandonCreatedDocument() { calls.push("abandon"); this.active = null; },
  };
  return { candidate, calls, release: () => release() };
}

for (const [operation, stage] of [["open", "open"], ["open", "commit"],
  ["external-open", "open"], ["external-open", "commit"]]) {
  test(`lock generation prevents ${operation} adoption during awaited ${stage}`, async () => {
    const generation = new SessionGeneration(); const delayed = delayedCandidate({ delay: stage });
    let adopted = false;
    const coordinator = new ReplacementCoordinator({ generation,
      makeCandidate: () => delayed.candidate,
      authorizeCurrent: async (_operation, commit) => { await commit(); return true; },
      adopt: () => { adopted = true; } });
    const opening = coordinator.open("candidate.scpefe", "password words", operation);
    await new Promise((resolve) => setImmediate(resolve));
    generation.invalidate(); delayed.release();
    await assert.rejects(opening, /session locked/);
    assert.equal(adopted, false);
    assert.equal(delayed.candidate.active, null);
    assert.equal(delayed.calls.includes("dispose"), true);
  });
}

test("lock generation prevents New adoption during awaited creation", async () => {
  const generation = new SessionGeneration(); const delayed = delayedCandidate({ delay: "create" });
  let adopted = false;
  const coordinator = new ReplacementCoordinator({ generation,
    makeCandidate: () => delayed.candidate,
    authorizeCurrent: async (_operation, commit) => { await commit(); return true; },
    adopt: () => { adopted = true; } });
  const creating = coordinator.create("candidate.scpefe", { ownerPassword: "password words" });
  await new Promise((resolve) => setImmediate(resolve));
  generation.invalidate(); delayed.release();
  await assert.rejects(creating, /session locked/);
  assert.equal(adopted, false);
  assert.equal(delayed.calls.includes("abandon"), true);
});

test("lock generation disposes an invitation whose awaited claim finishes late", async () => {
  const generation = new SessionGeneration();
  const delayed = delayedCandidate({ invitation: true, delay: "claim" });
  let adopted = false;
  const coordinator = new ReplacementCoordinator({ generation,
    makeCandidate: () => delayed.candidate,
    authorizeCurrent: async (_operation, commit) => { await commit(); return true; },
    adopt: () => { adopted = true; } });
  await coordinator.open("invitation.scpefe", "temporary words");
  const claiming = coordinator.claim("replacement words");
  await new Promise((resolve) => setImmediate(resolve));
  generation.invalidate(); delayed.release();
  await assert.rejects(claiming, /session locked/);
  assert.equal(adopted, false);
  assert.equal(delayed.candidate.active, null);
  assert.equal(await coordinator.cancelClaim(), false);
});

test("a fenced staged Open leaves the next generation recoverable", async () => {
  const generation = new SessionGeneration(); const first = delayedCandidate({ delay: "open" });
  const healthy = delayedCandidate({ delay: "none" }); let candidates = 0; let adopted = null;
  const coordinator = new ReplacementCoordinator({ generation,
    makeCandidate: () => ++candidates === 1 ? first.candidate : healthy.candidate,
    authorizeCurrent: async (_operation, commit) => { await commit(); return true; },
    adopt: (staged) => { adopted = staged.candidate; } });
  const raced = coordinator.open("first.scpefe", "password words");
  await new Promise((resolve) => setImmediate(resolve));
  generation.invalidate(); first.release();
  await assert.rejects(raced, /session locked/);
  const opened = await coordinator.open("second.scpefe", "password words");
  assert.equal(opened.content, "candidate plaintext");
  assert.equal(adopted, healthy.candidate);
});
