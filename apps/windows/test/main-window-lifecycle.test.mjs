import assert from "node:assert/strict";
import test from "node:test";
import { ExternalOpenLifecycle } from "../src/external-open-lifecycle.mjs";
import { NativeLifecycleCoordinator } from "../src/native-lifecycle.mjs";
import { OrderedOpenRequests } from "../src/single-instance.mjs";
import { registerNativeWindowClose } from "../src/window-lifecycle.mjs";
import { SessionProtectionCoordinator } from "../src/session-protection.mjs";

const states = [
  ["no document", null],
  ["clean read-only", { editMode: false, dirty: false, manuallySealed: true }],
  ["dirty edit", { editMode: true, dirty: true, manuallySealed: true }],
];

for (const [name, active] of states) {
  for (const invitation of [false, true]) {
    test(`registered BrowserWindow close terminally drains ${invitation ? "invitation" : "password"} request from ${name}`,
      async () => {
        const events = []; let closeHandler;
        const window = { on(event, handler) { assert.equal(event, "close"); closeHandler = handler; },
          removeListener() {} };
        const requests = new OrderedOpenRequests({ randomToken: () => "request-1" });
        requests.setReady();
        const request = requests.enqueue({ target: invitation
          ? "invitation.scpefe" : "password.scpefe", source: "second-instance" });
        requests.take();
        const external = new ExternalOpenLifecycle({ requests,
          acknowledge: async (_request, status, sequence) =>
            events.push(`ack:${status}:${sequence}`),
          record: async () => events.push("record"), drain: async () => events.push("drain") });
        if (invitation) external.stageInvitation(request);
        const service = { active: active && { ...active }, hasActivePublication: () => false,
          async exitEditMode() { events.push("release"); this.active.editMode = false; } };
        const protections = { async authorize(_operation, commit) {
          events.push("authorize"); await commit(); return true;
        } };
        let finalPrevented = null;
        const lifecycle = new NativeLifecycleCoordinator({ getService: () => service,
          protections, lockActive: async () => {},
          hasExternalRequests: () => requests.size > 0,
          cancelExternalRequests: () => external.terminateAll("application-exit"),
          closeWindow() { events.push("close");
            const final = { prevented: false, preventDefault() { this.prevented = true; } };
            void closeHandler(final); finalPrevented = final.prevented; },
          report: (warning) => events.push(`warning:${warning}`) });
        registerNativeWindowClose(window, lifecycle);
        const event = { prevented: false, preventDefault() { this.prevented = true;
          events.push("prevent"); } };
        assert.equal(await closeHandler(event), true);
        assert.equal(event.prevented, true);
        assert.equal(finalPrevented, false, "authorized close reentry is not intercepted twice");
        assert.equal(requests.size, 0);
        assert.equal(events.indexOf("ack:canceled:3") < events.indexOf("close"), true);
        assert.deepEqual(events.slice(0, 4), ["prevent", "authorize",
          "ack:canceled:3", "record"]);
      });
  }
}

for (const [name, active] of states.slice(0, 2)) {
  test(`registered BrowserWindow close | ${name} | no external request | direct close`, async () => {
    let handler;
    const window = { on(_event, value) { handler = value; }, removeListener() {} };
    const lifecycle = new NativeLifecycleCoordinator({ getService: () => ({ active,
      hasActivePublication: () => false }),
    protections: { authorize: () => assert.fail("clean direct close must not authorize") },
    lockActive: async () => {}, closeWindow: () => assert.fail("native reentry owns closing"),
    report: () => {} });
    registerNativeWindowClose(window, lifecycle);
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    assert.equal(await handler(event), true);
    assert.equal(event.prevented, false);
  });
}

const protectedStates = [
  ["dirty edit", { editMode: true, dirty: true, manuallySealed: true }],
  ["provisional edit", { editMode: true, dirty: false, manuallySealed: false }],
  ["pending-publication read-only", { editMode: false, dirty: false,
    manuallySealed: true, pendingPublication: true, unresolvedJournal: true }],
  ["recovered read-only", { editMode: false, dirty: false, manuallySealed: true,
    recovery: { text: "recoverable" }, unresolvedJournal: true }],
  ["conflict read-only", { editMode: false, dirty: false, manuallySealed: true,
    pendingPublication: true, unresolvedJournal: true,
    pendingRecord: { state: "conflict", publication: { purpose: "manual-save" } } }],
];

for (const [name, active] of protectedStates) {
  test(`registered BrowserWindow close | ${name} | Cancel | prior session retained`, async () => {
    let handler; let request;
    const service = { active: { ...active }, hasActivePublication: () => false };
    const protections = new SessionProtectionCoordinator({ getService: () => service,
      present(value) { request = value; } });
    const lifecycle = new NativeLifecycleCoordinator({ getService: () => service,
      protections, lockActive: async () => {},
      closeWindow: () => assert.fail("Cancel must not close"), report: () => {} });
    registerNativeWindowClose({ on(_event, value) { handler = value; },
      removeListener() {} }, lifecycle);
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    const closing = handler(event);
    assert.equal(event.prevented, true);
    await protections.decide({ token: request.token, decision: "cancel" });
    assert.equal(await closing, false);
    assert.deepEqual(service.active, active);
  });
}

const closeDecisions = [
  ["Save success", "save", 0],
  ["Save failure then Retry success", "save", 1],
  ["Discard allowed", "discard", 0],
  ["Discard blocked then Retry success", "discard", 1],
];
for (const [name, decision, failures] of closeDecisions) {
  test(`registered BrowserWindow close | dirty edit | ${name}`, async () => {
    let handler; let request; let remaining = failures; let closes = 0;
    const active = { editMode: true, dirty: true, manuallySealed: true,
      working: { content: "authoritative plaintext" } };
    const service = { active, hasActivePublication: () => false,
      async saveDocument() { if (remaining-- > 0) throw new Error("publication fault");
        active.dirty = false; },
      async discardUnsavedForClose() { if (remaining-- > 0) throw new Error("cleanup fault");
        active.dirty = false; },
      async exitEditMode() { active.editMode = false; } };
    const protections = new SessionProtectionCoordinator({ getService: () => service,
      present(value) { request = value; } });
    const lifecycle = new NativeLifecycleCoordinator({ getService: () => service,
      protections, lockActive: async () => {}, closeWindow: () => { closes += 1; },
      report: () => {} });
    registerNativeWindowClose({ on(_event, value) { handler = value; },
      removeListener() {} }, lifecycle);
    const event = { preventDefault() {} }; const closing = handler(event);
    let result = await protections.decide({ token: request.token, decision });
    if (!result.completed) {
      assert.equal(active.working.content, "authoritative plaintext");
      result = await protections.decide({ token: result.retryToken, decision });
    }
    assert.equal(result.completed, true);
    assert.equal(await closing, true);
    assert.equal(closes, 1);
  });
}

for (const [name, service] of [
  ["clean-edit", { active: { editMode: true, dirty: false, manuallySealed: true },
    hasActivePublication: () => false }],
  ["locked", { active: null, hasActivePublication: () => false }],
  ["active publication", { active: { editMode: false, dirty: false, manuallySealed: true },
    hasActivePublication: () => true, runLifecycleBarrier: (operation) => operation() }],
  ["active maintenance", { active: { editMode: false, dirty: false, manuallySealed: true },
    hasActivePublication: () => true, runLifecycleBarrier: (operation) => operation() }],
]) {
  test(`registered BrowserWindow close | ${name} | authoritative outcome`, async () => {
    let handler; let closes = 0; let request;
    service.exitEditMode ??= async () => { service.active.editMode = false; };
    const protections = new SessionProtectionCoordinator({ getService: () => service,
      present: (value) => { request = value; } });
    const lifecycle = new NativeLifecycleCoordinator({ getService: () => service,
      protections, lockActive: async () => {}, closeWindow: () => { closes += 1; },
      report: () => {} });
    registerNativeWindowClose({ on(_event, value) { handler = value; },
      removeListener() {} }, lifecycle);
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    const closing = handler(event);
    if (request) await protections.decide({ token: request.token, decision: "save" });
    const result = await closing;
    if (name === "locked") { assert.equal(event.prevented, false); assert.equal(closes, 0); }
    else { assert.equal(result, true); assert.equal(closes, 1); }
  });
}
