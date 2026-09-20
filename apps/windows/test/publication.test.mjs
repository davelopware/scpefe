import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PublicationService } from "../src/publication.mjs";
import { WorkJournalStore } from "../src/work-journal.mjs";

const documentId = "12".repeat(16);
const baseRevision = "34".repeat(32);
const key = Buffer.alloc(32, 0x5a);

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-publish-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  await fs.writeFile(target, "old container");
  const journals = new WorkJournalStore({ fs,
    directory: path.join(directory, "private") });
  return { directory, target, journals };
}

test("tracks every publication stage and clears only after verification", async (t) => {
  const { target, journals } = await fixture(t);
  const stages = [];
  const write = journals.write.bind(journals);
  journals.write = async (...args) => {
    stages.push(args[2].publication.stage);
    return write(...args);
  };
  const service = new PublicationService({ fs, journals, now: () => 42 });
  assert.deepEqual(service.replacementCapabilities(), {
    sameFilesystemTransaction: true,
    replacementGuarantee: "rename-without-compare-and-swap",
  });
  const result = await service.publish({ documentId, journalKey: key, target,
    base: Buffer.from("old container"), candidate: Buffer.from("new container"),
    text: "saved text", cursor: { start: 2, end: 2 }, baseRevision });
  assert.equal(result.replacementGuarantee, "rename-without-compare-and-swap");
  assert.deepEqual(stages,
    ["prepared", "written", "flushed", "replaced", "verified", "cleanup"]);
  assert.equal(await fs.readFile(target, "utf8"), "new container");
  assert.equal(await journals.read(documentId, key), null);
});

test("restart completes an unambiguous interrupted publication", async (t) => {
  const { target, journals } = await fixture(t);
  let failOnce = true;
  const interruptedFs = Object.create(fs);
  interruptedFs.rename = async (...args) => {
    if (failOnce) {
      failOnce = false;
      const error = new Error("simulated power loss");
      error.code = "EIO";
      throw error;
    }
    return fs.rename(...args);
  };
  const interrupted = new PublicationService({ fs: interruptedFs, journals });
  await assert.rejects(interrupted.publish({ documentId, journalKey: key, target,
    base: Buffer.from("old container"), candidate: Buffer.from("new container"),
    text: "saved text", cursor: { start: 0, end: 0 }, baseRevision }), /power loss/);
  const record = await journals.read(documentId, key);
  assert.equal(record.publication.stage, "flushed");
  assert.equal(await fs.readFile(record.publication.transactionFile, "utf8"),
    "new container");

  const restarted = new PublicationService({ fs, journals });
  assert.deepEqual(await restarted.resume(documentId, key, record),
    { completed: true, recovered: true,
      replacementGuarantee: "rename-without-compare-and-swap" });
  assert.equal(await fs.readFile(target, "utf8"), "new container");
  assert.equal(await journals.read(documentId, key), null);
});

test("restart preserves recovery data when the target changed", async (t) => {
  const { target, journals } = await fixture(t);
  const interruptedFs = Object.create(fs);
  interruptedFs.rename = async () => {
    const error = new Error("simulated interruption");
    error.code = "EIO";
    throw error;
  };
  const interrupted = new PublicationService({ fs: interruptedFs, journals });
  await assert.rejects(interrupted.publish({ documentId, journalKey: key, target,
    base: Buffer.from("old container"), candidate: Buffer.from("new container"),
    text: "saved text", cursor: { start: 0, end: 0 }, baseRevision }));
  const record = await journals.read(documentId, key);
  await fs.writeFile(target, "potentially newer container");

  const restarted = new PublicationService({ fs, journals });
  assert.deepEqual(await restarted.resume(documentId, key, record),
    { completed: false, reason: "ambiguous",
      replacementGuarantee: "rename-without-compare-and-swap" });
  assert.equal(await fs.readFile(target, "utf8"), "potentially newer container");
  assert.equal(await fs.readFile(record.publication.transactionFile, "utf8"),
    "new container");
  assert.ok((await journals.read(documentId, key)).publication);
});

test("restart preserves a candidate transaction when the target is missing", async (t) => {
  const { target, journals } = await fixture(t);
  const interruptedFs = Object.create(fs);
  interruptedFs.rename = async () => { throw new Error("interrupted"); };
  const interrupted = new PublicationService({ fs: interruptedFs, journals });
  await assert.rejects(interrupted.publish({ documentId, journalKey: key, target,
    base: Buffer.from("old container"), candidate: Buffer.from("new container"),
    text: "saved text", cursor: { start: 0, end: 0 }, baseRevision }));
  const record = await journals.read(documentId, key);
  await fs.unlink(target);
  const restarted = new PublicationService({ fs, journals });
  assert.deepEqual(await restarted.resume(documentId, key, record),
    { completed: false, reason: "ambiguous",
      replacementGuarantee: "rename-without-compare-and-swap" });
  assert.equal(await fs.readFile(record.publication.transactionFile, "utf8"),
    "new container");
});

test("restart never cleans up a tracked transaction with ambiguous bytes", async (t) => {
  const { target, journals } = await fixture(t);
  const interruptedFs = Object.create(fs);
  interruptedFs.rename = async () => { throw new Error("interrupted"); };
  const interrupted = new PublicationService({ fs: interruptedFs, journals });
  await assert.rejects(interrupted.publish({ documentId, journalKey: key, target,
    base: Buffer.from("old container"), candidate: Buffer.from("new container"),
    text: "saved text", cursor: { start: 0, end: 0 }, baseRevision }));
  const record = await journals.read(documentId, key);
  await fs.writeFile(target, "new container");
  await fs.writeFile(record.publication.transactionFile, "untracked newer bytes");

  const restarted = new PublicationService({ fs, journals });
  const result = await restarted.resume(documentId, key, record);
  assert.equal(result.reason, "ambiguous");
  assert.equal(await fs.readFile(record.publication.transactionFile, "utf8"),
    "untracked newer bytes");
  assert.ok((await journals.read(documentId, key)).publication);
});
