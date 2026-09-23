import assert from "node:assert/strict";
import test from "node:test";
import { RendererLifecycleCompletion } from
  "../src/renderer-lifecycle-completion.mjs";
import { cleanupMountedLifecycleHarness } from "./mounted-lifecycle-cleanup.mjs";

test("waitForIdle includes work active at the synchronization boundary", async () => {
  const completion = new RendererLifecycleCompletion();
  let release;
  let finished = false;
  const operation = completion.track(async () => {
    await new Promise((resolve) => { release = resolve; });
    finished = true;
  });
  await Promise.resolve();

  let idle = false;
  const waiting = completion.waitForIdle({ timeoutMs: 1_000 }).then(() => { idle = true; });
  await Promise.resolve();
  assert.equal(idle, false);

  release();
  await waiting;
  assert.equal(finished, true);
  await operation;
});

test("waitForIdle is bounded when lifecycle work cannot finish", async () => {
  const completion = new RendererLifecycleCompletion();
  completion.track(() => new Promise(() => {}));

  await assert.rejects(completion.waitForIdle({ timeoutMs: 10 }), (error) =>
    error.code === "RENDERER_LIFECYCLE_TIMEOUT"
      && /did not finish within 10 ms/.test(error.message));
});

test("mounted cleanup preserves DOM and files until tracked lifecycle work settles", async () => {
  const completion = new RendererLifecycleCompletion();
  const events = [];
  let release;
  let domAvailable = true;
  completion.track(async () => {
    events.push("work-started");
    await new Promise((resolve) => { release = resolve; });
    assert.equal(domAvailable, true, "tracked work finishes before DOM teardown");
    events.push("work-finished");
  });
  await Promise.resolve();

  const cleaning = cleanupMountedLifecycleHarness({ completion,
    drainRendererTasks: async () => events.push("drain-renderer-tasks"),
    unmount: () => events.push("unmount"),
    clearFrames: () => events.push("clear-frames"),
    closeDom: () => { domAvailable = false; events.push("close-dom"); },
    restoreGlobals: () => events.push("restore-globals"),
    removeTemporaryFiles: async () => events.push("remove-files"),
    timeoutMs: 1_000 });
  await Promise.resolve();
  assert.deepEqual(events, ["work-started"],
    "filesystem cleanup cannot begin while rendered lifecycle work is held");

  release();
  await cleaning;
  assert.deepEqual(events, ["work-started", "work-finished", "drain-renderer-tasks",
    "unmount", "drain-renderer-tasks", "clear-frames", "close-dom",
    "restore-globals", "remove-files"]);
});

test("mounted cleanup finishes every stage and rethrows the first teardown failure", async () => {
  const completion = new RendererLifecycleCompletion();
  const events = [];
  const unmountFailure = new Error("injected unmount failure");
  let drain = 0;

  await assert.rejects(cleanupMountedLifecycleHarness({ completion,
    drainRendererTasks: async () => events.push(`drain-${++drain}`),
    unmount: () => { events.push("unmount"); throw unmountFailure; },
    clearFrames: () => events.push("clear-frames"),
    closeDom: () => { events.push("close-dom"); throw new Error("secondary close failure"); },
    restoreGlobals: () => events.push("restore-globals"),
    removeTemporaryFiles: async () => events.push("remove-files"),
    timeoutMs: 1_000 }), (error) => error === unmountFailure);
  assert.deepEqual(events, ["drain-1", "unmount", "drain-2", "clear-frames",
    "close-dom", "restore-globals", "remove-files"]);
});
