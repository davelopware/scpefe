import test from "node:test";
import { runMountedLock } from "./lock-start-rendered-integration.test.mjs";

test("mounted lifecycle completion owns a held host publication", (t) =>
  runMountedLock(t, "host-publication-idle"));
