import test from "node:test";
import { lifecycleCaseName, runMountedLock } from
  "./lock-start-rendered-integration.test.mjs";

const entries = ["new", "open", "external", "close", "exit", "window"];

for (const state of ["s5", "s6", "s7", "s8", "s9"]) {
  for (const entry of entries) {
    const origin = `${state}-${entry}`;
    test(lifecycleCaseName(origin), (t) => runMountedLock(t, origin));
  }
}
