import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";

const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"],
  { encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
  throw new Error("Could not determine the source commit for this build");
}

export default defineConfig({ plugins: [react()], base: "./", build: { outDir: "dist" },
  define: { __SCPEFE_SOURCE_COMMIT__: JSON.stringify(sourceCommit) } });
