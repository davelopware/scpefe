import test from "node:test";
import { lifecycleCaseName, runMountedLock } from
  "./lock-start-rendered-integration.desktop.ts";

for (const origin of ["pp-window-cancel", "pp-retry", "pp-discard-refused", "pp-fifo",
  "pp-restart"]) {
  test(lifecycleCaseName(origin), (t) => runMountedLock(t, origin));
}
