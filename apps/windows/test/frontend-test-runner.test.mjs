import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const windowsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(windowsRoot, "../..");
const runner = path.join(windowsRoot, "scripts/run-frontend-tests.mjs");

test("frontend gate discovers nested TSX and reports an individual failure", async () => {
  const fixtureRoot = await mkdtemp(path.join(repositoryRoot, "node_modules/.frontend-runner-"));
  try {
    const nestedRoot = path.join(fixtureRoot, "nested");
    const marker = path.join(fixtureRoot, "executed");
    await mkdir(nestedRoot);
    await writeFile(path.join(nestedRoot, "nested.test.tsx"), `
      import assert from "node:assert/strict";
      import { writeFileSync } from "node:fs";
      import test from "node:test";
      import { renderToStaticMarkup } from "react-dom/server";

      test("nested TSX executes", () => {
        writeFileSync(process.env.FRONTEND_RUNNER_MARKER, "ran");
        assert.equal(renderToStaticMarkup(<span>ready</span>), "<span>ready</span>");
        assert.notEqual(process.env.FRONTEND_TEST_FAILURE, "1");
      });
    `);

    const run = (failure) => {
      const environment = { ...process.env, FRONTEND_TEST_FAILURE: failure ? "1" : "0",
        FRONTEND_RUNNER_MARKER: marker };
      delete environment.NODE_TEST_CONTEXT;
      return spawnSync(process.execPath, [runner, "--test-root", fixtureRoot], {
        cwd: windowsRoot,
        encoding: "utf8",
        env: environment,
      });
    };

    const passing = run(false);
    assert.equal(passing.status, 0, passing.stderr);
    assert.equal(existsSync(marker), true);
    assert.equal(await readFile(marker, "utf8"), "ran");
    const failing = run(true);
    assert.notEqual(failing.status, 0);
    assert.match(failing.stdout, /not ok 1 - nested TSX executes/u);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
