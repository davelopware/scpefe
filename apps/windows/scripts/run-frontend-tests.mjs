import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const windowsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(windowsRoot, "../..");
const testDirectories = [
  path.join(repositoryRoot, "packages/frontend-core/test"),
  path.join(repositoryRoot, "packages/react-ui/test"),
  path.join(windowsRoot, "test"),
];

const tests = [];
for (const directory of testDirectories) {
  const entries = await readdir(directory, { withFileTypes: true });
  tests.push(...entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => path.join(directory, entry.name)));
}
tests.sort();
if (tests.length === 0) {
  throw new Error("No frontend TypeScript tests were found.");
}

const result = spawnSync(process.execPath,
  ["--experimental-strip-types", "--test", "--test-concurrency=1", ...tests],
  { cwd: windowsRoot, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Frontend TypeScript tests exited with status ${result.status ?? "unknown"}.`);
}
