import assert from "node:assert/strict";
import test from "node:test";
import { registerWindowFocusProtection } from "../src/window-focus-protection.mjs";

test("focus transitions refresh inactivity without locking, while OS lock locks", async () => {
  const windowHandlers = new Map();
  const powerHandlers = new Map();
  const events = [];
  registerWindowFocusProtection({
    window: { on: (name, handler) => windowHandlers.set(name, handler) },
    powerMonitor: { on: (name, handler) => powerHandlers.set(name, handler) },
    activity: () => events.push("activity"),
    lock: (reason) => { events.push(`lock:${reason}`); return Promise.resolve(); },
  });
  for (const name of ["blur", "minimize", "focus", "restore"]) {
    windowHandlers.get(name)();
  }
  assert.deepEqual(events, ["activity", "activity", "activity", "activity"]);
  powerHandlers.get("lock-screen")();
  assert.deepEqual(events.at(-1), "lock:screen-lock");
});
