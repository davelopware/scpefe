/* Tears down a mounted lifecycle harness only after its rendered work is idle. */
export async function cleanupMountedLifecycleHarness({ completion, unmount,
  drainRendererTasks, clearFrames, closeDom, restoreGlobals, removeTemporaryFiles,
  timeoutMs = 5_000 }) {
  if (typeof completion?.waitForIdle !== "function") {
    throw new TypeError("renderer lifecycle completion is unavailable");
  }
  await completion.waitForIdle({ timeoutMs });
  let failed = false;
  let firstFailure;
  const attempt = async (operation) => {
    try { await operation(); }
    catch (error) {
      if (!failed) { failed = true; firstFailure = error; }
    }
  };
  await attempt(drainRendererTasks);
  await attempt(unmount);
  await attempt(drainRendererTasks);
  await attempt(clearFrames);
  await attempt(closeDom);
  await attempt(restoreGlobals);
  await attempt(removeTemporaryFiles);
  if (failed) throw firstFailure;
}
