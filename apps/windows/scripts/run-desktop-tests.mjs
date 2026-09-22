import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WINDOWS_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");

function runChecked(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, { cwd, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}.`);
  }
}

/**
 * Confirms that the renderer and preload production bundles needed by mounted
 * desktop tests were produced by the immediately preceding build.
 */
export async function verifyProductionBundle(windowsRoot) {
  await Promise.all([
    access(path.join(windowsRoot, "dist", "index.html")),
    access(path.join(windowsRoot, "dist", "assets")),
    access(path.join(windowsRoot, "dist", "preload.cjs")),
  ]);
}

/** Returns the desktop test files in a stable order without shell globbing. */
export async function discoverDesktopTests(windowsRoot) {
  const testRoot = path.join(windowsRoot, "test");
  return (await readdir(testRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => path.join(testRoot, entry.name))
    .sort();
}

/** Builds fresh production assets, validates them, then runs Node tests serially. */
export async function runDesktopTestGate({
  windowsRoot = DEFAULT_WINDOWS_ROOT,
  execute = runChecked,
  verifyBundle = verifyProductionBundle,
  discoverTests = discoverDesktopTests,
  npmCommand = process.platform === "win32" ? "npm.cmd" : "npm",
  nodeCommand = process.execPath,
} = {}) {
  await execute(npmCommand, ["run", "build"], windowsRoot);
  await verifyBundle(windowsRoot);

  const testFiles = await discoverTests(windowsRoot);
  if (testFiles.length === 0) {
    throw new Error("No desktop test files were found.");
  }
  await execute(
    nodeCommand,
    ["--test", "--test-concurrency=1", ...testFiles],
    windowsRoot,
  );
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await runDesktopTestGate();
}
