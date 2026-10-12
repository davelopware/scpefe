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
}

interface NativeAddon {
  createDocument(request: object): Buffer;
  createContainerContext(): ContainerContext;
  openDocument(bytes: Buffer, password: string): { content: string };
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
  assert.equal(native.openDocument(bytes, password).content, "private words");
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
