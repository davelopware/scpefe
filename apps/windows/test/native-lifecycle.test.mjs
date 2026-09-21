import assert from "node:assert/strict";
import test from "node:test";
import { NativeLifecycleCoordinator } from "../src/native-lifecycle.mjs";

function setup({ active, authorize = true, exitFails = false,
  activePublication = false } = {}) {
  const calls = [];
  const service = { active: active ?? { editMode: true, dirty: true, manuallySealed: true },
    hasActivePublication: () => activePublication,
    async exitEditMode() { calls.push("release");
      if (exitFails) throw new Error("lease release failed"); this.active.editMode = false; } };
  const protections = { async authorize(operation, commit) { calls.push(`protect:${operation}`);
    if (!authorize) return false; await commit(); return true; } };
  const lifecycle = new NativeLifecycleCoordinator({ getService: () => service,
    protections, async lockActive(reason) { calls.push(`lock:${reason}`);
      service.active = null; }, closeWindow() { calls.push("close"); },
    report(warning) { calls.push(`warning:${warning}`); } });
  const event = { prevented: false, preventDefault() { this.prevented = true;
    calls.push("prevent"); } };
  return { lifecycle, service, event, calls };
}

test("native window close cancels without releasing or terminating", async () => {
  const value = setup({ authorize: false });
  assert.equal(await value.lifecycle.handleClose(value.event), false);
  assert.equal(value.event.prevented, true);
  assert.deepEqual(value.calls, ["prevent", "protect:exit"]);
  assert.equal(value.service.active.dirty, true);
});

test("native window close protects, releases, and re-enters only for final close", async () => {
  const value = setup();
  assert.equal(await value.lifecycle.handleClose(value.event), true);
  assert.deepEqual(value.calls, ["prevent", "protect:exit", "release", "close"]);
  const final = { prevented: false, preventDefault() { this.prevented = true; } };
  assert.equal(await value.lifecycle.handleClose(final), true);
  assert.equal(final.prevented, false);
});

test("renderer Exit shares authorization and does not ask twice at native close", async () => {
  const value = setup();
  assert.equal(await value.lifecycle.requestExit(), true);
  await value.lifecycle.handleClose(value.event);
  assert.deepEqual(value.calls.filter((call) => call === "protect:exit"), ["protect:exit"]);
});

test("active publication is protected even for a clean read-only session", async () => {
  const value = setup({ active: { editMode: false, dirty: false, manuallySealed: true },
    activePublication: true });
  await value.lifecycle.handleClose(value.event);
  assert.deepEqual(value.calls, ["prevent", "protect:exit", "close"]);
});

test("lease-release failure securely locks before allowing final close", async () => {
  const value = setup({ exitFails: true });
  await value.lifecycle.handleClose(value.event);
  assert.deepEqual(value.calls,
    ["prevent", "protect:exit", "release", "lock:app-exit", "close"]);
  assert.equal(value.service.active, null);
});

test("clean read-only native close requires no interception", async () => {
  const value = setup({ active: { editMode: false, dirty: false, manuallySealed: true } });
  assert.equal(await value.lifecycle.handleClose(value.event), true);
  assert.equal(value.event.prevented, false);
  assert.deepEqual(value.calls, []);
});
