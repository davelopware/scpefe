// @ts-nocheck -- preserve the legacy fixture shapes during the source-language cutover.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { runMountedLock } from "./lock-start-rendered-integration.desktop.ts";

const addonPath = process.argv[2];
assert.ok(addonPath, "native addon path is required");
const native = createRequire(import.meta.url)(addonPath);
assert.equal(typeof native.createContainerContext, "function");
assert.equal(native.createDocument, undefined, "the byte-oriented create export stays retired");
let creationCalls = 0;
// N-API methods are read-only; copy them and retain their native receiver.
const inspectedNative = Object.fromEntries(Object.getOwnPropertyNames(native)
  .map((property) => {
    const value = native[property];
    if (property === "createContainerContext") {
      return [property, (...args) => {
        const context = value.apply(native, args);
        return Object.fromEntries(Object.getOwnPropertyNames(context)
          .map((method) => {
            const operation = context[method];
            if (method === "create") {
              return [method, (input) => {
                creationCalls += 1;
                assert.equal(input.ownerPassword, "defenistration is the root of");
                assert.equal(input.recoveryPassword, "01a0bf20-2424-73e9-a572-f2eded90be3e");
                return operation.call(context, input);
              }];
            }
            return [method, typeof operation === "function"
              ? (...operationArgs) => operation.apply(context, operationArgs) : operation];
          }));
      }];
    }
    return [property, typeof value === "function" ? (...args) => value.apply(native, args)
      : value];
  }));
assert.equal(inspectedNative.passwordMeetsPolicy("defenistration is the root of"), true);
assert.equal(inspectedNative.passwordMeetsPolicy(
  "01a0bf20-2424-73e9-a572-f2eded90be3e"), true);

test("production renderer creates issue 53 values through the real native addon",
  async (t) => {
    await runMountedLock(t, "s0-new", inspectedNative);
    assert.equal(creationCalls, 1);
  });
