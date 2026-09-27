import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";

export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !/\.tsx?$/u.test(url)) {
    return nextLoad(url, context);
  }
  const source = await readFile(new URL(url), "utf8");
  const result = await transformWithOxc(source, fileURLToPath(url), {
    sourceType: "module",
  });
  return { format: "module", source: result.code, shortCircuit: true };
}
