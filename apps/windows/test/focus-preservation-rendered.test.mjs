import test from "node:test";
import { runMountedLock } from "./lock-start-rendered-integration.test.mjs";

test("New and Open dialogs preserve secrets, validation, reveal, and focus across window focus changes",
  (t) => runMountedLock(t, "focus-no-doc"));

test("focus changes preserve an active document and its in-progress New dialog",
  (t) => runMountedLock(t, "focus-active"));

test("focus changes preserve a pending save-or-discard decision",
  (t) => runMountedLock(t, "focus-decision"));
