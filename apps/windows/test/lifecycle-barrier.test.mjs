import assert from "node:assert/strict";
import test from "node:test";
import { LifecycleBarrier } from "../src/lifecycle-barrier.mjs";

test("exclusive lifecycle work waits for prior maintenance and blocks later maintenance", async () => {
  const barrier = new LifecycleBarrier();
  const log = []; let releaseFirst; let releaseWriter;
  const first = barrier.runMaintenance(async () => { log.push("first-start");
    await new Promise((resolve) => { releaseFirst = resolve; }); log.push("first-end"); });
  const writer = barrier.runExclusive(async () => { log.push("writer-start");
    await new Promise((resolve) => { releaseWriter = resolve; }); log.push("writer-end"); });
  const later = barrier.runMaintenance(async () => { log.push("later"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ["first-start"]);
  releaseFirst(); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ["first-start", "first-end", "writer-start"]);
  releaseWriter(); await Promise.all([first, writer, later]);
  assert.deepEqual(log, ["first-start", "first-end", "writer-start", "writer-end", "later"]);
});

test("maintenance invoked by the exclusive owner is reentrant without admitting outsiders", async () => {
  const barrier = new LifecycleBarrier(); const log = [];
  await barrier.runExclusive(async () => {
    log.push("writer");
    await barrier.runMaintenance(async () => { log.push("nested"); });
  });
  assert.deepEqual(log, ["writer", "nested"]);
  assert.equal(barrier.hasMaintenance, false);
});
