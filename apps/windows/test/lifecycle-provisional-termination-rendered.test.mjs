import test from "node:test";
import { lifecycleCaseName, runMountedLock } from
  "./lock-start-rendered-integration.test.mjs";

for (const entry of ["close", "exit", "window"]) {
  for (const outcome of ["cancel", "save", "save-retry", "discard", "discard-retry"]) {
    const origin = `prc-${entry}-${outcome}`;
    test(lifecycleCaseName(origin), (t) => runMountedLock(t, origin));
  }
}
