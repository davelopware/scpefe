import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DocumentService } from "../src/document-service.mjs";

function withLease(native) {
  let lease = { active: false, sessionId: "0".repeat(32), heartbeatCounter: 0,
    holderUtcMs: 0, durationMs: 600_000, holderName: "", holderEmail: "",
    deviceName: "" };
  return { ...native, currentLease: () => ({ ...lease }),
    openDocument(...args) { return { ...native.openDocument(...args), lease }; },
    updateLease(bytes, _password, value) {
      lease = { ...value };
      return Buffer.from(bytes);
    } };
}

async function writeProfile(directory, name, deviceName) {
  const profilePath = path.join(directory, `${name}-profile.json`);
  await fs.writeFile(profilePath, JSON.stringify({
    name, email: `${name.toLowerCase()}@example.test`, deviceName,
  }));
  return profilePath;
}

function delayNextTargetRead(service, target) {
  const readFile = service.fs.readFile.bind(service.fs);
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let started;
  const readStarted = new Promise((resolve) => { started = resolve; });
  let delayed = false;
  service.fs = { ...service.fs, async readFile(file, ...args) {
    if (!delayed && file === target) {
      delayed = true;
      started();
      await released;
    }
    return readFile(file, ...args);
  } };
  return { readStarted, release };
}

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
  const service = new DocumentService({ native: withLease(native), fs,
    profilePath: path.join(directory, "private", "profile.json") });
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
  assert.deepEqual(await service.enterEditMode(),
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
  await fs.writeFile(path.join(directory, "profile.json"), JSON.stringify({
    name: "Ada", email: "ada@example.test", deviceName: "Desk PC",
  }));
  const service = new DocumentService({ fs,
    profilePath: path.join(directory, "profile.json"),
    native: withLease({ openDocument: () => ({ content: "hello", readOnly: true,
      canEdit: false, documentId: "11".repeat(16),
      baseRevision: "22".repeat(32), journalKey: Buffer.alloc(32, 3) }) }) });
  await service.openDocument(target, "password words");
  await assert.rejects(service.enterEditMode(), /does not permit editing/);
});

test("checkpoints continuously typed work and recovers it as unsaved", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-journal-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  await fs.writeFile(target, "container");
  await fs.writeFile(path.join(directory, "profile.json"), JSON.stringify({
    name: "Ada", email: "ada@example.test", deviceName: "Desk PC",
  }));
  const native = { openDocument: () => ({ content: "base", readOnly: true,
    canEdit: true, documentId: "ab".repeat(16), baseRevision: "cd".repeat(32),
    journalKey: Buffer.alloc(32, 7) }) };
  let now = 0;
  const timers = [];
  const leasedNative = withLease(native);
  const service = new DocumentService({ native: leasedNative, fs,
    profilePath: path.join(directory, "profile.json"), now: () => now,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    }, clearTimer: (timer) => { timer.cleared = true; } });
  await service.openDocument(target, "password words");
  await service.enterEditMode();
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
  await service.exitEditMode();

  const restarted = new DocumentService({ native: leasedNative, fs,
    profilePath: path.join(directory, "profile.json") });
  const opened = await restarted.openDocument(target, "password words");
  assert.deepEqual(opened.recovery, { content: "recovered secret",
    cursor: { start: 3, end: 8 }, state: "unsaved", updateTime: 29_000 });
  await assert.rejects(restarted.enterEditMode(), /Restore or discard/);
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
  await fs.writeFile(path.join(directory, "profile.json"), JSON.stringify({
    name: "Ada", email: "ada@example.test", deviceName: "Desk PC",
  }));
  const service = new DocumentService({ fs,
    profilePath: path.join(directory, "profile.json"),
    native: withLease({ openDocument: () => ({ content: "base", readOnly: true,
      canEdit: true, documentId: "44".repeat(16), baseRevision: "55".repeat(32),
      journalKey: Buffer.alloc(32, 9) }) }) });
  await service.openDocument(target, "password words");
  await service.enterEditMode();
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
  const service = new DocumentService({ native: withLease(native), fs,
    profilePath: path.join(directory, "profile.json"),
    setTimer: (callback) => {
      const timer = { callback };
      timers.push(timer);
      return timer;
    }, clearTimer: () => {} });
  await service.openDocument(target, "password words");
  await service.enterEditMode();
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
  await saveVerified;
  const clearRanBeforeCheckpoint = clearStarted;
  releaseClear();
  if (clearRanBeforeCheckpoint) await journalCleared;
  releaseWrite();
  await saving;
  await service.flushChain;

  const journalPath = path.join(directory, "work-journals",
    `${"66".repeat(16)}.work-journal`);
  await assert.rejects(fs.readFile(journalPath), (error) => error.code === "ENOENT");
});

test("plaintext export writes only current text with selected line endings", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-export-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const lfExport = path.join(directory, "canonical.txt");
  const nativeExport = path.join(directory, "native.txt");
  await fs.writeFile(target, "encrypted container and metadata");
  const service = new DocumentService({ fs, nativeLineEnding: "\r\n",
    profilePath: path.join(directory, "profile.json"),
    native: withLease({ openDocument: () => ({ content: "original", readOnly: true,
      canEdit: false, documentId: "88".repeat(16),
      baseRevision: "99".repeat(32), journalKey: Buffer.alloc(32, 13) }) }) });
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

test("coordinates holders, heartbeats, lock suspension, resumption, and expiry", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-lease-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  await fs.writeFile(target, "container");
  const native = withLease({ openDocument: () => ({ content: "base", readOnly: true,
    canEdit: true, documentId: "aa".repeat(16), baseRevision: "bb".repeat(32),
    journalKey: Buffer.alloc(32, 4) }) });
  let utc = 1_000;
  let mono = 1_000;
  const timers = [];
  const first = new DocumentService({ native, fs,
    profilePath: await writeProfile(directory, "Ada", "Desk"),
    utcNow: () => utc, monotonicNow: () => mono,
    setTimer(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimer() {} });
  await first.openDocument(target, "password words");
  await first.enterEditMode();
  const acquired = native.currentLease();
  assert.equal(acquired.heartbeatCounter, 1);
  assert.equal(timers.some((timer) => timer.delay === 120_000), true);

  const second = new DocumentService({ native, fs,
    profilePath: await writeProfile(directory, "Grace", "Laptop"),
    utcNow: () => utc, monotonicNow: () => mono });
  const inspected = await second.openDocument(target, "password words");
  assert.equal(inspected.lease.holderName, "Ada");
  await assert.rejects(second.enterEditMode(), (error) => error.code === "LEASE_ACTIVE");

  utc += 120_000;
  const heartbeat = timers.filter((timer) => timer.delay === 120_000).at(-1);
  heartbeat.callback();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(native.currentLease().heartbeatCounter, 2);
  await first.lock("screen-lock");
  utc += 60_000;
  await first.openDocument(target, "password words");
  await first.enterEditMode();
  assert.equal(native.currentLease().sessionId, acquired.sessionId);

  await first.lock("screen-lock");
  utc += 600_001;
  await second.openDocument(target, "password words");
  await second.enterEditMode();
  assert.equal(native.currentLease().holderName, "Grace");
  assert.notEqual(native.currentLease().sessionId, acquired.sessionId);
});

test("uncertain clocks require observation or explicit forced confirmation", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-clock-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  await fs.writeFile(target, "container");
  const native = withLease({ openDocument: () => ({ content: "base", readOnly: true,
    canEdit: true, documentId: "cc".repeat(16), baseRevision: "dd".repeat(32),
    journalKey: Buffer.alloc(32, 5) }) });
  const holder = new DocumentService({ native, fs,
    profilePath: await writeProfile(directory, "Ada", "Wrong clock"),
    utcNow: () => 9_000_000, monotonicNow: () => 0 });
  await holder.openDocument(target, "password words");
  await holder.enterEditMode();

  let monotonic = 10;
  const observer = new DocumentService({ native, fs,
    profilePath: await writeProfile(directory, "Grace", "Observer"),
    utcNow: () => 1_000, monotonicNow: () => monotonic });
  await observer.openDocument(target, "password words");
  await assert.rejects(observer.enterEditMode(),
    (error) => error.code === "LEASE_CLOCK_UNCERTAIN");
  monotonic += 600_000;
  await observer.enterEditMode();
  assert.equal(native.currentLease().holderName, "Grace");
  await assert.rejects(holder.saveDocument("must not publish"),
    /lease is no longer held/);

  const forced = new DocumentService({ native, fs,
    profilePath: await writeProfile(directory, "Katherine", "Confirmed"),
    utcNow: () => 500, monotonicNow: () => 20 });
  await forced.openDocument(target, "password words");
  await forced.enterEditMode({ forceTakeover: true });
  assert.equal(native.currentLease().holderName, "Katherine");
});

test("serializes a delayed heartbeat ahead of save without overwriting it", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-lease-save-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  await fs.writeFile(target, "container");
  const native = withLease({
    openDocument(bytes) { return { content: bytes.toString().startsWith("saved:")
      ? bytes.toString().slice(6) : "base", readOnly: true, canEdit: true,
    documentId: "ee".repeat(16), baseRevision: "ff".repeat(32),
    journalKey: Buffer.alloc(32, 6) }; },
    saveDocument(_bytes, _password, input) { return Buffer.from(`saved:${input.content}`); },
  });
  const timers = [];
  const service = new DocumentService({ native, fs, inactivityMs: 999_999,
    profilePath: await writeProfile(directory, "Ada", "Desk"),
    setTimer(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimer() {} });
  await service.openDocument(target, "password words");
  await service.enterEditMode();
  const delayed = delayNextTargetRead(service, target);
  timers.find((timer) => timer.delay === 120_000).callback();
  await delayed.readStarted;
  let saveFinished = false;
  const saving = service.saveDocument("saved after heartbeat")
    .then((result) => { saveFinished = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saveFinished, false);
  delayed.release();
  assert.deepEqual(await saving, { saved: true, content: "saved after heartbeat" });
  assert.equal(await fs.readFile(target, "utf8"), "saved:saved after heartbeat");
  assert.equal(native.currentLease().heartbeatCounter, 2);
});

test("lock and release invalidate and await an in-flight heartbeat", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-lease-stop-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  await fs.writeFile(target, "container");
  const native = withLease({ openDocument: () => ({ content: "base", readOnly: true,
    canEdit: true, documentId: "12".repeat(16), baseRevision: "34".repeat(32),
    journalKey: Buffer.alloc(32, 7) }) });
  const timers = [];
  const service = new DocumentService({ native, fs, inactivityMs: 999_999,
    profilePath: await writeProfile(directory, "Ada", "Desk"),
    setTimer(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimer() {} });
  await service.openDocument(target, "password words");
  await service.enterEditMode();
  let delayed = delayNextTargetRead(service, target);
  timers.find((timer) => timer.delay === 120_000).callback();
  await delayed.readStarted;
  const locking = service.lock("screen-lock");
  const timersBeforeLock = timers.length;
  delayed.release();
  await locking;
  assert.equal(native.currentLease().heartbeatCounter, 1);
  assert.equal(timers.length, timersBeforeLock);

  await service.openDocument(target, "password words");
  await service.enterEditMode();
  const resumedCounter = native.currentLease().heartbeatCounter;
  delayed = delayNextTargetRead(service, target);
  timers.filter((timer) => timer.delay === 120_000).at(-1).callback();
  await delayed.readStarted;
  const releasing = service.exitEditMode();
  const timersBeforeRelease = timers.length;
  delayed.release();
  assert.deepEqual(await releasing, { released: true });
  assert.equal(native.currentLease().active, false);
  assert.equal(native.currentLease().heartbeatCounter, resumedCounter);
  assert.equal(timers.length, timersBeforeRelease);
});

test("resumes only an unchanged valid suspended lease and flags counter changes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-lease-resume-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  await fs.writeFile(target, "container");
  const native = withLease({ openDocument: () => ({ content: "base", readOnly: true,
    canEdit: true, documentId: "56".repeat(16), baseRevision: "78".repeat(32),
    journalKey: Buffer.alloc(32, 8) }) });
  let utc = 10_000;
  let sessions = 0;
  const service = new DocumentService({ native, fs, utcNow: () => utc,
    randomSessionId: () => Buffer.alloc(16, ++sessions),
    profilePath: await writeProfile(directory, "Ada", "Desk") });
  await service.openDocument(target, "password words");
  await service.enterEditMode();
  const firstSession = native.currentLease().sessionId;
  await service.lock("screen-lock");
  utc += 60_000;
  await service.openDocument(target, "password words");
  await service.enterEditMode();
  assert.equal(native.currentLease().sessionId, firstSession);

  await service.lock("screen-lock");
  const changed = { ...native.currentLease(), heartbeatCounter: 99 };
  native.updateLease(Buffer.from("container"), "password words", changed);
  await service.openDocument(target, "password words");
  await assert.rejects(service.enterEditMode(),
    (error) => error.code === "LEASE_CHANGED");

  native.updateLease(Buffer.from("container"), "password words",
    { ...changed, heartbeatCounter: 2 });
  utc += 600_001;
  await service.openDocument(target, "password words");
  await service.enterEditMode();
  assert.notEqual(native.currentLease().sessionId, firstSession);
  assert.equal(native.currentLease().heartbeatCounter, 1);
});
