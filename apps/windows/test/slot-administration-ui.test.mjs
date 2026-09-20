import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("slot administration exposes labelled keyboard controls and revocation limits", async () => {
  const renderer = await fs.readFile(
    new URL("../src/renderer.tsx", import.meta.url), "utf8");
  assert.match(renderer,
    /aria-labelledby="slot-administration-heading"/);
  assert.match(renderer, /<ul className="managed-slots">/);
  assert.match(renderer, /<fieldset disabled={!canUpdate}>/);
  assert.match(renderer, /Password administration always implies edit permission/);
  assert.match(renderer,
    /Enter edit mode to publish permission changes or remove a slot/);
  assert.match(renderer, /Publish permission changes/);
  assert.match(renderer, /Remove this password slot…/);
  assert.match(renderer, /role="alert"/);
  assert.match(renderer, /Confirm slot removal/);
  assert.match(renderer,
    /cannot revoke plaintext, keys already obtained, or older replicas/);
  assert.match(renderer,
    /permanent owner remains a full administrator and cannot be demoted or removed/);
  assert.doesNotMatch(renderer, /onClick=\{[^}]+\}<div[^>]+role="button"/);
});
