import assert from "node:assert/strict";
import test from "node:test";
import { MountedLifecycleCompletion } from "./mounted-lifecycle-completion.ts";

test("mounted lifecycle completion waits for host failure and retry to settle", async () => {
  const completion = new MountedLifecycleCompletion({
    renderer: { waitForIdle: async () => {} },
  });
  let releaseFailure: (() => void) | undefined;
  const failure = completion.track("ipc:document:resolve-protection", () =>
    new Promise<void>((_, reject) => { releaseFailure = () => reject(new Error("save failed")); }));
  let idle = false;
  const waiting = completion.waitForIdle({ timeoutMs: 1_000 })
    .then(() => { idle = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, false);
  assert.ok(releaseFailure);
  releaseFailure();
  await assert.rejects(failure, /save failed/);
  await waiting;
  assert.equal(idle, true);

  let releaseRetry: (() => void) | undefined;
  completion.track("ipc:document:resolve-protection", () =>
    new Promise<void>((resolve) => { releaseRetry = resolve; }));
  idle = false;
  const retry = completion.waitForIdle({ timeoutMs: 1_000 })
    .then(() => { idle = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, false);
  assert.ok(releaseRetry);
  releaseRetry();
  await retry;
  assert.equal(idle, true);
});
