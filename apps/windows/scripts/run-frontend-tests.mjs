import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const windowsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(windowsRoot, "../..");
const defaultTestDirectories = [
  path.join(repositoryRoot, "packages/frontend-core/test"),
  path.join(repositoryRoot, "packages/react-ui/test"),
  path.join(windowsRoot, "test"),
];
if (process.argv.length !== 2 && (process.argv.length !== 4 || process.argv[2] !== "--test-root")) {
  throw new Error("Usage: run-frontend-tests.mjs [--test-root directory]");
}
const testDirectories = process.argv.length === 4
  ? [path.resolve(process.argv[3])]
  : defaultTestDirectories;

const tests = [];
async function collectTests(directory) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectTests(candidate);
    } else if (entry.isFile() && /\.test\.tsx?$/u.test(entry.name)) {
      tests.push(candidate);
    }
  }
}
for (const directory of testDirectories) {
  await collectTests(directory);
}
tests.sort();
if (tests.length === 0) {
  throw new Error("No frontend TypeScript tests were found.");
}

const loader = pathToFileURL(path.join(
  windowsRoot, "scripts/register-frontend-typescript.mjs")).href;
const result = spawnSync(process.execPath,
  ["--import", loader,
    "--test", "--test-concurrency=1", ...tests],
  { cwd: windowsRoot, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Frontend TypeScript tests exited with status ${result.status ?? "unknown"}.`);
}
