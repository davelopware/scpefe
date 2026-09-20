import assert from "node:assert/strict";
import { createRequire } from "node:module";

const native = createRequire(import.meta.url)(process.argv[2]);
const password = "owner passphrase with independent words";
const input = { name: "Ada", email: "ada@example.test", deviceName: "Desk" };
const base = native.createDocument({ ...input, content: "base",
  ownerPassword: password, recoveryPassword: null, timestampMs: 1 });
const baseHead = native.openDocument(base, password).baseRevision;
const first = native.regularSaveDocument(base, password,
  { ...input, content: "first", timestampMs: 2 });
const firstOpened = native.openDocument(first, password);
assert.equal(firstOpened.content, "first");
assert.equal(firstOpened.manuallySealed, false);
assert.deepEqual(firstOpened.revisionGraph.find(
  (node) => node.revisionId === firstOpened.baseRevision).parentRevisionIds,
  [baseHead]);

const second = native.regularSaveDocument(first, password,
  { ...input, content: "second", timestampMs: 3 });
const secondOpened = native.openDocument(second, password);
assert.equal(secondOpened.manuallySealed, false);
assert.equal(secondOpened.revisionGraph.length, firstOpened.revisionGraph.length);
assert.deepEqual(secondOpened.revisionGraph.find(
  (node) => node.revisionId === secondOpened.baseRevision).parentRevisionIds,
  [baseHead]);

const sealed = native.saveDocument(second, password,
  { ...input, content: "second", timestampMs: 4 });
const sealedOpened = native.openDocument(sealed, password);
assert.equal(sealedOpened.manuallySealed, true);
assert.equal(sealedOpened.revisionGraph.length, secondOpened.revisionGraph.length);
assert.deepEqual(sealedOpened.revisionGraph.find(
  (node) => node.revisionId === sealedOpened.baseRevision).parentRevisionIds,
  [baseHead]);

const discarded = native.discardProvisional(second, password);
const discardedOpened = native.openDocument(discarded, password);
assert.equal(discardedOpened.content, "base");
assert.equal(discardedOpened.baseRevision, baseHead);
assert.equal(discardedOpened.manuallySealed, true);
