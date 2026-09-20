import assert from "node:assert/strict";
import test from "node:test";
import { compactWithBackupSelection } from "../src/compaction-flow.mjs";

const confirmation = "confirmed warning text";

test("failed default backup can continue at a selected alternate destination",
  async () => {
    const calls = [];
    const service = {
      suggestedBackupTarget: () => "C:\\docs\\notes.backup-date.scpefe",
      async compactDocument(received, target) {
        calls.push({ received, target });
        if (target === undefined) {
          const error = new Error("default backup failed");
          error.code = "COMPACTION_BACKUP_FAILED";
          throw error;
        }
        return { compacted: true };
      },
    };
    const dialog = { async showSaveDialog(_window, options) {
      assert.equal(options.defaultPath,
        "C:\\docs\\notes.backup-date.scpefe");
      return { canceled: false, filePath: "D:\\safe\\notes.scpefe" };
    } };
    assert.deepEqual(await compactWithBackupSelection({ service, dialog,
      window: {}, confirmation }), { compacted: true });
    assert.deepEqual(calls, [
      { received: confirmation, target: undefined },
      { received: confirmation, target: "D:\\safe\\notes.scpefe" },
    ]);
  });

test("cancelled alternate backup selection cancels without retrying compaction",
  async () => {
    let calls = 0;
    const service = { suggestedBackupTarget: () => "/docs/default.scpefe",
      async compactDocument() {
        calls += 1;
        const error = new Error("default backup failed");
        error.code = "COMPACTION_BACKUP_FAILED";
        throw error;
      } };
    const dialog = { async showSaveDialog() { return { canceled: true }; } };
    assert.equal(await compactWithBackupSelection({ service, dialog,
      window: {}, confirmation }), null);
    assert.equal(calls, 1);
  });

test("non-backup compaction errors never prompt for another destination", async () => {
  let prompted = false;
  const service = { async compactDocument() { throw new Error("lease changed"); } };
  const dialog = { async showSaveDialog() { prompted = true; } };
  await assert.rejects(compactWithBackupSelection({ service, dialog,
    window: {}, confirmation }), /lease changed/);
  assert.equal(prompted, false);
});
