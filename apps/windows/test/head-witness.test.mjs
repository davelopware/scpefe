import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compareHeadWitness, HeadWitnessStore } from "../src/head-witness.mjs";

const documentId = "11".repeat(16);
const a = "aa".repeat(32);
const b = "bb".repeat(32);
const c = "cc".repeat(32);
const x = "dd".repeat(32);
const node = (revisionId, parentRevisionIds = []) => ({ revisionId, parentRevisionIds });
const observed = (headRevision, revisionGraph, id = documentId) =>
  ({ documentId: id, headRevision, revisionGraph });

test("classifies authenticated descendant, rollback, divergence, and replacement graphs", () => {
  const witness = { documentId, headRevision: b, graph: [node(a), node(b, [a])] };
  assert.equal(compareHeadWitness(witness,
    observed(c, [node(c, [b])])).kind, "descendant");
  assert.equal(compareHeadWitness(witness,
    observed(a, [node(a)])).kind, "rollback");
  assert.equal(compareHeadWitness(witness,
    observed(x, [node(x)])).kind, "divergence");
  assert.equal(compareHeadWitness(witness,
    observed(x, [node(x)], "22".repeat(16))).kind, "replacement");
});

test("persists advancing witnesses across restarts and detects tampering", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-witness-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const first = new HeadWitnessStore({ fs, directory: path.join(directory, "private") });
  assert.equal((await first.observe(target, observed(a, [node(a)]))).comparison.kind,
    "first-observation");
  assert.equal((await first.observe(target, observed(b, [node(b, [a])]))).comparison.kind,
    "descendant");

  const restarted = new HeadWitnessStore({ fs, directory: path.join(directory, "private") });
  assert.equal((await restarted.observe(target, observed(a, [node(a)]))).comparison.kind,
    "rollback");
  const storePath = path.join(directory, "private", "head-witnesses.json");
  const envelope = JSON.parse(await fs.readFile(storePath, "utf8"));
  envelope.payload = Buffer.from("{}", "utf8").toString("base64");
  await fs.writeFile(storePath, JSON.stringify(envelope));
  await assert.rejects(restarted.read(target), /integrity check failed/);
});

test("rejects authenticated graphs beyond client traversal limits", () => {
  const graph = Array.from({ length: 1026 }, (_value, index) =>
    node(index.toString(16).padStart(64, "0")));
  assert.throws(() => compareHeadWitness(null,
    observed(graph.at(-1).revisionId, graph)), /invalid authenticated revision graph/);
  assert.throws(() => compareHeadWitness(null,
    observed(a, [node(a, Array(9).fill(b))])), /invalid authenticated revision graph/);
});
