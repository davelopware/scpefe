/** Tasks owned by a mounted renderer test that must be disposed in order. */
export interface MountedHarnessCleanup {
  completion: { waitForIdle(options?: { timeoutMs?: number }): Promise<void> };
  unmount?: () => void | Promise<void>;
  drainRendererTasks?: () => void | Promise<void>;
  clearFrames?: () => void | Promise<void>;
  closeDom?: () => void | Promise<void>;
  restoreGlobals?: () => void | Promise<void>;
  removeTemporaryFiles?: () => void | Promise<void>;
  cancelPendingWork?: () => void | Promise<void>;
  primaryError?: unknown;
  timeoutMs?: number;
}

/* Cancels pending decisions and restores every mounted stage after lifecycle work settles. */
export async function cleanupMountedLifecycleHarness({ completion, unmount,
  drainRendererTasks, clearFrames, closeDom, restoreGlobals, removeTemporaryFiles,
  cancelPendingWork, primaryError = null, timeoutMs = 5_000 }: MountedHarnessCleanup): Promise<void> {
  if (typeof completion?.waitForIdle !== "function") {
    throw new TypeError("renderer lifecycle completion is unavailable");
  }
  let failed = false;
  let firstFailure: unknown;
  const attempt = async (operation?: () => void | Promise<void>) => {
    if (typeof operation !== "function") return;
    try { await operation(); }
    catch (error) {
      if (!failed) { failed = true; firstFailure = error; }
    }
  };
  await attempt(cancelPendingWork);
  await attempt(() => completion.waitForIdle({ timeoutMs }));
  if (failed) {
    await attempt(cancelPendingWork);
    await attempt(() => completion.waitForIdle({ timeoutMs }));
  }
  await attempt(drainRendererTasks);
  await attempt(unmount);
  await attempt(drainRendererTasks);
  await attempt(clearFrames);
  await attempt(closeDom);
  await attempt(restoreGlobals);
  await attempt(removeTemporaryFiles);
  if (failed && !primaryError) throw firstFailure;
}
