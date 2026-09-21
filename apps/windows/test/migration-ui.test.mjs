import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("older-container migration is an accessible explicit choice", async () => {
  const renderer = await fs.readFile(
    new URL("../src/renderer.tsx", import.meta.url), "utf8");
  assert.match(renderer, /result\.migrationRequired/);
  assert.match(renderer, /role="dialog"/);
  assert.match(renderer, /Create verified backup and migrate…/);
  assert.match(renderer, /Keep read-only/);
  assert.match(renderer, /Migration is required before editing/);
  assert.match(renderer, /readOnly=\{!active \|\| opened\.readOnly\}/);
  assert.doesNotMatch(renderer, /onClick=\{[^}]+\}<div[^>]+role="button"/);
});
