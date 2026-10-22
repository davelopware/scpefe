import test from "node:test";
import { lifecycleCaseName, runMountedLock } from
  "./lock-start-rendered-integration.desktop.ts";

for (const entry of ["new", "open", "external"]) {
  for (const outcome of ["cancel", "save", "save-retry", "discard", "discard-retry"]) {
    const origin = `dr-${entry}-${outcome}`;
    test(lifecycleCaseName(origin), (t) => runMountedLock(t, origin));
  }
}

test("D-S4-O dirty Open waits for slow candidate authentication before Save", (t) =>
  runMountedLock(t, "dr-open-save", null, { candidateReadDelayMs: 1_500 }));
