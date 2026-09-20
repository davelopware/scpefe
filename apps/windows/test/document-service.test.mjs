import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DocumentService } from "../src/document-service.mjs";

const publicationCapabilities = Object.freeze({ sameFilesystemTransaction: true,
  replacementGuarantee: "atomic-replace" });

test("requires a profile, publishes once, verifies, and reopens read-only", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-desktop-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  const native = {
    createDocument(input) {
      calls.push(input);
      return Buffer.from("self-contained encrypted container");
    },
    openDocument(bytes, password) {
      assert.ok(bytes.toString() === "self-contained encrypted container"
        || bytes.toString().startsWith("saved:"));
      assert.equal(password, "owner password words");
      return { content: bytes.toString().startsWith("saved:")
        ? bytes.toString().slice(6) : "hello", readOnly: true, canEdit: true,
      documentId: "11".repeat(16), baseRevision: "22".repeat(32),
      journalKey: Buffer.alloc(32, 3), ignored: "not exposed" };
    },
    saveDocument(bytes, password, input) {
      assert.equal(bytes.toString(), "self-contained encrypted container");
      assert.equal(password, "owner password words");
      assert.equal(input.name, "Ada");
      assert.equal(input.deviceName, "Desk PC");
      return Buffer.from(`saved:${input.content}`);
    },
  };
  const service = new DocumentService({ native, fs, publicationCapabilities,
    profilePath: path.join(directory, "private", "profile.json") });
  assert.deepEqual(service.publicationCapabilities(), publicationCapabilities);
  const target = path.join(directory, "document.scpefe");
  const request = { ownerPassword: "owner password words", recoveryPassword: "",
    content: "hello", understandsIrrecoverable: true,
    storedRecoverySeparately: false };
  await assert.rejects(service.createDocument(target, request), /Configure/);
  await service.saveProfile({ name: "Ada", email: "ada@example.test",
    deviceName: "Desk PC" });
  assert.deepEqual(await service.createDocument(target, request), { created: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(await service.openDocument(target, "owner password words"),
    { content: "hello", readOnly: true, canEdit: true });
  await assert.rejects(service.saveDocument("changed"), /Enter edit mode/);
  assert.deepEqual(service.enterEditMode(),
    { content: "hello", readOnly: false, canEdit: true });
  assert.deepEqual(await service.saveDocument("\ufeff hello \r\n"),
    { saved: true, content: " hello \n" });
  assert.equal((await fs.readFile(target)).toString(), "saved: hello \n");
  await assert.rejects(service.createDocument(target, request),
    (error) => error.code === "EEXIST");
});

test("view-only slots cannot enter edit mode", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-desktop-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  await fs.writeFile(target, "container");
  const service = new DocumentService({ fs, publicationCapabilities,
    profilePath: path.join(directory, "profile.json"),
    native: { openDocument: () => ({ content: "hello", readOnly: true,
      canEdit: false, documentId: "11".repeat(16),
      baseRevision: "22".repeat(32), journalKey: Buffer.alloc(32, 3) }) } });
  await service.openDocument(target, "password words");
  assert.throws(() => service.enterEditMode(), /does not permit editing/);
});

test("checkpoints continuously typed work and recovers it as unsaved", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-journal-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  await fs.writeFile(target, "container");
  const native = { openDocument: () => ({ content: "base", readOnly: true,
    canEdit: true, documentId: "ab".repeat(16), baseRevision: "cd".repeat(32),
    journalKey: Buffer.alloc(32, 7) }) };
  let now = 0;
  const timers = [];
  const service = new DocumentService({ native, fs, publicationCapabilities,
    profilePath: path.join(directory, "profile.json"), now: () => now,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    }, clearTimer: (timer) => { timer.cleared = true; } });
  await service.openDocument(target, "password words");
  service.enterEditMode();
  service.updateWorkingCopy({ content: "first", cursor: { start: 5, end: 5 } });
  assert.equal(timers.at(-2).delay, 10_000);
  now = 9_000;
  service.updateWorkingCopy({ content: "second", cursor: { start: 6, end: 6 } });
  now = 29_000;
  service.updateWorkingCopy({ content: "recovered secret", cursor: { start: 3, end: 8 } });
  const checkpoint = timers.at(-2);
  assert.equal(checkpoint.delay, 1_000);
  checkpoint.callback();
  await service.flushChain;
  const journalPath = path.join(directory, "work-journals",
    `${"ab".repeat(16)}.work-journal`);
  const encrypted = await fs.readFile(journalPath, "utf8");
  assert.doesNotMatch(encrypted, /recovered secret|document\.scpefe/);

  const restarted = new DocumentService({ native, fs, publicationCapabilities,
    profilePath: path.join(directory, "profile.json") });
  const opened = await restarted.openDocument(target, "password words");
  assert.deepEqual(opened.recovery, { content: "recovered secret",
    cursor: { start: 3, end: 8 }, state: "unsaved", updateTime: 29_000 });
  assert.throws(() => restarted.enterEditMode(), /Restore or discard/);
  const restored = await restarted.restoreRecoveredWork();
  assert.equal(restored.content, "recovered secret");
  assert.equal(restored.recoveredUnsaved, true);
  await restarted.lock();
});

test("mandatory locking clears plaintext when the final journal write fails", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-lock-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  await fs.writeFile(target, "container");
  const service = new DocumentService({ fs, publicationCapabilities,
    profilePath: path.join(directory, "profile.json"),
    native: { openDocument: () => ({ content: "base", readOnly: true,
      canEdit: true, documentId: "44".repeat(16), baseRevision: "55".repeat(32),
      journalKey: Buffer.alloc(32, 9) }) } });
  await service.openDocument(target, "password words");
  service.enterEditMode();
  service.updateWorkingCopy({ content: "must disappear",
    cursor: { start: 14, end: 14 } });
  service.journals.write = async () => { throw new Error("disk full"); };
  const result = await service.lock("screen-lock");
  assert.equal(result.locked, true);
  assert.equal(result.journalSaved, false);
  assert.match(result.warning, /disk full/);
  assert.equal(service.active, null);
});

test("verified save waits for an in-flight checkpoint before clearing its journal", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-save-race-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  await fs.writeFile(target, "container");
  await fs.writeFile(path.join(directory, "profile.json"), JSON.stringify({
    name: "Ada", email: "ada@example.test", deviceName: "Desk PC",
  }));
  let openCount = 0;
  let verifiedSave;
  const saveVerified = new Promise((resolve) => { verifiedSave = resolve; });
  const native = {
    openDocument(bytes) {
      openCount += 1;
      if (openCount === 2) verifiedSave();
      return { content: bytes.toString().startsWith("saved:")
        ? bytes.toString().slice(6) : "base", readOnly: true, canEdit: true,
      documentId: "66".repeat(16), baseRevision: "77".repeat(32),
      journalKey: Buffer.alloc(32, 11) };
    },
    saveDocument(_bytes, _password, input) {
      return Buffer.from(`saved:${input.content}`);
    },
  };
  const timers = [];
  const service = new DocumentService({ native, fs, publicationCapabilities,
    profilePath: path.join(directory, "profile.json"),
    setTimer: (callback) => {
      const timer = { callback };
      timers.push(timer);
      return timer;
    }, clearTimer: () => {} });
  await service.openDocument(target, "password words");
  service.enterEditMode();
  service.updateWorkingCopy({ content: "stale unsaved work",
    cursor: { start: 18, end: 18 } });

  const write = service.journals.write.bind(service.journals);
  let releaseWrite;
  const writeReleased = new Promise((resolve) => { releaseWrite = resolve; });
  let writeStarted;
  const checkpointStarted = new Promise((resolve) => { writeStarted = resolve; });
  service.journals.write = async (...args) => {
    writeStarted();
    await writeReleased;
    return write(...args);
  };
  const clear = service.journals.clear.bind(service.journals);
  let releaseClear;
  const clearReleased = new Promise((resolve) => { releaseClear = resolve; });
  let clearStarted = false;
  let clearFinished;
  const journalCleared = new Promise((resolve) => { clearFinished = resolve; });
  service.journals.clear = async (...args) => {
    clearStarted = true;
    await clearReleased;
    await clear(...args);
    clearFinished();
  };
  timers.at(-2).callback();
  await checkpointStarted;

  const saving = service.saveDocument("saved work");
  const clearRanBeforeCheckpoint = clearStarted;
  releaseWrite();
  releaseClear();
  if (clearRanBeforeCheckpoint) await journalCleared;
  await saveVerified;
  await saving;
  await service.flushChain;

  const journalPath = path.join(directory, "work-journals",
    `${"66".repeat(16)}.work-journal`);
  await assert.rejects(fs.readFile(journalPath), (error) => error.code === "ENOENT");
});

test("restart completes a tracked save while lock preserves its publication", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-restart-save-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(target, "container");
  await fs.writeFile(profilePath, JSON.stringify({
    name: "Ada", email: "ada@example.test", deviceName: "Desk PC",
  }));
  let saveCalls = 0;
  const native = {
    openDocument(bytes) {
      return { content: bytes.toString().startsWith("saved:")
        ? bytes.toString().slice(6) : "base", readOnly: true, canEdit: true,
      documentId: "aa".repeat(16), baseRevision: "bb".repeat(32),
      journalKey: Buffer.alloc(32, 19) };
    },
    saveDocument(_bytes, _password, input) {
      saveCalls += 1;
      return Buffer.from(`saved:${input.content}`);
    },
  };
  let interrupt = true;
  const interruptedFs = Object.create(fs);
  interruptedFs.rename = async (source, destination) => {
    if (interrupt && source.includes(".scpefe-txn-")) {
      interrupt = false;
      throw new Error("simulated interruption");
    }
    return fs.rename(source, destination);
  };
  const service = new DocumentService({ native, fs: interruptedFs, profilePath,
    publicationCapabilities });
  await service.openDocument(target, "password words");
  service.enterEditMode();
  service.updateWorkingCopy({ content: "saved after restart",
    cursor: { start: 19, end: 19 } });
  await assert.rejects(service.saveDocument("saved after restart"), /interruption/);
  const pending = await service.journals.read("aa".repeat(16), Buffer.alloc(32, 19));
  await assert.rejects(async () => service.updateWorkingCopy({
    content: "must not replace candidate", cursor: { start: 3, end: 3 },
  }), /interrupted publication/);
  await assert.rejects(service.saveDocument("must not replace candidate"),
    /interrupted publication/);
  assert.equal(saveCalls, 1);
  await service.lock();
  const afterLock = await service.journals.read("aa".repeat(16), Buffer.alloc(32, 19));
  assert.equal(afterLock.publication.id, pending.publication.id);
  assert.equal(afterLock.publication.candidateHash, pending.publication.candidateHash);
  assert.equal(afterLock.publication.candidate, pending.publication.candidate);

  const warnings = [];
  const restarted = new DocumentService({ native, fs, profilePath, publicationCapabilities,
    onJournalWarning: (warning) => warnings.push(warning) });
  const opened = await restarted.openDocument(target, "password words");
  assert.equal(opened.content, "saved after restart");
  assert.deepEqual(warnings,
    ["Interrupted publication was completed and verified."]);
  assert.equal(await fs.readFile(target, "utf8"), "saved:saved after restart");
  await restarted.lock();
});

test("a persisted prepare with a lost acknowledgement survives lock and restart", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-prepare-ack-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(target, "container");
  await fs.writeFile(profilePath, JSON.stringify({
    name: "Ada", email: "ada@example.test", deviceName: "Desk PC",
  }));
  const native = {
    openDocument: (bytes) => ({ content: bytes.toString().startsWith("saved:")
      ? bytes.toString().slice(6) : "base", readOnly: true, canEdit: true,
    documentId: "ac".repeat(16), baseRevision: "bd".repeat(32),
    journalKey: Buffer.alloc(32, 21) }),
    saveDocument: (_bytes, _password, input) => Buffer.from(`saved:${input.content}`),
  };
  const service = new DocumentService({ native, fs, profilePath,
    publicationCapabilities });
  await service.openDocument(target, "password words");
  service.enterEditMode();
  service.updateWorkingCopy({ content: "durable candidate",
    cursor: { start: 17, end: 17 } });
  const write = service.journals.write.bind(service.journals);
  let loseAcknowledgement = true;
  service.journals.write = async (...args) => {
    await write(...args);
    if (loseAcknowledgement) {
      loseAcknowledgement = false;
      throw new Error("journal acknowledgement lost");
    }
  };
  await assert.rejects(service.saveDocument("durable candidate"),
    /acknowledgement lost/);
  await service.lock();
  const pending = await service.journals.read("ac".repeat(16), Buffer.alloc(32, 21));
  assert.equal(pending.state, "pending-publication");
  assert.equal(pending.publication.stage, "prepared");

  const restarted = new DocumentService({ native, fs, profilePath,
    publicationCapabilities });
  const opened = await restarted.openDocument(target, "password words");
  assert.equal(opened.content, "durable candidate");
  assert.equal(await restarted.journals.read("ac".repeat(16), Buffer.alloc(32, 21)), null);
  await restarted.lock();
});

test("plaintext export writes only current text with selected line endings", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-export-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const lfExport = path.join(directory, "canonical.txt");
  const nativeExport = path.join(directory, "native.txt");
  await fs.writeFile(target, "encrypted container and metadata");
  const service = new DocumentService({ fs, nativeLineEnding: "\r\n",
    publicationCapabilities,
    profilePath: path.join(directory, "profile.json"),
    native: { openDocument: () => ({ content: "original", readOnly: true,
      canEdit: false, documentId: "88".repeat(16),
      baseRevision: "99".repeat(32), journalKey: Buffer.alloc(32, 13) }) } });
  await assert.rejects(service.exportPlaintext(lfExport, {
    content: "secret", lineEndings: "lf",
  }), /Open a document/);
  await service.openDocument(target, "password words");
  assert.deepEqual(await service.exportPlaintext(lfExport, {
    content: " first \nsecond\n", lineEndings: "lf",
  }), { exported: true });
  assert.equal(await fs.readFile(lfExport, "utf8"), " first \nsecond\n");
  await service.exportPlaintext(nativeExport, {
    content: " first \nsecond", lineEndings: "native",
  });
  assert.equal(await fs.readFile(nativeExport, "utf8"), " first \r\nsecond");
  await service.lock();
});
