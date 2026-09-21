import assert from "node:assert/strict";
import test from "node:test";
import { ExternalOpenLifecycle } from "../src/external-open-lifecycle.mjs";
import { NativeLifecycleCoordinator } from "../src/native-lifecycle.mjs";
import { OrderedOpenRequests } from "../src/single-instance.mjs";
import { registerNativeWindowClose } from "../src/window-lifecycle.mjs";

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
