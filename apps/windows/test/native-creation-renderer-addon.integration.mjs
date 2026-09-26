import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { runMountedLock } from "./lock-start-rendered-integration.test.mjs";

const addonPath = process.argv[2];
assert.ok(addonPath, "native addon path is required");
const native = createRequire(import.meta.url)(addonPath);
let creationCalls = 0;
const inspectedNative = Object.fromEntries(Object.getOwnPropertyNames(native)
  .map((property) => {
    const value = native[property];
    if (property === "createDocument") {
      return [property, (input) => {
        creationCalls += 1;
        assert.equal(input.ownerPassword, "defenistration is the root of");
        assert.equal(input.recoveryPassword, "01a0bf20-2424-73e9-a572-f2eded90be3e");
        return value(input);
      }];
    }
    return [property, typeof value === "function" ? (...args) => value(...args) : value];
  }));
assert.equal(inspectedNative.passwordMeetsPolicy("defenistration is the root of"), true);
assert.equal(inspectedNative.passwordMeetsPolicy(
  "01a0bf20-2424-73e9-a572-f2eded90be3e"), true);

test("production renderer creates issue 53 values through the real native addon",
  async (t) => {
    await runMountedLock(t, "s0-new", inspectedNative);
    assert.equal(creationCalls, 1);
  });
