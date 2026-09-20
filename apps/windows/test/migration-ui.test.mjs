import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("older-container migration is an accessible explicit choice", async () => {
  const renderer = await fs.readFile(
    new URL("../src/renderer.tsx", import.meta.url), "utf8");
  assert.match(renderer, /if \(opened\?\.migrationRequired\)/);
  assert.match(renderer, /role="alert"/);
  assert.match(renderer, /Create verified backup and migrate…/);
  assert.match(renderer, /Keep read-only and close/);
  assert.match(renderer, /later save will still require migration/);
  assert.match(renderer, /<textarea aria-label="Document text"[^>]+readOnly/);
  assert.doesNotMatch(renderer, /onClick=\{[^}]+\}<div[^>]+role="button"/);
});
