import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("compaction is an explicit full-administrator action with irreversible-copy warnings",
  async () => {
    const [renderer, main] = await Promise.all([
      fs.readFile(new URL("../src/renderer.tsx", import.meta.url), "utf8"),
      fs.readFile(new URL("../src/main.mjs", import.meta.url), "utf8"),
    ]);
    assert.match(renderer,
      /canAddPasswords.*canRemovePasswords.*Compact history…/s);
    assert.match(renderer,
      /permanently removes older embedded history.*cannot remove external copies/s);
    assert.match(main, /Compaction irreversibly removes older history/);
    assert.match(main,
      /cannot delete historical copies held by backups, sync tools, caches, or storage providers/);
    assert.match(main, /Create backup and compact/);
  });
