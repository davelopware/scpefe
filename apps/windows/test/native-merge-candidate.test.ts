import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const addonPath = process.env.SCPEFE_NATIVE_ADDON_PATH;
const native = addonPath ? createRequire(import.meta.url)(addonPath) : null;

const password = "owner passphrase with independent words";
const profile = { name: "Ada", email: "ada@example.test", deviceName: "Ada PC" };

function revisedSave(base: Buffer, content: string, timestampMs: number): Buffer {
  const context = native.createContainerContext();
  context.open(base);
  context.unlock(password);
  context.confirmEditLease();
  const candidate = context.prepareSave("manual", password,
    { ...profile, content, timestampMs, operationId: 1 });
  context.finishSave(candidate.operationId, "verified");
  context.close();
  return candidate.bytes;
}

test("merge candidate retains target bytes until verified acknowledgement", {
  skip: !native && "native addon path was not supplied",
}, () => {
  const seed = native.createContainerContext();
  const base = seed.create({ ...profile, content: "base", ownerPassword: password,
    timestampMs: 1 });
  seed.close();
  const local = revisedSave(base, "local", 2);
  const target = revisedSave(base, "target", 3);
  const localHead = native.inspectDocument(local, password).baseRevision;
  const targetHead = native.inspectDocument(target, password).baseRevision;

  const context = native.createContainerContext();
  context.open(target);
  context.unlock(password);
  assert.equal(context.assessMerge(local, password, password,
    { ...profile, content: "resolved", timestampMs: 4 }), true);
  assert.deepEqual(context.bytes(), target);
  context.confirmEditLease();
  const candidate = context.prepareMerge(local, password, password,
    { ...profile, content: "resolved", timestampMs: 4, operationId: 1 });
  assert.deepEqual(context.bytes(), target);
  const merged = native.inspectDocument(candidate.bytes, password);
  assert.equal(merged.content, "resolved");
  const head = merged.revisionGraph.find((item: { revisionId: string }) =>
    item.revisionId === merged.baseRevision);
  assert.ok(head);
  assert.deepEqual(head.parentRevisionIds, [localHead]);
  const history = native.createContainerContext();
  history.open(candidate.bytes);
  history.unlock(password);
  const metadata = history.historyPage(0, 10).items;
  assert.deepEqual(metadata.find((item: { revisionId: string }) =>
    item.revisionId === merged.baseRevision)?.mergeSources, [targetHead]);
  history.close();
  merged.journalKey.fill(0);

  context.finishSave(candidate.operationId, "verified");
  assert.deepEqual(context.bytes(), candidate.bytes);
  context.close();
});
