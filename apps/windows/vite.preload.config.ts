import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: "src/preload-entry.mjs",
      formats: ["cjs"],
      fileName: () => "preload.cjs",
    },
    rollupOptions: { external: ["electron"] },
    minify: false,
  },
});
