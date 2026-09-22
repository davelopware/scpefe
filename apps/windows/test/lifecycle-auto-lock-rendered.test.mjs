import test from "node:test";
import { lifecycleCaseName, runMountedLock } from
  "./lock-start-rendered-integration.test.mjs";

for (const variant of ["dialog", "save", "discard"]) {
  for (const entry of ["new", "open", "external", "close", "exit", "window"]) {
    const origin = `al-${entry}-${variant}`;
    test(lifecycleCaseName(origin), (t) => runMountedLock(t, origin));
  }
}

for (const origin of ["als-new-candidate", "als-open-auth", "als-external-auth",
  "als-open-revalidation", "als-external-revalidation"]) {
  test(lifecycleCaseName(origin), (t) => runMountedLock(t, origin));
}
