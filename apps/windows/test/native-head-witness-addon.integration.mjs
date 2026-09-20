import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { compareHeadWitness } from "../src/head-witness.mjs";

const require = createRequire(import.meta.url);
const native = require(process.argv[2]);
const password = "owner passphrase with independent words";

test("compiled addon exposes skipped authenticated ancestors", () => {
  const first = native.createDocument({ name: "Ada", email: "ada@example.test",
    deviceName: "Desk", content: "A", ownerPassword: password,
    recoveryPassword: null, timestampMs: 1 });
  const openedA = native.openDocument(first, password);
  const second = native.saveDocument(first, password, { name: "Ada",
    email: "ada@example.test", deviceName: "Desk", content: "B", timestampMs: 2 });
  const third = native.saveDocument(second, password, { name: "Ada",
    email: "ada@example.test", deviceName: "Desk", content: "C", timestampMs: 3 });
  const openedC = native.openDocument(third, password);

  assert.equal(openedC.revisionGraph.length, 3);
  const comparison = compareHeadWitness({ documentId: openedA.documentId,
    headRevision: openedA.baseRevision, graph: openedA.revisionGraph }, {
    documentId: openedC.documentId, headRevision: openedC.baseRevision,
    revisionGraph: openedC.revisionGraph,
  });
  assert.equal(comparison.kind, "descendant");
});
