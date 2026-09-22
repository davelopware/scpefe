import test from "node:test";
import { lifecycleCaseName, runMountedLock } from
  "./lock-start-rendered-integration.test.mjs";

for (const origin of ["cf-cancel", "cf-retry", "cf-discard", "cf-merge",
  "cf-external", "cf-restart"]) {
  test(lifecycleCaseName(origin), (t) => runMountedLock(t, origin));
}
