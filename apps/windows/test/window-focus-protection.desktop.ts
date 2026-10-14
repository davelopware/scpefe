import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error The platform host remains JavaScript and has no declaration yet.
import { registerWindowFocusProtection } from "../src/window-focus-protection.mjs";

test("focus transitions refresh inactivity without locking, while OS lock locks", async () => {
  const windowHandlers = new Map<string, () => void>();
  const powerHandlers = new Map<string, () => void>();
  const events: string[] = [];
  registerWindowFocusProtection({
    window: { on: (name: string, handler: () => void) => windowHandlers.set(name, handler) },
    powerMonitor: { on: (name: string, handler: () => void) => powerHandlers.set(name, handler) },
    activity: () => events.push("activity"),
    lock: (reason: string) => { events.push(`lock:${reason}`); return Promise.resolve(); },
  });
  for (const name of ["blur", "minimize", "focus", "restore"]) {
    const handler = windowHandlers.get(name);
    assert.ok(handler);
    handler();
  }
  assert.deepEqual(events, ["activity", "activity", "activity", "activity"]);
  const lockScreen = powerHandlers.get("lock-screen");
  assert.ok(lockScreen);
  lockScreen();
  assert.deepEqual(events.at(-1), "lock:screen-lock");
});
