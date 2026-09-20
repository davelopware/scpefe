import assert from "node:assert/strict";
import test from "node:test";
import {
  compactWithBackupSelection,
  registerCompactionHandler,
} from "../src/compaction-flow.mjs";

const confirmation = "confirmed warning text";

function registeredBoundary(options) {
  let handler;
  registerCompactionHandler({
    ...options,
    ipcMain: {
      handle(channel, value) {
        assert.equal(channel, "document:compact");
        handler = value;
      },
    },
  });
  return handler;
}

test("trusted IPC confirmation gates default and alternate backup attempts",
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
    const dialog = { async showMessageBox(_window, options) {
      assert.equal(options.defaultId, 0);
      assert.equal(options.cancelId, 0);
      assert.match(options.message, /irreversible local history removal/);
      assert.match(options.detail, /external copies/);
      assert.match(options.detail, /exact backup replica/);
      return { response: 1 };
    }, async showSaveDialog(_window, options) {
      assert.equal(options.defaultPath,
        "C:\\docs\\notes.backup-date.scpefe");
      return { canceled: false, filePath: "D:\\safe\\notes.scpefe" };
    } };
    const invokeCompact = registeredBoundary({ service, dialog,
      window: {}, confirmation });
    assert.deepEqual(await invokeCompact(), { compacted: true });
    assert.deepEqual(calls, [
      { received: confirmation, target: undefined },
      { received: confirmation, target: "D:\\safe\\notes.scpefe" },
    ]);
  });

test("trusted IPC cancellation makes zero service and backup-selection calls",
  async () => {
    let serviceCalls = 0;
    let saveDialogs = 0;
    const service = { async compactDocument() { serviceCalls += 1; } };
    const dialog = { async showMessageBox() { return { response: 0 }; },
      async showSaveDialog() { saveDialogs += 1; } };
    const invokeCompact = registeredBoundary({ service, dialog,
      window: {}, confirmation });
    assert.equal(await invokeCompact(), null);
    assert.equal(serviceCalls, 0);
    assert.equal(saveDialogs, 0);
  });

test("trusted IPC confirmation makes exactly one default attempt on success",
  async () => {
    const calls = [];
    const service = { async compactDocument(received, target) {
      calls.push({ received, target });
      return { compacted: true };
    } };
    const dialog = { async showMessageBox() { return { response: 1 }; },
      async showSaveDialog() { throw new Error("must not select an alternate"); } };
    const invokeCompact = registeredBoundary({ service, dialog,
      window: {}, confirmation });
    assert.deepEqual(await invokeCompact(), { compacted: true });
    assert.deepEqual(calls, [{ received: confirmation, target: undefined }]);
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
