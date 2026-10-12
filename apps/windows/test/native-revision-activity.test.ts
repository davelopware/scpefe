import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

interface ContainerContext {
  open(bytes: Buffer): Buffer;
  unlock(password: string): true;
  lock(): true;
  close(): true;
  historyPage(offset: number, count: number): { items: Array<{
    revisionId: string; previousHead?: string; contentParent?: string;
    actorSlotId: string; actorName: string; actorEmail: string; device: string;
    kind: number; storageKind: number; bodyAvailable: boolean;
    textAvailable: boolean; mergeSources: string[]; eventType: string;
    eventDetailsCbor?: string }>; nextOffset: number;
    hasMore: boolean };
  historyCompare(beforeId: string, afterId: string):
    { available: boolean; text?: string };
}
interface NativeAddon {
  createContainerContext(): ContainerContext;
}
const path = process.env.SCPEFE_NATIVE_ADDON_PATH;
const native = path ? createRequire(import.meta.url)(path) as NativeAddon : null;

test("native history bridge pages authenticated metadata and compares available text", {
  skip: !native && "native addon path was not supplied",
}, () => {
  assert.ok(native);
  const password = "correct horse battery staple";
  const fixture = readFileSync(new URL("../../../tests/vectors/draft-v3/valid/"
    + "pruned-checkpoint-container.hex", import.meta.url), "utf8");
  const bytes = Buffer.from(fixture.replace(/#.*$/gm, "").replace(/\s/g, ""), "hex");
  const context = native.createContainerContext();
  try {
    context.open(bytes);
    assert.throws(() => context.historyPage(0, 1), /status 15/);
    context.unlock(password);
    const newest = context.historyPage(0, 2);
    const older = context.historyPage(2, 2);
    assert.equal(newest.items.length, 2);
    assert.equal(older.items.length, 2);
    assert.equal(newest.items[0].previousHead, newest.items[1].revisionId);
    assert.equal(newest.items[1].previousHead, older.items[0].revisionId);
    assert.equal(older.items[0].contentParent, older.items[1].revisionId);
    assert.equal(newest.items[0].actorName, "Alice");
    assert.equal(newest.items[0].actorEmail, "alice@example.test");
    assert.equal(newest.items[0].device, "test-device");
    assert.equal(newest.items[0].eventType, "compaction");
    assert.ok(newest.items[0].eventDetailsCbor);
    assert.equal(older.items[1].storageKind, 4);
    assert.equal(older.items[1].textAvailable, false);
    assert.equal(older.items[0].storageKind, 3);
    assert.equal(older.items[0].textAvailable, true);
    assert.equal(newest.nextOffset, 2);
    assert.equal(older.nextOffset, 4);
    assert.equal(newest.hasMore, true);
    assert.equal(older.hasMore, false);
    assert.deepEqual(context.historyPage(4, 2).items, []);
    const comparison = context.historyCompare(older.items[0].revisionId,
      newest.items[0].revisionId);
    assert.equal(comparison.available, true);
    assert.equal(typeof comparison.text, "string");
    assert.deepEqual(context.historyCompare(older.items[1].revisionId,
      older.items[0].revisionId), { available: false });
    assert.throws(() => context.historyPage(-1, 1), /safe integer/);
    assert.throws(() => context.historyCompare("bad", newest.items[0].revisionId),
      /revision ID/);
    context.lock();
    assert.throws(() => context.historyPage(0, 1), /status 15/);
  } finally { context.close(); }
});
