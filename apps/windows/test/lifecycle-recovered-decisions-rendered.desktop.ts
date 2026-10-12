import test from "node:test";
import { lifecycleCaseName, runMountedLock } from
  "./lock-start-rendered-integration.desktop.ts";

for (const origin of ["rw-cancel", "rw-save", "rw-save-delayed-publication",
  "rw-save-retry", "rw-discard",
  "rw-external", "rw-restart"]) {
  test(lifecycleCaseName(origin), (t) => runMountedLock(t, origin));
}
