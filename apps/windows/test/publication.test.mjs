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
const capabilities = Object.freeze({ sameFilesystemTransaction: true,
  replacementGuarantee: "atomic-replace" });

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-publish-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  await fs.writeFile(target, "old container");
  const journals = new WorkJournalStore({ fs,
    directory: path.join(directory, "private") });
  return { directory, target, journals };
}

test("validates and surfaces host replacement capabilities", async (t) => {
  const { journals } = await fixture(t);
  const weaker = Object.freeze({ sameFilesystemTransaction: true,
    replacementGuarantee: "best-effort-replace" });
  const service = new PublicationService({ fs, journals, capabilities: weaker });
  assert.deepEqual(service.replacementCapabilities(), weaker);
  assert.throws(() => new PublicationService({ fs, journals }), /capabilities/);
  assert.throws(() => new PublicationService({ fs, journals, capabilities: {
    sameFilesystemTransaction: false, replacementGuarantee: "atomic-replace",
  } }), /capabilities/);
  assert.throws(() => new PublicationService({ fs, journals, capabilities: {
    sameFilesystemTransaction: true, replacementGuarantee: "guaranteed-cloud-cas",
  } }), /capabilities/);
});

test("tracks every publication stage and clears only after verification", async (t) => {
  const { target, journals } = await fixture(t);
  const stages = [];
  const write = journals.write.bind(journals);
  journals.write = async (...args) => {
    stages.push(args[2].publication.stage);
    return write(...args);
  };
  const service = new PublicationService({ fs, journals, capabilities, now: () => 42 });
  assert.deepEqual(service.replacementCapabilities(), {
    sameFilesystemTransaction: true,
    replacementGuarantee: "atomic-replace",
  });
  const result = await service.publish({ documentId, journalKey: key, target,
    base: Buffer.from("old container"), candidate: Buffer.from("new container"),
    text: "saved text", cursor: { start: 2, end: 2 }, baseRevision });
  assert.deepEqual(result.replacementCapabilities, capabilities);
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
  const interrupted = new PublicationService({ fs: interruptedFs, journals, capabilities });
  await assert.rejects(interrupted.publish({ documentId, journalKey: key, target,
    base: Buffer.from("old container"), candidate: Buffer.from("new container"),
    text: "saved text", cursor: { start: 0, end: 0 }, baseRevision }), /power loss/);
  const record = await journals.read(documentId, key);
  assert.equal(record.publication.stage, "flushed");
  assert.equal(await fs.readFile(record.publication.transactionFile, "utf8"),
    "new container");

  const restarted = new PublicationService({ fs, journals, capabilities });
  assert.deepEqual(await restarted.resume(documentId, key, record),
    { completed: true, recovered: true, replacementCapabilities: capabilities });
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
  const interrupted = new PublicationService({ fs: interruptedFs, journals, capabilities });
  await assert.rejects(interrupted.publish({ documentId, journalKey: key, target,
    base: Buffer.from("old container"), candidate: Buffer.from("new container"),
    text: "saved text", cursor: { start: 0, end: 0 }, baseRevision }));
  const record = await journals.read(documentId, key);
  await fs.writeFile(target, "potentially newer container");

  const restarted = new PublicationService({ fs, journals, capabilities });
  assert.deepEqual(await restarted.resume(documentId, key, record),
    { completed: false, reason: "ambiguous", replacementCapabilities: capabilities });
  assert.equal(await fs.readFile(target, "utf8"), "potentially newer container");
  assert.equal(await fs.readFile(record.publication.transactionFile, "utf8"),
    "new container");
  assert.ok((await journals.read(documentId, key)).publication);
});

test("restart preserves a candidate transaction when the target is missing", async (t) => {
  const { target, journals } = await fixture(t);
  const interruptedFs = Object.create(fs);
  interruptedFs.rename = async () => { throw new Error("interrupted"); };
  const interrupted = new PublicationService({ fs: interruptedFs, journals, capabilities });
  await assert.rejects(interrupted.publish({ documentId, journalKey: key, target,
    base: Buffer.from("old container"), candidate: Buffer.from("new container"),
    text: "saved text", cursor: { start: 0, end: 0 }, baseRevision }));
  const record = await journals.read(documentId, key);
  await fs.unlink(target);
  const restarted = new PublicationService({ fs, journals, capabilities });
  assert.deepEqual(await restarted.resume(documentId, key, record),
    { completed: false, reason: "ambiguous", replacementCapabilities: capabilities });
  assert.equal(await fs.readFile(record.publication.transactionFile, "utf8"),
    "new container");
});

test("restart never cleans up a tracked transaction with ambiguous bytes", async (t) => {
  const { target, journals } = await fixture(t);
  const interruptedFs = Object.create(fs);
  interruptedFs.rename = async () => { throw new Error("interrupted"); };
  const interrupted = new PublicationService({ fs: interruptedFs, journals, capabilities });
  await assert.rejects(interrupted.publish({ documentId, journalKey: key, target,
    base: Buffer.from("old container"), candidate: Buffer.from("new container"),
    text: "saved text", cursor: { start: 0, end: 0 }, baseRevision }));
  const record = await journals.read(documentId, key);
  await fs.writeFile(target, "new container");
  await fs.writeFile(record.publication.transactionFile, "untracked newer bytes");

  const restarted = new PublicationService({ fs, journals, capabilities });
  const result = await restarted.resume(documentId, key, record);
  assert.equal(result.reason, "ambiguous");
  assert.equal(await fs.readFile(record.publication.transactionFile, "utf8"),
    "untracked newer bytes");
  assert.ok((await journals.read(documentId, key)).publication);
});

test("backup publication is create-only, flushed, and byte-identical", async (t) => {
  const { directory, journals } = await fixture(t);
  const target = path.join(directory, "document.backup-20260920T010203Z.scpefe");
  await fs.writeFile(target, "existing backup");
  await fs.writeFile(target.replace(/\.scpefe$/, "-1.scpefe"), "another backup");
  const calls = [];
  const observedFs = Object.create(fs);
  observedFs.link = async (...args) => {
    calls.push(["publish", args[1]]);
    return fs.link(...args);
  };
  observedFs.open = async (...args) => {
    const handle = await fs.open(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => { calls.push(["flush", args[0]]); return sync(); };
    return handle;
  };
  observedFs.readFile = async (...args) => {
    calls.push(["verify", args[0]]);
    return fs.readFile(...args);
  };
  const candidate = Buffer.from([0, 255, 17, 31, 128, 64]);
  const service = new PublicationService({ fs: observedFs, journals, capabilities });
  assert.deepEqual(await service.publishReplica({ target, candidate }),
    { completed: true });
  const created = target.replace(/\.scpefe$/, "-2.scpefe");
  assert.deepEqual(await fs.readFile(created), candidate);
  assert.equal(await fs.readFile(target, "utf8"), "existing backup");
  assert.equal(await fs.readFile(target.replace(/\.scpefe$/, "-1.scpefe"), "utf8"),
    "another backup");
  assert.ok(calls.findIndex(([kind, name]) => kind === "publish" && name === created)
    < calls.findIndex(([kind, name]) => kind === "flush" && name === created));
  assert.ok(calls.findIndex(([kind, name]) => kind === "flush" && name === created)
    < calls.findIndex(([kind, name]) => kind === "verify" && name === created));
});

test("backup publication never succeeds after interruption or failed verification", async (t) => {
  const { directory, journals } = await fixture(t);
  const target = path.join(directory, "document.backup-20260920T010203Z.scpefe");
  const interruptedFs = Object.create(fs);
  interruptedFs.link = async () => { throw new Error("simulated interruption"); };
  const interrupted = new PublicationService({ fs: interruptedFs, journals, capabilities });
  await assert.rejects(interrupted.publishReplica({
    target, candidate: Buffer.from("exact container"),
  }), /interruption/);
  await assert.rejects(fs.readFile(target), (error) => error.code === "ENOENT");

  await fs.writeFile(target, "pre-existing backup");
  const created = target.replace(/\.scpefe$/, "-1.scpefe");
  const tamperedFs = Object.create(fs);
  tamperedFs.readFile = async (file, ...args) => {
    if (file === created) await fs.writeFile(file, "tampered container");
    return fs.readFile(file, ...args);
  };
  const tampered = new PublicationService({ fs: tamperedFs, journals, capabilities });
  await assert.rejects(tampered.publishReplica({
    target, candidate: Buffer.from("exact container"),
  }), /verification failed/);
  assert.equal(await fs.readFile(target, "utf8"), "pre-existing backup");
  await assert.rejects(fs.readFile(created), (error) => error.code === "ENOENT");
});

test("failed backup verification preserves a raced replacement", async (t) => {
  const { directory, journals } = await fixture(t);
  const target = path.join(directory, "document.backup-20260920T010203Z.scpefe");
  const raced = Buffer.from("raced replacement");
  let replaced = false;
  const racedFs = Object.create(fs);
  racedFs.readFile = async (file, ...args) => {
    if (file === target && !replaced) {
      replaced = true;
      await fs.unlink(target);
      await fs.writeFile(target, raced);
      return Buffer.from("tampered verification bytes");
    }
    return fs.readFile(file, ...args);
  };
  const service = new PublicationService({ fs: racedFs, journals, capabilities });
  await assert.rejects(service.publishReplica({
    target, candidate: Buffer.from("exact container"),
  }), /verification failed/);
  assert.deepEqual(await fs.readFile(target), raced);
  assert.deepEqual((await fs.readdir(directory)).filter((name) =>
    name.includes("scpefe-backup-txn")), []);
});
