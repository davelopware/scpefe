import assert from "node:assert/strict";
import test from "node:test";
import { ReplacementCoordinator } from "../src/replacement-coordinator.mjs";
import { SecureLockCoordinator } from "../src/secure-lock-coordinator.mjs";

function invitationCandidate(log) {
  return { active: null,
    async loadClientSettings() {},
    async openDocument(target) {
      this.active = { target };
      return { readOnly: true, invitationRequired: true };
    },
    async lock(reason) {
      log.push(`candidate-lock:${reason}`);
      this.active = null;
      return { locked: true, journalSaved: true, warning: null, reason };
    },
  };
}

function fixture({ activeTarget = null } = {}) {
  const log = [];
  let candidate;
  const service = { active: activeTarget ? { target: activeTarget } : null,
    async lock(reason) {
      log.push(`authoritative-lock:${reason}`);
      this.active = null;
      return { locked: true, journalSaved: true, warning: null, reason };
    } };
  const replacements = new ReplacementCoordinator({
    makeCandidate: () => { candidate = invitationCandidate(log); return candidate; },
    authorizeCurrent: async () => true,
    adopt: () => assert.fail("a staged invitation must not be adopted by locking"),
  });
  let selectedOpenTarget = "invitation.scpefe";
  let lockedTarget = null;
  const coordinator = new SecureLockCoordinator({ getService: () => service,
    replacements,
    creationFlow: { cancel: () => log.push("creation-cancel") },
    clearOpenTarget: () => { selectedOpenTarget = null; log.push("open-cancel"); },
    rememberLockedTarget: (target) => { if (target) lockedTarget = target; },
    emitLocked: (result) => log.push(`emit:${result.reason}`),
  });
  return { log, service, replacements, coordinator,
    candidate: () => candidate,
    state: () => ({ selectedOpenTarget, lockedTarget }) };
}

test("manual lock disposes a staged claim before securing the prior session", async () => {
  const setup = fixture({ activeTarget: "original.scpefe" });
  await setup.replacements.open("invitation.scpefe", "temporary password words");
  const result = await setup.coordinator.lock("app-lock");
  assert.equal(result.locked, true);
  assert.deepEqual(setup.log, ["creation-cancel", "open-cancel",
    "candidate-lock:replacement-canceled", "authoritative-lock:app-lock", "emit:app-lock"]);
  assert.deepEqual(setup.state(), { selectedOpenTarget: null,
    lockedTarget: "original.scpefe" });
  assert.equal(setup.replacements.hasStagedCandidate(setup.candidate()), false);
  await setup.replacements.open("next.scpefe", "temporary password words");
  assert.equal(setup.replacements.hasStagedCandidate(setup.candidate()), true,
    "a future Open is not blocked by the disposed claim");
});

test("lock without an authoritative document still disposes and emits teardown", async () => {
  const setup = fixture();
  await setup.replacements.open("invitation.scpefe", "temporary password words");
  await setup.coordinator.lock("app-lock");
  assert.deepEqual(setup.log.slice(-2), ["authoritative-lock:app-lock", "emit:app-lock"]);
  assert.deepEqual(setup.state(), { selectedOpenTarget: null, lockedTarget: null });
  assert.equal(setup.replacements.hasStagedCandidate(setup.candidate()), false);
});

test("a staged candidate automatic lock tears down and locks the authoritative session",
  async () => {
    const setup = fixture({ activeTarget: "original.scpefe" });
    await setup.replacements.open("invitation.scpefe", "temporary password words");
    const candidate = setup.candidate();
    const automatic = await candidate.lock("inactivity");
    await setup.coordinator.serviceLocked(candidate, automatic);
    assert.equal(setup.service.active, null);
    assert.equal(setup.replacements.hasStagedCandidate(candidate), false);
    assert.deepEqual(setup.log.slice(-2), ["authoritative-lock:inactivity", "emit:inactivity"]);
  });
