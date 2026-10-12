import test from "node:test";
import { lifecycleCaseName, runMountedLock } from
  "./lock-start-rendered-integration.desktop.ts";

for (const origin of ["tc-close-no-doc", "te-exit-once", "tw-protect-reentry",
  "tx-external-before-exit"]) {
  test(lifecycleCaseName(origin), (t) => runMountedLock(t, origin));
}
