import assert from "node:assert/strict";
import { createRequire } from "node:module";

const native = createRequire(import.meta.url)(process.argv[2]);
const password = "owner passphrase with independent words";
const base = native.createDocument({ name: "Ada", email: "ada@example.test",
  deviceName: "Desk", content: "base", ownerPassword: password,
  recoveryPassword: null, timestampMs: 1 });
const local = native.saveDocument(base, password, { name: "Ada",
  email: "ada@example.test", deviceName: "Laptop", content: "local",
  timestampMs: 2 });
const current = native.saveDocument(base, password, { name: "Ada",
  email: "ada@example.test", deviceName: "Desk", content: "current",
  timestampMs: 3 });
const localHead = native.openDocument(local, password).baseRevision;
const currentHead = native.openDocument(current, password).baseRevision;
const merged = native.mergeDocument(current, local, password, { name: "Ada",
  email: "ada@example.test", deviceName: "Desk", content: "resolved",
  timestampMs: 4 });
const opened = native.openDocument(merged, password);
assert.equal(opened.content, "resolved");
const head = opened.revisionGraph.find(
  (node) => node.revisionId === opened.baseRevision);
assert.deepEqual(head.parentRevisionIds, [localHead, currentHead]);
assert.throws(() => native.mergeDocument(current, current, password, {
  name: "Ada", email: "ada@example.test", deviceName: "Desk",
  content: "not divergent", timestampMs: 5,
}));
