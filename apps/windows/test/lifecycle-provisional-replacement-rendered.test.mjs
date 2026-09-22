import test from "node:test";
import { lifecycleCaseName, runMountedLock } from
  "./lock-start-rendered-integration.test.mjs";

for (const entry of ["new", "open", "external"]) {
  for (const outcome of ["cancel", "save", "save-retry", "discard", "discard-retry"]) {
    const origin = `prr-${entry}-${outcome}`;
    test(lifecycleCaseName(origin), (t) => runMountedLock(t, origin));
  }
}
