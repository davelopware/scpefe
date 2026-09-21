import assert from "node:assert/strict";
import test from "node:test";
import { ReplacementCoordinator } from "../src/replacement-coordinator.mjs";

function invitationCandidate({ claimFails = false } = {}) {
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
    async lock() { this.active = null; },
  };
}

test("invitation open, failed claim, and cancellation retain the authoritative session",
  async () => {
    const original = { id: "original", content: "original plaintext" };
    let authoritative = original;
    const coordinator = new ReplacementCoordinator({
      makeCandidate: () => invitationCandidate({ claimFails: true }),
      authorizeCurrent: async () => true,
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

test("successful claim adopts only after revalidation", async () => {
  const log = [];
  let authoritative = { id: "original" };
  const candidate = invitationCandidate();
  candidate.claimInvitation = async () => { log.push("claim");
    return { content: "claimed", readOnly: true, canEdit: true,
      publicationState: "target-published" }; };
  candidate.revalidateTargetForReplacement = async () => { log.push("revalidate"); };
  const coordinator = new ReplacementCoordinator({ makeCandidate: () => candidate,
    authorizeCurrent: async () => true,
    adopt: (staged) => { log.push("adopt"); authoritative = staged.candidate; } });
  await coordinator.open("invitation.scpefe", "temporary password");
  await coordinator.claim("replacement password");
  assert.deepEqual(log, ["claim", "revalidate", "adopt"]);
  assert.equal(authoritative, candidate);
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
