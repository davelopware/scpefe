import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkJournalStore } from "../src/work-journal.mjs";

test("encrypts and authenticates one journal per document", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new WorkJournalStore({ fs, directory });
  const documentId = "12".repeat(16);
  const key = Buffer.alloc(32, 0x5a);
  const record = { text: "unsaved private text", baseRevision: "34".repeat(32),
    cursor: { start: 2, end: 7 }, target: "C:\\private\\document.scpefe",
    state: "unsaved", updateTime: 12345 };
  await store.write(documentId, key, record);
  const bytes = await fs.readFile(path.join(directory, `${documentId}.work-journal`));
  assert.equal(bytes.includes(Buffer.from(record.text)), false);
  assert.equal(bytes.includes(Buffer.from(record.target)), false);
  assert.deepEqual(await store.read(documentId, key), record);
  await assert.rejects(store.read(documentId, Buffer.alloc(32, 1)));
  await store.clear(documentId);
  assert.equal(await store.read(documentId, key), null);
});
