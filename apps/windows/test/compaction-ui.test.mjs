import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { compactionAvailable,
  CompactionConfirmation } from "../src/compaction-controls.mjs";

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

test("rendered compaction confirmation is keyboard-native and screen-reader labelled",
  () => {
    const markup = renderToStaticMarkup(CompactionConfirmation({ open: true,
      onCancel() {}, onConfirm() {} }));
    assert.ok(markup.includes('role="alertdialog"'));
    assert.ok(markup.includes('aria-modal="true"'));
    assert.ok(markup.includes(
      'aria-labelledby="compaction-confirmation-title"'));
    assert.ok(markup.includes(
      'aria-describedby="compaction-confirmation-detail"'));
    assert.ok(markup.includes("irreversibly removes older history"));
    assert.ok(markup.includes("backups, sync tools, caches, or storage providers"));
    assert.ok(markup.includes("exact verified backup replica must be created first"));
    assert.ok(markup.includes("<button type=\"button\" autofocus=\"\">Cancel</button>"));
    assert.ok(markup.includes("Create backup and compact"));
  });

test("closed compaction confirmation renders nothing", () => {
  assert.equal(renderToStaticMarkup(CompactionConfirmation({ open: false,
    onCancel() {}, onConfirm() {} })), "");
});
