import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

interface ContainerContext {
  create(request: object): Buffer;
  open(bytes: Buffer): Buffer;
  unlock(password: string): true;
  lock(): true;
  close(): true;
  read(): { content: string; documentId: string; slotId: string };
  bytes(): Buffer;
  status(): { locked: boolean };
  confirmEditLease(): true;
  prepareSave(kind: "manual" | "regular" | "discard", password: string,
    input: object): { bytes: Buffer; operationId: number; effects: number };
  finishSave(operationId: number, outcome: "verified" | "definite-failure" | "ambiguous"):
    number;
  resolveSave(operationId: number, published: boolean): number;
}

interface NativeAddon {
  createDocument(request: object): Buffer;
  createContainerContext(): ContainerContext;
  inspectDocument(bytes: Buffer, password: string): { content: string };
}

const addonPath = process.env.SCPEFE_NATIVE_ADDON_PATH;
const native = addonPath
  ? createRequire(import.meta.url)(addonPath) as NativeAddon : null;

test("one context retains its handle through Lock and authenticated Unlock", {
  skip: !native && "native addon path was not supplied",
}, () => {
  assert.ok(native);
  const password = "owner passphrase with independent words";
  const context = native.createContainerContext();
  const other = native.createContainerContext();
  const bytes = context.create({ name: "Ada", email: "ada@example.test",
    deviceName: "Ada PC", content: "private words", ownerPassword: password,
    timestampMs: 1 });
  assert.equal(native.inspectDocument(bytes, password).content, "private words");
  assert.equal(context.status().locked, false);
  assert.throws(() => context.open(bytes), /status 14/);
  const first = context.read();
  assert.equal(first.content, "private words");
  assert.equal(first.documentId.length, 32);
  assert.equal(first.slotId.length, 32);
  assert.deepEqual(context.bytes(), bytes);
  assert.equal(context.lock(), true);
  assert.equal(context.status().locked, true);
  assert.throws(() => context.read(), /status 15/);
  assert.throws(() => context.unlock("incorrect password"), /status 10/);
  assert.throws(() => context.read(), /status 15/);
  assert.equal(context.unlock(password), true);
  assert.deepEqual(context.read(), first);
  assert.equal(other.open(bytes), bytes);
  assert.equal(other.status().locked, true);
  assert.equal(other.unlock(password), true);
  assert.equal(context.close(), true);
  assert.throws(() => context.read(), /status 14/);
  assert.equal(context.open(bytes), bytes);
  assert.equal(context.close(), true);
  assert.equal(other.close(), true);
});

test("exact native save candidates remain pending until verified or resolved", {
  skip: !native && "native addon path was not supplied",
}, () => {
  assert.ok(native);
  const password = "owner passphrase with independent words";
  const context = native.createContainerContext();
  context.create({ name: "Ada", email: "ada@example.test",
    deviceName: "Ada PC", content: "base", ownerPassword: password,
    timestampMs: 1 });
  context.confirmEditLease();
  const input = { name: "Ada", email: "ada@example.test",
    deviceName: "Ada PC", content: "submitted", timestampMs: 2,
    operationId: 1 };
  const candidate = context.prepareSave("manual", password, input);
  assert.equal(native.inspectDocument(candidate.bytes, password).content, "submitted");
  assert.equal(context.read().content, "submitted");
  assert.notDeepEqual(context.bytes(), candidate.bytes);
  assert.throws(() => context.prepareSave("manual", password,
    { ...input, operationId: 2 }), /status 14/);
  context.finishSave(candidate.operationId, "ambiguous");
  assert.throws(() => context.prepareSave("manual", password,
    { ...input, operationId: 2 }), /status 14/);
  context.resolveSave(candidate.operationId, true);
  assert.deepEqual(context.bytes(), candidate.bytes);
  const next = context.prepareSave("manual", password,
    { ...input, content: "newer", operationId: 2, timestampMs: 3 });
  context.finishSave(next.operationId, "definite-failure");
  assert.deepEqual(context.bytes(), candidate.bytes);
  assert.equal(context.read().content, "newer");
  context.close();
});
