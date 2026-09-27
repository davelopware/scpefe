import assert from "node:assert/strict";
import test from "node:test";
import { MountedLifecycleCompletion } from "./mounted-lifecycle-completion.mjs";

test("mounted lifecycle completion waits for host failure and retry to settle", async () => {
  const completion = new MountedLifecycleCompletion({
    renderer: { waitForIdle: async () => {} },
  });
  let releaseFailure;
  const failure = completion.track("ipc:document:resolve-protection", () =>
    new Promise((_, reject) => { releaseFailure = () => reject(new Error("save failed")); }));
  let idle = false;
  const waiting = completion.waitForIdle({ timeoutMs: 1_000 })
    .then(() => { idle = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, false);
  releaseFailure();
  await assert.rejects(failure, /save failed/);
  await waiting;
  assert.equal(idle, true);

  let releaseRetry;
  completion.track("ipc:document:resolve-protection", () =>
    new Promise((resolve) => { releaseRetry = resolve; }));
  idle = false;
  const retry = completion.waitForIdle({ timeoutMs: 1_000 })
    .then(() => { idle = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, false);
  releaseRetry();
  await retry;
  assert.equal(idle, true);
});
