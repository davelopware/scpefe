import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DocumentService } from "../src/document-service.mjs";

const publicationCapabilities = Object.freeze({ sameFilesystemTransaction: true,
  replacementGuarantee: "atomic-replace" });

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
    publicationCapabilities,
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
    { content: "hello", readOnly: true, canEdit: true,
      publicationState: "target-published" });
  await assert.rejects(service.saveDocument("changed"), /Enter edit mode/);
  assert.deepEqual(await service.enterEditMode(),
    { content: "hello", readOnly: false, canEdit: true,
      publicationState: "target-published" });
  assert.deepEqual(await service.saveDocument("\ufeff hello \r\n"),
    { saved: true, content: " hello \n", publicationState: "target-published" });
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
  const service = new DocumentService({ fs, publicationCapabilities,
    profilePath: path.join(directory, "profile.json"),
    native: withLease({ openDocument: () => ({ content: "hello", readOnly: true,
      canEdit: false, documentId: "11".repeat(16),
      baseRevision: "22".repeat(32), journalKey: Buffer.alloc(32, 3) }) }) });
  await service.openDocument(target, "password words");
  await assert.rejects(service.enterEditMode(), /does not permit editing/);
});

test("view-only slots create exact backups without changing the active target", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-backup-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "notes.scpefe");
  const bytes = Buffer.from([0, 255, 1, 2, 128, 64]);
  await fs.writeFile(target, bytes);
  const service = new DocumentService({ fs, publicationCapabilities,
    profilePath: path.join(directory, "profile.json"),
    now: () => Date.UTC(2026, 8, 20, 1, 2, 3),
    native: { openDocument: () => ({ content: "hello", readOnly: true,
      canEdit: false, documentId: "31".repeat(16),
      baseRevision: "42".repeat(32), journalKey: Buffer.alloc(32, 5) }) } });
  await service.openDocument(target, "password words");
  const suggested = path.join(directory, "notes.backup-20260920T010203Z.scpefe");
  assert.equal(service.suggestedBackupTarget(), suggested);
  assert.deepEqual(await service.backupDocument(suggested), { backedUp: true });
  assert.deepEqual(await fs.readFile(suggested), bytes);
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.equal(service.active.target, target);
  assert.equal(service.active.opened.canEdit, false);
});

test("backup requires clean, manually sealed state", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-backup-gates-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "notes.scpefe");
  const backup = path.join(directory, "notes.backup-20260920T010203Z.scpefe");
  await fs.writeFile(target, "container");
  const service = new DocumentService({ fs, publicationCapabilities,
    profilePath: path.join(directory, "profile.json"),
    native: { openDocument: () => ({ content: "hello", readOnly: true,
      canEdit: true, manuallySealed: false, documentId: "51".repeat(16),
      baseRevision: "62".repeat(32), journalKey: Buffer.alloc(32, 7) }) } });
  await service.openDocument(target, "password words");
  await assert.rejects(service.backupDocument(backup), /Manually save/);
  service.active.manuallySealed = true;
  service.active.dirty = true;
  await assert.rejects(service.backupDocument(backup), /Save or discard/);
  service.active.dirty = false;
  service.active.pendingPublication = true;
  await assert.rejects(service.backupDocument(backup), /Save or discard/);
  await assert.rejects(fs.readFile(backup), (error) => error.code === "ENOENT");
});

test("reopened authenticated journal states block backup", async (t) => {
  for (const [index, state] of ["unsaved", "pending-publication", "conflict"].entries()) {
    await t.test(state, async (t) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(),
        `scpefe-backup-journal-${state}-`));
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      const target = path.join(directory, "notes.scpefe");
      const backup = path.join(directory, "notes.backup.scpefe");
      const documentId = `${70 + index}`.repeat(16);
      const baseRevision = `${80 + index}`.repeat(32);
      const journalKey = Buffer.alloc(32, 20 + index);
      await fs.writeFile(target, "container");
      const options = { fs, publicationCapabilities,
        profilePath: path.join(directory, "profile.json"),
        native: { openDocument: () => ({ content: "hello", readOnly: true,
          canEdit: false, manuallySealed: true, documentId, baseRevision,
          journalKey: Buffer.from(journalKey) }) } };
      const writer = new DocumentService(options);
      await writer.journals.write(documentId, journalKey, {
        text: "durable local work", baseRevision, cursor: { start: 0, end: 0 },
        target, state, updateTime: 42,
      });

      const reopened = new DocumentService(options);
      await reopened.openDocument(target, "password words");
      await assert.rejects(reopened.backupDocument(backup), /Save or discard/);
      await assert.rejects(fs.readFile(backup), (error) => error.code === "ENOENT");
    });
  }
});

test("unclaimed invitations expose only the claim workflow", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-invite-open-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = await writeProfile(directory, "Grace", "Private PC");
  await fs.writeFile(target, "container");
  const native = { openDocument: () => ({
    content: "", readOnly: true, canEdit: false, canAddPasswords: false,
    mustBeChanged: true, slotIdentityName: "Temporary colleague label",
    slotIdentityEmail: "invited@example.test", profileName: "Document author",
    profileEmail: "author@example.test", deviceName: "Author device",
    documentId: "11".repeat(16), baseRevision: "22".repeat(32),
    revisionGraph: [{ revisionId: "22".repeat(32), parentRevisionIds: [] }],
    journalKey: Buffer.alloc(32, 3), lease: { active: true,
      sessionId: "12".repeat(16), heartbeatCounter: 4, holderUtcMs: 1,
      durationMs: 600_000, holderName: "Lease holder",
      holderEmail: "holder@example.test", deviceName: "Lease device" },
  }) };
  const service = new DocumentService({ native, fs, profilePath,
    publicationCapabilities });

  const opened = await service.openDocument(target, "temporary password words");

  assert.deepEqual(opened, { readOnly: true, invitationRequired: true });
  assert.deepEqual(Object.keys(opened).sort(), ["invitationRequired", "readOnly"]);
});

test("restart finishes an interrupted invitation claim with its replacement credential",
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-claim-restart-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const target = path.join(directory, "document.scpefe");
    const profilePath = await writeProfile(directory, "Grace", "Private PC");
    await fs.writeFile(target, "invited");
    const temporary = "temporary invitation password";
    const replacement = "private replacement password";
    const common = { readOnly: true, documentId: "31".repeat(16),
      baseRevision: "42".repeat(32) };
    const native = {
      openDocument(bytes, password) {
        if (bytes.toString() === "invited" && password === temporary) {
          return { ...common, journalKey: Buffer.alloc(32, 7),
            content: "", canEdit: false,
            canAddPasswords: false, mustBeChanged: true };
        }
        if (bytes.toString() === "claimed" && password === replacement) {
          return { ...common, journalKey: Buffer.alloc(32, 7),
            content: "secret", canEdit: true,
            canAddPasswords: false, mustBeChanged: false };
        }
        throw new Error("authentication failed");
      },
      claimInvitation(bytes, password, request) {
        assert.equal(bytes.toString(), "invited");
        assert.equal(password, temporary);
        assert.equal(request.newPassword, replacement);
        return Buffer.from("claimed");
      },
    };
    const first = new DocumentService({ native, fs, profilePath,
      publicationCapabilities });
    await first.openDocument(target, temporary);
    const write = first.journals.write.bind(first.journals);
    first.journals.write = async (...args) => {
      await write(...args);
      if (args[2]?.publication?.stage === "replaced") {
        throw new Error("simulated interruption after replacement");
      }
    };

    await assert.rejects(first.claimInvitation(replacement), /simulated interruption/);
    assert.equal(await fs.readFile(target, "utf8"), "claimed");
    const journalBytes = await fs.readFile(path.join(directory, "work-journals",
      `${"31".repeat(16)}.work-journal`));
    assert.equal(journalBytes.includes(Buffer.from(replacement)), false);

    const warnings = [];
    const restarted = new DocumentService({ native, fs, profilePath,
      publicationCapabilities,
      onJournalWarning: (warning) => warnings.push(warning) });
    const opened = await restarted.openDocument(target, temporary);
    assert.equal(opened.content, "secret");
    assert.notEqual(opened.invitationRequired, true);
    assert.equal(restarted.active.password, replacement);
    assert.deepEqual(warnings,
      ["Interrupted publication was completed and verified."]);
  });

test("claim cleanup is restart-safe at every removal boundary", async (t) => {
  for (const fault of ["before-transaction", "after-transaction",
    "before-journal", "after-journal", "before-sidecar", "after-sidecar"]) {
    await t.test(fault, async (t) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-cleanup-"));
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      const target = path.join(directory, "document.scpefe");
      const profilePath = await writeProfile(directory, "Grace", "Private PC");
      await fs.writeFile(target, "invited");
      const temporary = "temporary invitation password";
      const replacement = "private replacement password";
      const documentId = "51".repeat(16);
      const journalKey = Buffer.alloc(32, 9);
      const common = { readOnly: true, documentId,
        baseRevision: "62".repeat(32) };
      const native = {
        openDocument(bytes, password) {
          if (bytes.toString() === "invited" && password === temporary) {
            return { ...common, journalKey: Buffer.from(journalKey), content: "",
              canEdit: false, canAddPasswords: false, mustBeChanged: true };
          }
          if (bytes.toString() === "claimed" && password === replacement) {
            return { ...common, journalKey: Buffer.from(journalKey), content: "secret",
              canEdit: true, canAddPasswords: false, mustBeChanged: false };
          }
          throw new Error("authentication failed");
        },
        claimInvitation: () => Buffer.from("claimed"),
      };
      const first = new DocumentService({ native, fs, profilePath,
        publicationCapabilities });
      await first.openDocument(target, temporary);
      const write = first.journals.write.bind(first.journals);
      first.journals.write = async (...args) => {
        await write(...args);
        if (args[2]?.publication?.stage === "replaced") {
          throw new Error("simulated process loss after target replacement");
        }
      };
      await assert.rejects(first.claimInvitation(replacement), /process loss/);
      const record = await first.journals.read(documentId, journalKey);
      if (fault.endsWith("transaction")) {
        await fs.writeFile(record.publication.transactionFile, "claimed");
      }

      let injected = false;
      const faultFs = Object.create(fs);
      faultFs.unlink = async (file) => {
        const transactionFault = fault.endsWith("transaction")
          && file === record.publication.transactionFile;
        const sidecarFault = fault.endsWith("sidecar")
          && file === record.publication.baseFile;
        if (!injected && (transactionFault || sidecarFault)) {
          injected = true;
          if (fault.startsWith("after")) await fs.unlink(file);
          throw new Error(`simulated ${fault} cleanup fault`);
        }
        return fs.unlink(file);
      };
      const interrupted = new DocumentService({ native, fs: faultFs, profilePath,
        publicationCapabilities });
      if (fault.endsWith("journal")) {
        const clear = interrupted.journals.clear.bind(interrupted.journals);
        interrupted.journals.clear = async (...args) => {
          if (!injected) {
            injected = true;
            if (fault.startsWith("after")) await clear(...args);
            throw new Error(`simulated ${fault} cleanup fault`);
          }
          return clear(...args);
        };
      }
      const interruptedOpen = await interrupted.openDocument(target, replacement);
      assert.equal(interruptedOpen.content, "secret");
      assert.equal(injected, true);

      const clean = new DocumentService({ native, fs, profilePath,
        publicationCapabilities });
      const opened = await clean.openDocument(target, replacement);
      assert.equal(opened.content, "secret");
      assert.throws(() => native.openDocument(Buffer.from("claimed"), temporary),
        /authentication failed/);
      assert.equal(await clean.journals.read(documentId, journalKey), null);
      await assert.rejects(fs.readFile(record.publication.baseFile),
        (error) => error.code === "ENOENT");
      await assert.rejects(fs.readFile(record.publication.transactionFile),
        (error) => error.code === "ENOENT");

      await clean.publications.publish({ documentId, journalKey, target,
        base: Buffer.from("claimed"), candidate: Buffer.from("future"),
        text: "", cursor: { start: 0, end: 0 },
        baseRevision: common.baseRevision });
      assert.equal(await fs.readFile(target, "utf8"), "future");
    });
  }
});

test("generates a one-time invitation secret and publishes it under the held lease", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-invite-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = await writeProfile(directory, "Ada", "Desk PC");
  await fs.writeFile(target, "base");
  const sessionId = "12".repeat(16);
  let received;
  const opened = () => ({ content: "secret", readOnly: true, canEdit: true,
    canAddPasswords: true, mustBeChanged: false, slotIdentityName: "",
    slotIdentityEmail: "", documentId: "11".repeat(16),
    baseRevision: "22".repeat(32), revisionGraph: [{ revisionId: "22".repeat(32),
      parentRevisionIds: [] }], journalKey: Buffer.alloc(32, 3),
    lease: { active: true, sessionId, heartbeatCounter: 4, holderUtcMs: 1,
      durationMs: 600_000, holderName: "Ada", holderEmail: "ada@example.test",
      deviceName: "Desk PC" } });
  const native = { openDocument: opened,
    addInvitation(_bytes, password, request) {
      assert.equal(password, "owner password words"); received = request;
      return Buffer.from("candidate");
    } };
  const service = new DocumentService({ native, fs, profilePath,
    publicationCapabilities });
  service.active = { target, password: "owner password words", opened: opened(),
    editMode: true, documentId: "11".repeat(16), baseRevision: "22".repeat(32),
    journalKey: Buffer.alloc(32, 3), leaseSessionId: Buffer.from(sessionId, "hex"),
    leaseCounter: 4 };
  const result = await service.createInvitation({ temporaryLabel: "New colleague",
    canEdit: true });
  assert.equal(result.created, true);
  assert.equal(result.temporaryPassword.length, 32);
  assert.equal(received.temporaryPassword, result.temporaryPassword);
  assert.equal(received.temporaryLabel, "New colleague");
  assert.doesNotMatch(JSON.stringify(service.active),
    new RegExp(result.temporaryPassword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal((await fs.readFile(target)).toString(), "candidate");
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
    publicationCapabilities,
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
    publicationCapabilities,
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
  const service = new DocumentService({ fs, publicationCapabilities,
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
    publicationCapabilities,
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
  let interrupt = false;
  const interruptedFs = Object.create(fs);
  interruptedFs.rename = async (source, destination) => {
    if (interrupt && source.includes(".scpefe-txn-")) {
      interrupt = false;
      throw new Error("simulated interruption");
    }
    return fs.rename(source, destination);
  };
  const leasedNative = withLease(native);
  const service = new DocumentService({ native: leasedNative, fs: interruptedFs,
    profilePath, publicationCapabilities });
  await service.openDocument(target, "password words");
  await service.enterEditMode();
  interrupt = true;
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
  const restarted = new DocumentService({ native: leasedNative, fs, profilePath,
    publicationCapabilities,
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
  const leasedNative = withLease(native);
  const service = new DocumentService({ native: leasedNative, fs, profilePath,
    publicationCapabilities });
  await service.openDocument(target, "password words");
  await service.enterEditMode();
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

  const restarted = new DocumentService({ native: leasedNative, fs, profilePath,
    publicationCapabilities });
  const opened = await restarted.openDocument(target, "password words");
  assert.equal(opened.content, "durable candidate");
  assert.equal(await restarted.journals.read("ac".repeat(16), Buffer.alloc(32, 21)), null);
  await restarted.lock();
});

test("an unavailable target leaves an exact candidate pending and reconnect publishes it", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-offline-save-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(target, "container");
  await fs.writeFile(profilePath, JSON.stringify({
    name: "Ada", email: "ada@example.test", deviceName: "Desk PC",
  }));
  let unavailable = false;
  const removableFs = Object.create(fs);
  removableFs.readFile = async (file, ...args) => {
    if (unavailable && file === target) {
      const error = new Error("target disconnected");
      error.code = "ENOENT";
      throw error;
    }
    return fs.readFile(file, ...args);
  };
  const native = {
    openDocument: (bytes) => ({ content: bytes.toString().startsWith("saved:")
      ? bytes.toString().slice(6) : "base", readOnly: true, canEdit: true,
    documentId: "da".repeat(16), baseRevision: "db".repeat(32),
    journalKey: Buffer.alloc(32, 25) }),
    saveDocument: (_bytes, _password, input) => Buffer.from(`saved:${input.content}`),
  };
  const leasedNative = withLease(native);
  const service = new DocumentService({ native: leasedNative, fs: removableFs, profilePath,
    publicationCapabilities });
  await service.openDocument(target, "password words");
  await service.enterEditMode();
  unavailable = true;
  assert.deepEqual(await service.saveDocument("locally saved"), {
    saved: true, content: "locally saved", publicationState: "pending-publication",
  });
  const pending = await service.journals.read("da".repeat(16), Buffer.alloc(32, 25));
  assert.equal(Buffer.from(pending.publication.candidate, "base64").toString(),
    "saved:locally saved");
  assert.equal(await fs.readFile(target, "utf8"), "container");
  unavailable = false;
  assert.deepEqual(await service.reconnectPendingPublication(), {
    publicationState: "target-published", content: "locally saved",
  });
  assert.equal(await fs.readFile(target, "utf8"), "saved:locally saved");
});

test("pending publication survives restart and a changed target enters divergence", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-offline-restart-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(target, "container");
  await fs.writeFile(profilePath, JSON.stringify({
    name: "Ada", email: "ada@example.test", deviceName: "Desk PC",
  }));
  let unavailable = false;
  const removableFs = Object.create(fs);
  removableFs.readFile = async (file, ...args) => {
    if (unavailable && file === target) {
      const error = new Error("target disconnected"); error.code = "EIO"; throw error;
    }
    return fs.readFile(file, ...args);
  };
  const native = {
    openDocument: (bytes) => ({ content: bytes.toString().startsWith("saved:")
      ? bytes.toString().slice(6) : bytes.toString() === "changed" ? "remote" : "base",
    readOnly: true, canEdit: true, documentId: "ea".repeat(16),
    baseRevision: "eb".repeat(32), journalKey: Buffer.alloc(32, 27) }),
    saveDocument: (_bytes, _password, input) => Buffer.from(`saved:${input.content}`),
  };
  const leasedNative = withLease(native);
  const service = new DocumentService({ native: leasedNative, fs: removableFs, profilePath,
    publicationCapabilities });
  await service.openDocument(target, "password words");
  await service.enterEditMode();
  unavailable = true;
  await service.saveDocument("saved candidate");
  await service.lock();
  unavailable = false;
  await fs.writeFile(target, "changed");

  const restarted = new DocumentService({ native: leasedNative, fs, profilePath,
    publicationCapabilities });
  const opened = await restarted.openDocument(target, "password words");
  assert.equal(opened.content, "saved candidate");
  assert.equal(opened.publicationState, "conflict");
  assert.equal(await fs.readFile(target, "utf8"), "changed");
  const conflict = await restarted.journals.read(
    "ea".repeat(16), Buffer.alloc(32, 27));
  assert.equal(conflict.state, "conflict");
  assert.equal(Buffer.from(conflict.publication.candidate, "base64").toString(),
    "saved:saved candidate");
});

test("tampered publication bytes never overwrite the target and can be discarded", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-offline-tamper-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(target, "container");
  await fs.writeFile(profilePath, JSON.stringify({
    name: "Ada", email: "ada@example.test", deviceName: "Desk PC",
  }));
  let unavailable = false;
  const removableFs = Object.create(fs);
  removableFs.readFile = async (file, ...args) => {
    if (unavailable && file === target) {
      const error = new Error("missing"); error.code = "ENOENT"; throw error;
    }
    return fs.readFile(file, ...args);
  };
  const native = {
    openDocument: (bytes) => ({ content: bytes.toString().startsWith("saved:")
      ? bytes.toString().slice(6) : "base", readOnly: true, canEdit: true,
    documentId: "fa".repeat(16), baseRevision: "fb".repeat(32),
    journalKey: Buffer.alloc(32, 29) }),
    saveDocument: (_bytes, _password, input) => Buffer.from(`saved:${input.content}`),
  };
  const leasedNative = withLease(native);
  const service = new DocumentService({ native: leasedNative, fs: removableFs, profilePath,
    publicationCapabilities });
  await service.openDocument(target, "password words");
  await service.enterEditMode();
  unavailable = true;
  await service.saveDocument("exact candidate");
  const pending = await service.journals.read("fa".repeat(16), Buffer.alloc(32, 29));
  await fs.writeFile(pending.publication.transactionFile, "tampered transaction");
  unavailable = false;
  assert.deepEqual(await service.reconnectPendingPublication(), {
    publicationState: "pending-publication", content: "exact candidate",
  });
  assert.equal(await fs.readFile(target, "utf8"), "container");
  const discarded = await service.discardPendingPublication();
  assert.equal(discarded.publicationState, "target-published");
  assert.equal(discarded.content, "base");
  assert.equal(await fs.readFile(pending.publication.transactionFile, "utf8"),
    "tampered transaction");
});

test("restart exposes a pending candidate while its target remains unavailable", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-pending-bootstrap-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(target, "container");
  await fs.writeFile(profilePath, JSON.stringify({
    name: "Ada", email: "ada@example.test", deviceName: "Desk PC",
  }));
  let unavailable = false;
  let targetWrites = 0;
  const removableFs = Object.create(fs);
  removableFs.readFile = async (file, ...args) => {
    if (unavailable && file === target) {
      const error = new Error("disconnected"); error.code = "ENODEV"; throw error;
    }
    return fs.readFile(file, ...args);
  };
  removableFs.rename = async (source, destination) => {
    if (destination === target) targetWrites += 1;
    return fs.rename(source, destination);
  };
  const native = {
    openDocument: (bytes) => ({ content: bytes.toString().startsWith("saved:")
      ? bytes.toString().slice(6) : "base", readOnly: true, canEdit: true,
    documentId: "bc".repeat(16), baseRevision: "bd".repeat(32),
    journalKey: Buffer.alloc(32, 31) }),
    saveDocument: (_bytes, _password, input) => Buffer.from(`saved:${input.content}`),
  };
  const leasedNative = withLease(native);
  const service = new DocumentService({ native: leasedNative, fs: removableFs, profilePath,
    publicationCapabilities });
  await service.openDocument(target, "password words");
  await service.enterEditMode();
  unavailable = true;
  await service.saveDocument("survives disconnected restart");
  await service.lock();
  targetWrites = 0;

  const restarted = new DocumentService({ native: leasedNative, fs: removableFs, profilePath,
    publicationCapabilities });
  const opened = await restarted.openDocument(target, "password words");
  assert.equal(opened.publicationState, "pending-publication");
  assert.equal(opened.content, "survives disconnected restart");
  assert.equal(targetWrites, 0);
  const pending = await restarted.journals.read(
    "bc".repeat(16), Buffer.alloc(32, 31));
  assert.equal(Buffer.from(pending.publication.candidate, "base64").toString(),
    "saved:survives disconnected restart");

  assert.deepEqual(await restarted.reconnectPendingPublication(), {
    publicationState: "pending-publication", content: "survives disconnected restart",
  });
  assert.equal(targetWrites, 0);
  unavailable = false;
  assert.equal((await restarted.reconnectPendingPublication()).publicationState,
    "target-published");
  assert.equal(targetWrites, 1);
});

test("restart can discard a pending candidate while its provider remains unavailable", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-pending-discard-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(target, "container");
  await fs.writeFile(profilePath, JSON.stringify({
    name: "Ada", email: "ada@example.test", deviceName: "Desk PC",
  }));
  let unavailable = false;
  let targetWrites = 0;
  const removableFs = Object.create(fs);
  removableFs.readFile = async (file, ...args) => {
    const name = path.basename(String(file));
    if (unavailable && path.dirname(String(file)) === directory
        && (name === path.basename(target)
          || name.startsWith(`.${path.basename(target)}.scpefe-txn-`))) {
      const error = new Error("provider disconnected"); error.code = "ENODEV"; throw error;
    }
    return fs.readFile(file, ...args);
  };
  removableFs.unlink = async (file) => {
    if (unavailable && path.dirname(String(file)) === directory) {
      const error = new Error("provider disconnected"); error.code = "EIO"; throw error;
    }
    return fs.unlink(file);
  };
  removableFs.rename = async (source, destination) => {
    if (destination === target) targetWrites += 1;
    return fs.rename(source, destination);
  };
  const native = {
    openDocument: (bytes) => ({ content: bytes.toString().startsWith("saved:")
      ? bytes.toString().slice(6) : "base", readOnly: true, canEdit: true,
    documentId: "be".repeat(16), baseRevision: "bf".repeat(32),
    journalKey: Buffer.alloc(32, 35) }),
    saveDocument: (_bytes, _password, input) => Buffer.from(`saved:${input.content}`),
  };
  const leasedNative = withLease(native);
  const service = new DocumentService({ native: leasedNative, fs: removableFs, profilePath,
    publicationCapabilities });
  await service.openDocument(target, "password words");
  await service.enterEditMode();
  unavailable = true;
  await service.saveDocument("discard while disconnected");
  await service.lock();
  targetWrites = 0;

  const restarted = new DocumentService({ native: leasedNative, fs: removableFs, profilePath,
    publicationCapabilities });
  const opened = await restarted.openDocument(target, "password words");
  assert.equal(opened.publicationState, "pending-publication");
  const discarded = await restarted.discardPendingPublication();
  assert.equal(discarded.publicationState, "target-published");
  assert.equal(discarded.content, "base");
  assert.equal(targetWrites, 0);
  assert.equal(await restarted.journals.read(
    "be".repeat(16), Buffer.alloc(32, 35)), null);
  assert.equal(await fs.readFile(target, "utf8"), "container");
});

test("replacement and unauthenticated targets become conflicts without target writes", async (t) => {
  for (const replacement of ["other-document", "tampered-container"]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-target-replaced-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const target = path.join(directory, "document.scpefe");
    const profilePath = path.join(directory, "profile.json");
    await fs.writeFile(target, "container");
    await fs.writeFile(profilePath, JSON.stringify({
      name: "Ada", email: "ada@example.test", deviceName: "Desk PC",
    }));
    let unavailable = false;
    let targetWrites = 0;
    const guardedFs = Object.create(fs);
    guardedFs.readFile = async (file, ...args) => {
      if (unavailable && file === target) {
        const error = new Error("disconnected"); error.code = "ENOENT"; throw error;
      }
      return fs.readFile(file, ...args);
    };
    guardedFs.rename = async (source, destination) => {
      if (destination === target) targetWrites += 1;
      return fs.rename(source, destination);
    };
    const native = {
      openDocument(bytes) {
        const value = bytes.toString();
        if (value === "tampered-container") throw new Error("authentication failed");
        return { content: value.startsWith("saved:") ? value.slice(6) : "base",
          readOnly: true, canEdit: true,
          documentId: (value === "other-document" ? "de" : "cd").repeat(16),
          baseRevision: "ce".repeat(32), journalKey: Buffer.alloc(32, 33) };
      },
      saveDocument: (_bytes, _password, input) => Buffer.from(`saved:${input.content}`),
    };
    const leasedNative = withLease(native);
    const service = new DocumentService({ native: leasedNative, fs: guardedFs, profilePath,
      publicationCapabilities });
    await service.openDocument(target, "password words");
    await service.enterEditMode();
    unavailable = true;
    await service.saveDocument("exact local candidate");
    unavailable = false;
    await fs.writeFile(target, replacement);
    targetWrites = 0;

    assert.deepEqual(await service.reconnectPendingPublication(), {
      publicationState: "conflict", content: "exact local candidate",
    });
    assert.equal(targetWrites, 0);
    assert.equal(await fs.readFile(target, "utf8"), replacement);
    const conflict = await service.journals.read(
      "cd".repeat(16), Buffer.alloc(32, 33));
    assert.equal(conflict.state, "conflict");
    assert.equal(Buffer.from(conflict.publication.candidate, "base64").toString(),
      "saved:exact local candidate");
  }
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
  const first = new DocumentService({ native, fs, publicationCapabilities,
    profilePath: await writeProfile(directory, "Ada", "Desk"),
    utcNow: () => utc, monotonicNow: () => mono,
    setTimer(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimer() {} });
  await first.openDocument(target, "password words");
  await first.enterEditMode();
  const acquired = native.currentLease();
  assert.equal(acquired.heartbeatCounter, 1);
  assert.equal(timers.some((timer) => timer.delay === 120_000), true);

  const second = new DocumentService({ native, fs, publicationCapabilities,
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
  const holder = new DocumentService({ native, fs, publicationCapabilities,
    profilePath: await writeProfile(directory, "Ada", "Wrong clock"),
    utcNow: () => 9_000_000, monotonicNow: () => 0 });
  await holder.openDocument(target, "password words");
  await holder.enterEditMode();

  let monotonic = 10;
  const observer = new DocumentService({ native, fs, publicationCapabilities,
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

  const forced = new DocumentService({ native, fs, publicationCapabilities,
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
  const service = new DocumentService({ native, fs, publicationCapabilities,
    inactivityMs: 999_999,
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
  assert.deepEqual(await saving, { saved: true, content: "saved after heartbeat",
    publicationState: "target-published" });
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
  const service = new DocumentService({ native, fs, publicationCapabilities,
    inactivityMs: 999_999,
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
  const service = new DocumentService({ native, fs, publicationCapabilities,
    utcNow: () => utc,
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

test("head mismatches remain inspectable but block editing until explicitly accepted", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-head-mismatch-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  await fs.writeFile(target, "first");
  const a = "aa".repeat(32);
  const b = "bb".repeat(32);
  const x = "cc".repeat(32);
  let version = "first";
  const native = { openDocument: () => version === "first"
    ? { content: "original", readOnly: true, canEdit: true,
      documentId: "11".repeat(16), baseRevision: b,
      revisionGraph: [{ revisionId: a, parentRevisionIds: [] },
        { revisionId: b, parentRevisionIds: [a] }], journalKey: Buffer.alloc(32, 3) }
    : { content: "other branch", readOnly: true, canEdit: true,
      documentId: "11".repeat(16), baseRevision: x,
      revisionGraph: [{ revisionId: x, parentRevisionIds: [a] }],
      journalKey: Buffer.alloc(32, 3) } };
  const options = { native: withLease(native), fs, publicationCapabilities,
    profilePath: await writeProfile(directory, "Ada", "Desk") };
  const first = new DocumentService(options);
  await first.openDocument(target, "password words");
  await first.lock();
  version = "other";
  const restarted = new DocumentService(options);
  const opened = await restarted.openDocument(target, "password words");
  assert.equal(opened.content, "other branch");
  assert.equal(opened.readOnly, true);
  assert.equal(opened.canEdit, false);
  assert.equal(opened.headMismatch.kind, "divergence");
  assert.match(opened.headMismatch.explanation, /unrelated/);
  await assert.rejects(restarted.enterEditMode(), /head mismatch/);
  const accepted = await restarted.acceptHeadMismatch();
  assert.equal(accepted.canEdit, true);
  assert.equal(accepted.headMismatch, undefined);
  assert.equal((await restarted.enterEditMode()).readOnly, false);
  await restarted.lock();
});

test("different document IDs are explained as target replacement", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-replacement-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  await fs.writeFile(target, "container");
  let documentId = "11".repeat(16);
  const head = "aa".repeat(32);
  const native = { openDocument: () => ({ content: "inspectable", readOnly: true,
    canEdit: true, documentId, baseRevision: head,
    revisionGraph: [{ revisionId: head, parentRevisionIds: [] }],
    journalKey: Buffer.alloc(32, 5) }) };
  const options = { native, fs, publicationCapabilities,
    profilePath: path.join(directory, "profile.json") };
  const first = new DocumentService(options);
  await first.openDocument(target, "password words");
  await first.lock();
  documentId = "22".repeat(16);
  const opened = await new DocumentService(options).openDocument(target, "password words");
  assert.equal(opened.headMismatch.kind, "replacement");
  assert.match(opened.headMismatch.explanation, /permanent document ID differs/);
});
