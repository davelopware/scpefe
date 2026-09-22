import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverDesktopTests,
  runDesktopTestGate,
} from "../scripts/run-desktop-tests.mjs";

async function temporaryWindowsRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "scpefe-desktop-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, "test", "example.test.mjs"), "");
  return root;
}

async function writeProductionBundle(root) {
  await mkdir(path.join(root, "dist", "assets"), { recursive: true });
  await writeFile(path.join(root, "dist", "index.html"), "<!doctype html>");
  await writeFile(path.join(root, "dist", "preload.cjs"), "");
}

test("desktop gate builds and validates production assets before serial tests", async (t) => {
  const root = await temporaryWindowsRoot(t);
  const calls = [];

  await runDesktopTestGate({
    windowsRoot: root,
    npmCommand: "test-npm",
    nodeCommand: "test-node",
    execute(command, arguments_, cwd) {
      calls.push({ command, arguments_, cwd });
      if (calls.length === 1) {
        assert.deepEqual([command, ...arguments_], ["test-npm", "run", "build"]);
        return writeProductionBundle(root);
      }
      assert.equal(calls.length, 2);
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].command, "test-node");
  assert.deepEqual(calls[1].arguments_.slice(0, 2), [
    "--test",
    "--test-concurrency=1",
  ]);
  assert.deepEqual(calls[1].arguments_.slice(2), [
    path.join(root, "test", "example.test.mjs"),
  ]);
  assert.equal(calls[1].cwd, root);
});

test("desktop gate never starts tests when the build leaves no production bundle", async (t) => {
  const root = await temporaryWindowsRoot(t);
  let calls = 0;

  await assert.rejects(
    runDesktopTestGate({
      windowsRoot: root,
      execute() {
        calls += 1;
      },
    }),
    { code: "ENOENT" },
  );
  assert.equal(calls, 1);
});

test("desktop test discovery ignores fixtures and has stable ordering", async (t) => {
  const root = await temporaryWindowsRoot(t);
  await writeFile(path.join(root, "test", "aaa.test.mjs"), "");
  await writeFile(path.join(root, "test", "notes.mjs"), "");
  await mkdir(path.join(root, "test", "nested.test.mjs"));

  assert.deepEqual(await discoverDesktopTests(root), [
    path.join(root, "test", "aaa.test.mjs"),
    path.join(root, "test", "example.test.mjs"),
  ]);
});
