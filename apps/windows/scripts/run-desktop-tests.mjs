import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WINDOWS_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");

export function runChecked(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, { cwd, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}.`);
  }
}

/** Resolves npm's JavaScript CLI without relying on shell command lookup. */
export async function resolveNpmCli(environment = process.env) {
  const npmCli = environment.npm_execpath;
  if (typeof npmCli !== "string" || npmCli.length === 0) {
    throw new Error(
      "The desktop test gate must be launched by npm so npm_execpath is available.",
    );
  }
  if (!path.isAbsolute(npmCli) || path.basename(npmCli).toLowerCase() !== "npm-cli.js") {
    throw new Error("npm_execpath must identify an absolute npm-cli.js file.");
  }
  let metadata;
  try {
    metadata = await lstat(npmCli);
  } catch {
    throw new Error("npm_execpath does not identify an available npm CLI file.");
  }
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error("npm_execpath does not identify a nonempty npm CLI file.");
  }
  return npmCli;
}

/** Constructs the shell-free Node invocation used to run npm on every host. */
export function createNpmBuildInvocation(nodeCommand, npmCli) {
  return {
    command: nodeCommand,
    arguments: [npmCli, "run", "build"],
  };
}

async function requireNonemptyFile(file, description) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`${description} must be a nonempty regular file.`);
  }
}

function parseBundleReferences(indexHtml) {
  const references = [];
  const attribute = /\b(?:src|href)\s*=\s*(["'])([^"']+)\1/giu;
  for (const match of indexHtml.matchAll(attribute)) {
    references.push(match[2]);
  }
  return references;
}

function resolveConfinedReference(distRoot, reference) {
  if (
    reference.startsWith("/")
    || reference.startsWith("\\")
    || /^[a-z][a-z\d+.-]*:/iu.test(reference)
  ) {
    throw new Error("Renderer bundle references must be relative to dist.");
  }
  let decoded;
  try {
    decoded = decodeURIComponent(reference.split(/[?#]/u, 1)[0]);
  } catch {
    throw new Error("Renderer bundle contains a malformed asset reference.");
  }
  const portableReference = decoded.replace(/[\\/]/gu, path.sep);
  const resolved = path.resolve(distRoot, portableReference);
  const relative = path.relative(distRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Renderer bundle reference escapes dist.");
  }
  return { resolved, relative: relative.split(path.sep).join("/") };
}

/**
 * Confirms that the renderer and preload production bundles needed by mounted
 * desktop tests were produced by the immediately preceding build.
 */
export async function verifyProductionBundle(windowsRoot) {
  const distRoot = path.join(windowsRoot, "dist");
  const indexFile = path.join(distRoot, "index.html");
  const preloadFile = path.join(distRoot, "preload.cjs");
  await requireNonemptyFile(indexFile, "Renderer index");
  await requireNonemptyFile(preloadFile, "Preload bundle");

  const indexHtml = await readFile(indexFile, "utf8");
  const references = parseBundleReferences(indexHtml);
  if (references.length === 0) {
    throw new Error("Renderer index contains no asset references.");
  }

  const referencedAssets = new Set();
  let hasJavaScript = false;
  let hasStylesheet = false;
  for (const reference of references) {
    const { resolved, relative } = resolveConfinedReference(distRoot, reference);
    await requireNonemptyFile(resolved, "Referenced renderer asset");
    if (relative.startsWith("assets/")) {
      referencedAssets.add(relative);
      hasJavaScript ||= relative.endsWith(".js");
      hasStylesheet ||= relative.endsWith(".css");
    }
  }
  if (!hasJavaScript || !hasStylesheet) {
    throw new Error("Renderer index must reference nonempty JavaScript and CSS assets.");
  }

  const assetsRoot = path.join(distRoot, "assets");
  const assetEntries = await readdir(assetsRoot, { withFileTypes: true });
  if (assetEntries.length === 0) {
    throw new Error("Renderer assets directory must not be empty.");
  }
  for (const entry of assetEntries) {
    if (!entry.isFile()) {
      throw new Error("Renderer assets directory may contain only regular files.");
    }
    const relative = `assets/${entry.name}`;
    await requireNonemptyFile(path.join(assetsRoot, entry.name), "Renderer asset");
    if (!referencedAssets.has(relative)) {
      throw new Error("Renderer assets directory contains an unreferenced output.");
    }
  }
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
  resolveNpm = resolveNpmCli,
  nodeCommand = process.execPath,
} = {}) {
  const npmCli = await resolveNpm();
  const build = createNpmBuildInvocation(nodeCommand, npmCli);
  await execute(build.command, build.arguments, windowsRoot);
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
