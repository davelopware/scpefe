import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { compactionAvailable,
  CompactionControls } from "../src/compaction-controls.mjs";

test("compaction is presented only to a full administrator in edit mode", () => {
  assert.equal(compactionAvailable({ readOnly: false,
    canAddPasswords: true, canRemovePasswords: true }), true);
  assert.equal(compactionAvailable({ readOnly: true,
    canAddPasswords: true, canRemovePasswords: true }), false);
  assert.equal(compactionAvailable({ readOnly: false,
    canAddPasswords: true, canRemovePasswords: false }), false);
  assert.equal(compactionAvailable({ readOnly: false,
    canAddPasswords: false, canRemovePasswords: true }), false);
});

test("rendered compaction action is keyboard-native and warning-labelled",
  () => {
    const markup = renderToStaticMarkup(CompactionControls({
      async onCompact() {},
    }));
    assert.ok(markup.includes(
      'aria-describedby="compaction-action-warning"'));
    assert.ok(markup.includes("permanently removes older embedded history"));
    assert.ok(markup.includes("backups, sync tools, caches, or storage providers"));
    assert.ok(markup.includes("after creating an exact verified backup"));
    assert.ok(markup.includes("<button type=\"button\""));
    assert.ok(markup.includes("Compact history…"));
    assert.equal(markup.includes('role="alertdialog"'), false);
    assert.equal(markup.includes('aria-modal="true"'), false);
  });
