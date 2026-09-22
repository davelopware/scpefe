import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createNpmBuildInvocation,
  discoverDesktopTests,
  resolveNpmCli,
  runDesktopTestGate,
  verifyProductionBundle,
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
  await writeFile(
    path.join(root, "dist", "index.html"),
    '<!doctype html><link href="./assets/app.css" rel="stylesheet">'
      + '<script type="module" src="./assets/app.js"></script>',
  );
  await writeFile(path.join(root, "dist", "assets", "app.css"), "body{}");
  await writeFile(path.join(root, "dist", "assets", "app.js"), "export {};");
  await writeFile(path.join(root, "dist", "preload.cjs"), "module.exports = {};");
}

test("desktop gate builds and validates production assets before serial tests", async (t) => {
  const root = await temporaryWindowsRoot(t);
  const calls = [];

  await runDesktopTestGate({
    windowsRoot: root,
    nodeCommand: "test-node",
    resolveNpm: async () => "/test/npm-cli.js",
    execute(command, arguments_, cwd) {
      calls.push({ command, arguments_, cwd });
      if (calls.length === 1) {
        assert.deepEqual(
          [command, ...arguments_],
          ["test-node", "/test/npm-cli.js", "run", "build"],
        );
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
      resolveNpm: async () => "/test/npm-cli.js",
      execute() {
        calls += 1;
      },
    }),
    { code: "ENOENT" },
  );
  assert.equal(calls, 1);
});

test("desktop gate fails before build or tests when the npm CLI is unavailable", async (t) => {
  const root = await temporaryWindowsRoot(t);
  let calls = 0;
  await assert.rejects(
    runDesktopTestGate({
      windowsRoot: root,
      resolveNpm: () => resolveNpmCli({}),
      execute() {
        calls += 1;
      },
    }),
    /must be launched by npm/u,
  );
  assert.equal(calls, 0);
});

test("npm CLI validation rejects relative, misnamed, missing, and empty inputs", async (t) => {
  const root = await temporaryWindowsRoot(t);
  const emptyCli = path.join(root, "npm-cli.js");
  const wrongName = path.join(root, "runner.js");
  await writeFile(emptyCli, "");
  await writeFile(wrongName, "export {};");

  await assert.rejects(resolveNpmCli({ npm_execpath: "npm-cli.js" }), /absolute/u);
  await assert.rejects(resolveNpmCli({ npm_execpath: wrongName }), /npm-cli\.js/u);
  await assert.rejects(
    resolveNpmCli({ npm_execpath: path.join(root, "missing", "npm-cli.js") }),
    /available npm CLI/u,
  );
  await assert.rejects(resolveNpmCli({ npm_execpath: emptyCli }), /nonempty/u);
});

test("npm build invocation is identical and shell-free on POSIX and Windows paths", () => {
  assert.deepEqual(
    createNpmBuildInvocation("/usr/bin/node", "/opt/npm/bin/npm-cli.js"),
    {
      command: "/usr/bin/node",
      arguments: ["/opt/npm/bin/npm-cli.js", "run", "build"],
    },
  );
  assert.deepEqual(
    createNpmBuildInvocation("C:\\Node\\node.exe", "C:\\npm\\npm-cli.js"),
    {
      command: "C:\\Node\\node.exe",
      arguments: ["C:\\npm\\npm-cli.js", "run", "build"],
    },
  );
});

test("validated npm CLI executes harmlessly through the current Node executable", async () => {
  const npmCli = await resolveNpmCli();
  const result = spawnSync(process.execPath, [npmCli, "--version"], {
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\d+\.\d+\.\d+\s*$/u);
});

const invalidBundles = [
  ["missing index", async (root) => {
    await writeProductionBundle(root);
    await rm(path.join(root, "dist", "index.html"));
  }],
  ["empty index", async (root) => {
    await writeProductionBundle(root);
    await writeFile(path.join(root, "dist", "index.html"), "");
  }],
  ["missing preload", async (root) => {
    await writeProductionBundle(root);
    await rm(path.join(root, "dist", "preload.cjs"));
  }],
  ["empty preload", async (root) => {
    await writeProductionBundle(root);
    await writeFile(path.join(root, "dist", "preload.cjs"), "");
  }],
  ["malformed index without references", async (root) => {
    await writeProductionBundle(root);
    await writeFile(path.join(root, "dist", "index.html"), "not a bundle");
  }],
  ["traversing reference", async (root) => {
    await writeProductionBundle(root);
    await writeFile(
      path.join(root, "dist", "index.html"),
      '<script src="../outside.js"></script><link href="assets/app.css">',
    );
  }],
  ["encoded traversing reference", async (root) => {
    await writeProductionBundle(root);
    await writeFile(
      path.join(root, "dist", "index.html"),
      '<script src="%2e%2e%2foutside.js"></script><link href="assets/app.css">',
    );
  }],
  ["backslash traversing reference", async (root) => {
    await writeProductionBundle(root);
    await writeFile(
      path.join(root, "dist", "index.html"),
      '<script src="..\\outside.js"></script><link href="assets/app.css">',
    );
  }],
  ["malformed encoded reference", async (root) => {
    await writeProductionBundle(root);
    await writeFile(
      path.join(root, "dist", "index.html"),
      '<script src="assets/%zz.js"></script><link href="assets/app.css">',
    );
  }],
  ["remote reference", async (root) => {
    await writeProductionBundle(root);
    await writeFile(
      path.join(root, "dist", "index.html"),
      '<script src="https://example.invalid/app.js"></script>'
        + '<link href="assets/app.css">',
    );
  }],
  ["missing referenced asset", async (root) => {
    await writeProductionBundle(root);
    await rm(path.join(root, "dist", "assets", "app.js"));
  }],
  ["empty referenced asset", async (root) => {
    await writeProductionBundle(root);
    await writeFile(path.join(root, "dist", "assets", "app.js"), "");
  }],
  ["missing JavaScript reference", async (root) => {
    await writeProductionBundle(root);
    await writeFile(
      path.join(root, "dist", "index.html"),
      '<link href="assets/app.css" rel="stylesheet">',
    );
  }],
  ["missing CSS reference", async (root) => {
    await writeProductionBundle(root);
    await writeFile(
      path.join(root, "dist", "index.html"),
      '<script src="assets/app.js"></script>',
    );
  }],
  ["empty assets directory", async (root) => {
    await writeProductionBundle(root);
    await rm(path.join(root, "dist", "assets"), { recursive: true });
    await mkdir(path.join(root, "dist", "assets"));
  }],
  ["missing assets directory", async (root) => {
    await writeProductionBundle(root);
    await rm(path.join(root, "dist", "assets"), { recursive: true });
  }],
  ["unreferenced output", async (root) => {
    await writeProductionBundle(root);
    await writeFile(path.join(root, "dist", "assets", "stale.js"), "stale");
  }],
  ["non-file asset output", async (root) => {
    await writeProductionBundle(root);
    await mkdir(path.join(root, "dist", "assets", "nested"));
  }],
];

for (const [name, arrange] of invalidBundles) {
  test(`bundle validation rejects ${name} and does not launch tests`, async (t) => {
    const root = await temporaryWindowsRoot(t);
    let calls = 0;
    await assert.rejects(
      runDesktopTestGate({
        windowsRoot: root,
        resolveNpm: async () => "/test/npm-cli.js",
        execute(command) {
          calls += 1;
          if (calls === 1) {
            return arrange(root);
          }
          assert.fail(`unexpected test launch through ${command}`);
        },
      }),
    );
    assert.equal(calls, 1);
  });
}

test("production bundle validation accepts a complete referenced bundle", async (t) => {
  const root = await temporaryWindowsRoot(t);
  await writeProductionBundle(root);
  await verifyProductionBundle(root);
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
