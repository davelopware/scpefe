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

test("detached work cannot reuse an expired exclusive owner's context", async () => {
  const barrier = new LifecycleBarrier();
  const events = [];
  let releaseDetached;
  const detachedSignal = new Promise((resolve) => { releaseDetached = resolve; });
  let detached;
  await barrier.runExclusive(async () => {
    detached = detachedSignal.then(() => barrier.runMaintenance(async () => {
      events.push("detached-maintenance");
    }));
  });

  let releaseCurrent;
  const current = barrier.runExclusive(async () => {
    events.push("current-exclusive");
    await new Promise((resolve) => { releaseCurrent = resolve; });
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["current-exclusive"]);

  releaseDetached();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["current-exclusive"],
    "an expired owner cannot run maintenance through another exclusive operation");

  releaseCurrent();
  await Promise.all([current, detached]);
  assert.deepEqual(events, ["current-exclusive", "detached-maintenance"]);
});

test("exclusive ownership lasts until detached reentrant maintenance settles", async () => {
  const barrier = new LifecycleBarrier();
  const events = [];
  let releaseNested;
  let nestedStarted;
  const started = new Promise((resolve) => { nestedStarted = resolve; });
  const outer = barrier.runExclusive(async () => {
    events.push("exclusive-start");
    void barrier.runMaintenance(async () => {
      events.push("nested-start"); nestedStarted();
      await new Promise((resolve) => { releaseNested = resolve; });
      events.push("nested-end");
    });
    events.push("exclusive-body-end");
  });
  await started;
  const following = barrier.runExclusive(async () => { events.push("following-exclusive"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["exclusive-start", "exclusive-body-end", "nested-start"],
    "the next writer cannot enter while owned maintenance is active");
  releaseNested();
  await Promise.all([outer, following]);
  assert.deepEqual(events, ["exclusive-start", "exclusive-body-end", "nested-start",
    "nested-end", "following-exclusive"]);
});
