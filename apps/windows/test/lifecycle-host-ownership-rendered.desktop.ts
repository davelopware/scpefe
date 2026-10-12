import test from "node:test";
import { runMountedLock } from "./lock-start-rendered-integration.desktop.ts";

test("mounted lifecycle completion owns a held host publication", (t) =>
  runMountedLock(t, "host-publication-idle"));
