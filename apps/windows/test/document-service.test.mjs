import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyCloseDecision } from "../src/close-document.mjs";
import { compactWithBackupSelection } from "../src/compaction-flow.mjs";
import { COMPACTION_CONFIRMATION, DISCARD_UNREADABLE_JOURNAL_CONFIRMATION,
  DocumentService } from "../src/document-service.mjs";
import { NativeLifecycleCoordinator } from "../src/native-lifecycle.mjs";
import { ReplacementCoordinator } from "../src/replacement-coordinator.mjs";
import { SessionGeneration } from "../src/session-generation.mjs";
import { SessionProtectionCoordinator } from "../src/session-protection.mjs";
import { registerNativeWindowClose } from "../src/window-lifecycle.mjs";

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

async function lockDuringNextLeaseAcquisition({ service, native, target, operation }) {
  const active = service.active;
  const delayed = delayNextTargetRead(service, target);
  const rejected = assert.rejects(operation(), (error) => error.code === "SESSION_LOCKED");
  await delayed.readStarted;
  const locking = service.lock("inactivity");
  delayed.release();
  await rejected;
  await locking;
  assert.equal(service.active, null);
  const acquired = native.currentLease();
  const suspended = service.suspendedLeases.get(active.documentId);
  assert.equal(acquired.active, true);
  assert.equal(suspended.sessionId.toString("hex"), acquired.sessionId);
  assert.equal(suspended.counter, acquired.heartbeatCounter);
}

async function compactionFixture(t, prefix = "scpefe-compaction-fixture-") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = await writeProfile(directory, "Ada", "Desk");
  const current = Buffer.from("history-rich-container");
  const candidate = Buffer.from("shallow-container");
  const leaseChanged = Buffer.from("lease-changed-container");
  await fs.writeFile(target, current);
  const sessionId = "8d".repeat(16);
  const previousHead = "91".repeat(32);
  const compactedHead = "a2".repeat(32);
  const documentId = "b3".repeat(16);
  const journalKey = Buffer.alloc(32, 0x64);
  const lease = { active: true, sessionId, heartbeatCounter: 9,
    holderUtcMs: 1000, durationMs: 600_000, holderName: "Ada",
    holderEmail: "ada@example.test", deviceName: "Desk" };
  const common = { content: "preserved text", readOnly: true, canEdit: true,
    canAddPasswords: true, canRemovePasswords: true, manuallySealed: true,
    documentId, lease, managedSlots: [{ slotId: "c4".repeat(16),
      identityName: "Grace", identityEmail: "grace@example.test", canEdit: true,
      canAddPasswords: false, canRemovePasswords: false, mustBeChanged: false }] };
  const native = { compactHook: null,
    openDocument(bytes) {
      if (bytes.equals(current)) return { ...common,
        journalKey: Buffer.from(journalKey), baseRevision: previousHead,
        revisionGraph: [{ revisionId: previousHead,
          parentRevisionIds: ["d5".repeat(32)] }] };
      if (bytes.equals(candidate)) return { ...common,
        journalKey: Buffer.from(journalKey), baseRevision: compactedHead,
        revisionGraph: [{ revisionId: compactedHead,
          parentRevisionIds: [previousHead] }] };
      if (bytes.equals(leaseChanged)) return { ...common,
        journalKey: Buffer.from(journalKey),
        baseRevision: previousHead,
        lease: { ...lease, sessionId: "ee".repeat(16), heartbeatCounter: 1 },
        revisionGraph: [{ revisionId: previousHead,
          parentRevisionIds: ["d5".repeat(32)] }] };
      throw new Error("unexpected compaction fixture container");
    },
    compactDocument() { native.compactHook?.(); return candidate; } };
  const options = { native, fs, profilePath, publicationCapabilities,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    now: () => Date.UTC(2026, 8, 20, 1, 2, 3) };
  const service = new DocumentService(options);
  await service.openDocument(target, "recovery or owner password");
  service.active.editMode = true;
  service.active.leaseSessionId = Buffer.from(sessionId, "hex");
  service.active.leaseCounter = 9;
  service.active.working = { content: common.content, cursor: { start: 0, end: 0 } };
  return { directory, target, current, candidate, leaseChanged, previousHead,
    compactedHead, documentId, journalKey, native, options, service };
}

test("integrated native close | real DocumentService restart journal | Cancel then Discard",
  async (t) => {
    const fixture = await compactionFixture(t, "scpefe-lifecycle-restart-");
    fixture.service.updateWorkingCopy({ content: "restart-safe unsaved text",
      cursor: { start: 24, end: 24 } });
    let protectionRequest; let closeHandler; let closes = 0;
    const protections = new SessionProtectionCoordinator({
      getService: () => fixture.service,
      present: (request) => { protectionRequest = request; },
    });
    const lifecycle = new NativeLifecycleCoordinator({
      getService: () => fixture.service, protections,
      lockActive: (reason) => fixture.service.lock(reason),
      closeWindow: () => { closes += 1; }, report: () => {},
    });
    registerNativeWindowClose({ on(_event, handler) { closeHandler = handler; },
      removeListener() {} }, lifecycle);
    const cancelEvent = { prevented: false, preventDefault() { this.prevented = true; } };
    const canceled = closeHandler(cancelEvent);
    assert.equal(cancelEvent.prevented, true);
    await protections.decide({ token: protectionRequest.token, decision: "cancel" });
    assert.equal(await canceled, false);
    assert.equal(closes, 0);
    assert.equal(fixture.service.active.working.content, "restart-safe unsaved text");
    assert.deepEqual(await fs.readFile(fixture.target), fixture.current);

    await fixture.service.lock("restart-evidence");
    const pending = await fixture.service.journals.read(fixture.documentId,
      fixture.journalKey);
    assert.equal(pending.text, "restart-safe unsaved text");
    const restarted = new DocumentService(fixture.options);
    const opened = await restarted.openDocument(fixture.target,
      "recovery or owner password");
    assert.equal(opened.recovery.content, "restart-safe unsaved text");
    assert.equal(restarted.active.recovery.text, "restart-safe unsaved text");

    protectionRequest = null; closeHandler = null;
    const restartedProtections = new SessionProtectionCoordinator({
      getService: () => restarted,
      present: (request) => { protectionRequest = request; },
    });
    const restartedLifecycle = new NativeLifecycleCoordinator({
      getService: () => restarted, protections: restartedProtections,
      lockActive: (reason) => restarted.lock(reason),
      closeWindow: () => { closes += 1; }, report: () => {},
    });
    registerNativeWindowClose({ on(_event, handler) { closeHandler = handler; },
      removeListener() {} }, restartedLifecycle);
    const discardEvent = { prevented: false, preventDefault() { this.prevented = true; } };
    const discarded = closeHandler(discardEvent);
    assert.equal(discardEvent.prevented, true);
    const discardDecision = await restartedProtections.decide({ token: protectionRequest.token,
      decision: "discard" });
    assert.deepEqual(discardDecision, { completed: true, proceed: true });
    assert.equal(await discarded, true);
    assert.equal(closes, 1);
    assert.equal(await restarted.journals.read(fixture.documentId,
      fixture.journalKey), null);
  });

async function migrationFixture(t, prefix = "scpefe-migration-fixture-", fsImpl = fs) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = await writeProfile(directory, "Ada", "Desk");
  const legacy = Buffer.from("legacy-container");
  const candidate = Buffer.from("migrated-container");
  await fs.writeFile(target, legacy);
  const oldHead = "71".repeat(32); const newHead = "72".repeat(32);
  const documentId = "73".repeat(16); const journalKey = Buffer.alloc(32, 0x74);
  const inactive = { active: false, sessionId: "0".repeat(32), heartbeatCounter: 0,
    holderUtcMs: 0, durationMs: 600_000, holderName: "", holderEmail: "",
    deviceName: "" };
  const activeLease = { active: true, sessionId: "75".repeat(16), heartbeatCounter: 1,
    holderUtcMs: 1000, durationMs: 600_000, holderName: "Ada",
    holderEmail: "ada@example.test", deviceName: "Desk" };
  const native = { migrationHook: null, openDocument(bytes) {
    const current = bytes.equals(candidate);
    if (!current && !bytes.equals(legacy)) throw new Error("unexpected migration bytes");
    return { content: "preserved text", readOnly: true, canEdit: true,
      documentId, baseRevision: current ? newHead : oldHead,
      revisionGraph: current ? [{ revisionId: newHead, parentRevisionIds: [oldHead] },
        { revisionId: oldHead, parentRevisionIds: [] }]
        : [{ revisionId: oldHead, parentRevisionIds: [] }],
      journalKey: Buffer.from(journalKey), manuallySealed: true,
      containerFormatVersion: current ? 3 : 2,
      historyEventType: current ? "format-migration" : "",
      historyEventDetail: current ? "container-version-2-to-3" : "",
      lease: current ? activeLease : native.legacyLease };
  }, migrateDocument() { native.migrationHook?.(); return candidate; } };
  native.legacyLease = inactive;
  const options = { native, fs: fsImpl, profilePath, publicationCapabilities,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"), now: () => 1000,
    utcNow: () => 1000, randomSessionId: () => Buffer.alloc(16, 0x75),
    setTimer: () => ({ unref() {} }), clearTimer: () => {} };
  const service = new DocumentService(options);
  await service.openDocument(target, "owner password words");
  return { directory, target, legacy, candidate, native, options, service };
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
    ownerPasswordConfirmation: "owner password words", recoveryPasswordConfirmation: "",
    content: "hello", understandsIrrecoverable: true,
    storedRecoverySeparately: false };
  await assert.rejects(service.createDocument(target, request), /Configure/);
  await service.saveProfile({ name: "Ada", email: "ada@example.test",
    deviceName: "Desk PC" });
  assert.deepEqual(await service.createDocument(target, request), { created: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].understandsIrrecoverable, true);
  assert.equal(calls[0].storedRecoverySeparately, false);
  assert.equal("ownerPasswordConfirmation" in calls[0], false);
  assert.equal("recoveryPasswordConfirmation" in calls[0], false);
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

test("password changes authenticate the active slot and atomically retain document state",
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-password-ui-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const target = path.join(directory, "document.scpefe");
    const current = Buffer.from("current encrypted container");
    const changed = Buffer.from("changed password container");
    await fs.writeFile(target, current);
    const documentId = "41".repeat(16);
    const baseRevision = "42".repeat(32);
    const journalKey = Buffer.alloc(32, 0x43);
    const native = withLease({
      openDocument(bytes, password) {
        if (bytes.equals(current) && password !== "current password words") {
          throw new Error("wrong current password");
        }
        if (bytes.equals(changed) && password !== "replacement password words") {
          throw new Error("old password no longer works");
        }
        return { content: "protected text", readOnly: true, canEdit: true,
          canAddPasswords: false, canRemovePasswords: false, manuallySealed: true,
          documentId, baseRevision, revisionGraph: [{ revisionId: baseRevision,
            parentRevisionIds: [] }], journalKey: Buffer.from(journalKey) };
      },
      changePassword(bytes, currentPassword, newPassword) {
        assert.deepEqual(bytes, current);
        assert.equal(currentPassword, "current password words");
        assert.equal(newPassword, "replacement password words");
        return changed;
      },
    });
    const service = new DocumentService({ native, fs,
      profilePath: await writeProfile(directory, "Ada", "Desk"),
      journalDirectory: path.join(directory, "journals"),
      witnessDirectory: path.join(directory, "witnesses"), publicationCapabilities });
    await service.openDocument(target, "current password words");
    await assert.rejects(service.changePassword({
      currentPassword: "different current password", newPassword: "replacement password words",
    }), /does not match/);
    assert.deepEqual(await fs.readFile(target), current);
    let encryptedJournal;
    let interrupted = false;
    const write = service.journals.write.bind(service.journals);
    service.journals.write = async (...args) => {
      await write(...args);
      if (!interrupted && args[2]?.publication?.stage === "replaced") {
        interrupted = true;
        encryptedJournal = await fs.readFile(path.join(directory, "journals",
          `${documentId}.work-journal`));
        throw new Error("simulated acknowledgement loss after replacement");
      }
    };
    const result = await service.changePassword({
      currentPassword: "current password words", newPassword: "replacement password words",
    });
    assert.equal(interrupted, true);
    assert.equal(result.content, "protected text");
    assert.deepEqual(await fs.readFile(target), changed);
    assert.equal(service.active.password, "replacement password words");
    assert.equal(encryptedJournal.includes(Buffer.from("replacement password words")), false,
      "the recoverable publication record never stores its password as plaintext");
    assert.equal(await service.journals.read(documentId, service.active.journalKey), null,
      "successful publication leaves no password-bearing recovery record");
  });

test("created replacement cleanup removes exact bytes and permits retry", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-replacement-cleanup-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profilePath = await writeProfile(directory, "Ada", "Desk");
  const target = path.join(directory, "new.scpefe");
  const bytes = Buffer.from("new encrypted container");
  const native = withLease({
    createDocument() { return Buffer.from(bytes); },
    openDocument(value) {
      if (!value.equals(bytes)) throw new Error("unexpected container bytes");
      return { content: "", readOnly: true, canEdit: true,
        documentId: "31".repeat(16), baseRevision: "32".repeat(32),
        journalKey: Buffer.alloc(32, 0x33) };
    },
  });
  const options = { native, fs, profilePath, publicationCapabilities,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    setTimer: () => ({ unref() {} }), clearTimer: () => {} };
  const first = new DocumentService(options);
  await first.createDocument(target, { ownerPassword: "owner password words",
    recoveryPassword: null, content: "", understandsIrrecoverable: true,
    storedRecoverySeparately: false });
  await first.openDocument(target, "owner password words");
  await first.enterEditMode();
  assert.equal((await fs.stat(target)).isFile(), true);
  assert.deepEqual(await first.abandonCreatedDocument(), { removed: true });
  await assert.rejects(fs.stat(target), { code: "ENOENT" });

  const retry = new DocumentService(options);
  await retry.createDocument(target, { ownerPassword: "owner password words",
    recoveryPassword: null, content: "", understandsIrrecoverable: true,
    storedRecoverySeparately: false });
  assert.equal((await fs.stat(target)).isFile(), true,
    "create-only publication succeeds after cleanup");

  const partialTarget = path.join(directory, "partial.scpefe");
  let timerCalls = 0;
  const partialNative = withLease({
    createDocument() { return Buffer.from(bytes); },
    openDocument(value) {
      if (!value.equals(bytes)) throw new Error("unexpected container bytes");
      return { content: "", readOnly: true, canEdit: true,
        documentId: "51".repeat(16), baseRevision: "52".repeat(32),
        journalKey: Buffer.alloc(32, 0x53) };
    },
  });
  const partial = new DocumentService({ ...options, native: partialNative,
    setTimer: () => {
      timerCalls += 1;
      if (timerCalls === 2) throw new Error("heartbeat scheduling failed");
      return { unref() {} };
    } });
  await partial.createDocument(partialTarget, { ownerPassword: "owner password words",
    recoveryPassword: null, content: "", understandsIrrecoverable: true,
    storedRecoverySeparately: false });
  await partial.openDocument(partialTarget, "owner password words");
  await assert.rejects(partial.enterEditMode(), /heartbeat scheduling failed/);
  assert.deepEqual(await partial.abandonCreatedDocument(), { removed: true });
  await assert.rejects(fs.stat(partialTarget), { code: "ENOENT" });
});

test("replacement revalidation detects a target mutation without changing active state",
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-revalidate-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const target = path.join(directory, "opened.scpefe");
    const original = Buffer.from("authenticated original");
    await fs.writeFile(target, original);
    const native = withLease({ openDocument(value) {
      if (!value.equals(original)) throw new Error("authentication failed");
      return { content: "original plaintext", readOnly: true, canEdit: true,
        documentId: "41".repeat(16), baseRevision: "42".repeat(32),
        journalKey: Buffer.alloc(32, 0x43) };
    } });
    const service = new DocumentService({ native, fs,
      profilePath: path.join(directory, "profile.json"), publicationCapabilities,
      journalDirectory: path.join(directory, "journals"),
      witnessDirectory: path.join(directory, "witnesses"),
      setTimer: () => ({ unref() {} }), clearTimer: () => {} });
    await service.openDocument(target, "owner password words");
    const active = service.active;
    await fs.writeFile(target, Buffer.from("raced replacement"));
    await assert.rejects(service.revalidateTargetForReplacement(),
      (error) => error.code === "DOCUMENT_REPLACEMENT_TARGET_CHANGED");
    assert.equal(service.active, active);
    assert.equal(service.active.opened.content, "original plaintext");
  });

test("validates creation acknowledgements at the service boundary", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-create-acks-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profilePath = await writeProfile(directory, "Ada", "Desk PC");
  const calls = [];
  const assessed = [];
  const service = new DocumentService({ fs, publicationCapabilities, profilePath,
    native: { passwordMeetsPolicy(password) {
      assessed.push(password); return !password.includes("predictable");
    }, createDocument(input) {
      calls.push(input);
      return Buffer.from("container");
    }, openDocument: () => ({ content: "hello", readOnly: true, canEdit: true,
      documentId: "11".repeat(16), baseRevision: "22".repeat(32),
      journalKey: Buffer.alloc(32, 3) }) } });
  const request = { ownerPassword: "owner words, spaces & punctuation! 42",
    ownerPasswordConfirmation: "owner words, spaces & punctuation! 42",
    recoveryPassword: "recovery-words; separate & offline! 73", content: "hello",
    recoveryPasswordConfirmation: "recovery-words; separate & offline! 73",
    understandsIrrecoverable: true, storedRecoverySeparately: true };

  await assert.rejects(service.createDocument(path.join(directory, "missing.scpefe"),
    { ...request, understandsIrrecoverable: false }),
  /irrecoverability must be acknowledged/);
  await assert.rejects(service.createDocument(path.join(directory, "unsafe.scpefe"),
    { ...request, storedRecoverySeparately: false }),
  /recovery password storage must be acknowledged/);
  assert.equal(calls.length, 0);
  const rejectedTarget = path.join(directory, "weak.scpefe");
  await assert.rejects(service.createDocument(rejectedTarget, { ...request,
    ownerPassword: "predictable password words",
    ownerPasswordConfirmation: "predictable password words" }),
  (error) => error.code === "OWNER_PASSWORD_WEAK");
  await assert.rejects(fs.stat(rejectedTarget), (error) => error.code === "ENOENT");
  assert.equal(calls.length, 0, "policy rejection reaches no native creation or target write");
  assert.deepEqual(await service.createDocument(path.join(directory, "safe.scpefe"),
    request), { created: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ownerPassword, request.ownerPassword);
  assert.equal(calls[0].recoveryPassword, request.recoveryPassword);
  assert.deepEqual(assessed.slice(-2), [request.ownerPassword, request.recoveryPassword]);
  assert.equal(calls[0].understandsIrrecoverable, true);
  assert.equal(calls[0].storedRecoverySeparately, true);
});

test("authenticated switch discard removes only the active unreadable journal", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-unreadable-journal-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const journalDirectory = path.join(directory, "journals");
  const documentId = "91".repeat(16);
  const otherDocumentId = "92".repeat(16);
  const activeJournal = path.join(journalDirectory, `${documentId}.work-journal`);
  const otherJournal = path.join(journalDirectory, `${otherDocumentId}.work-journal`);
  await fs.mkdir(journalDirectory);
  await fs.writeFile(target, "container");
  await fs.writeFile(activeJournal, "malformed authenticated envelope");
  await fs.writeFile(otherJournal, "another document's recovery data");
  const warnings = [];
  const service = new DocumentService({ fs, journalDirectory,
    profilePath: await writeProfile(directory, "Ada", "Desk"),
    publicationCapabilities,
    witnessDirectory: path.join(directory, "witnesses"),
    onJournalWarning: (warning) => warnings.push(warning),
    native: withLease({ openDocument(bytes, password) {
      assert.equal(bytes.toString(), "container");
      assert.equal(password, "owner password words");
      const baseRevision = "93".repeat(32);
      return { content: "sealed", readOnly: true, canEdit: true,
        documentId, baseRevision,
        revisionGraph: [{ revisionId: baseRevision, parentRevisionIds: [] }],
        journalKey: Buffer.alloc(32, 0x94), manuallySealed: true };
    } }) });
  await service.openDocument(target, "owner password words");
  assert.equal(service.active.unreadableJournal, true);
  assert.equal(warnings.at(-1), "RECOVERY_READ_FAILED");
  await assert.rejects(service.discardUnreadableJournalForSwitch("discard"),
    /not explicitly confirmed/);
  assert.equal(await fs.readFile(activeJournal, "utf8"),
    "malformed authenticated envelope");
  assert.deepEqual(await service.discardUnreadableJournalForSwitch(
    DISCARD_UNREADABLE_JOURNAL_CONFIRMATION),
  { discarded: true, documentId });
  await assert.rejects(fs.access(activeJournal), (error) => error.code === "ENOENT");
  assert.equal(await fs.readFile(otherJournal, "utf8"),
    "another document's recovery data");
  assert.equal(service.active.unresolvedJournal, false);
});

test("older containers remain read-only until verified-backup migration", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-migration-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = await writeProfile(directory, "Ada", "Desk");
  const legacy = Buffer.from("legacy-container");
  const migrated = Buffer.from("migrated-container");
  await fs.writeFile(target, legacy);
  const oldHead = "41".repeat(32);
  const newHead = "42".repeat(32);
  const documentId = "43".repeat(16);
  const journalKey = Buffer.alloc(32, 0x44);
  const native = { openDocument(bytes) {
    const current = bytes.equals(migrated);
    return { content: "preserved text", readOnly: true, canEdit: true,
      canAddPasswords: true, canRemovePasswords: true,
      documentId, baseRevision: current ? newHead : oldHead,
      revisionGraph: current
        ? [{ revisionId: newHead, parentRevisionIds: [oldHead] },
          { revisionId: oldHead, parentRevisionIds: [] }]
        : [{ revisionId: oldHead, parentRevisionIds: [] }],
      journalKey: Buffer.from(journalKey), manuallySealed: true,
      containerFormatVersion: current ? 3 : 2,
      historyEventType: current ? "format-migration" : "",
      historyEventDetail: current ? "container-version-2-to-3" : "",
      lease: current ? { active: true, sessionId: "55".repeat(16),
        heartbeatCounter: 1, holderUtcMs: 1000, durationMs: 600_000,
        holderName: "Ada", holderEmail: "ada@example.test", deviceName: "Desk" }
        : { active: false, sessionId: "0".repeat(32), heartbeatCounter: 0,
          holderUtcMs: 0, durationMs: 600_000, holderName: "", holderEmail: "",
          deviceName: "" } };
  }, migrateDocument(bytes, _password, input) {
    assert.ok(bytes.equals(legacy));
    assert.equal(input.sessionId, "55".repeat(16));
    return migrated;
  } };
  const service = new DocumentService({ native, fs, profilePath,
    publicationCapabilities, journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"), now: () => 1000,
    utcNow: () => 1000, randomSessionId: () => Buffer.alloc(16, 0x55),
    setTimer: () => ({ unref() {} }), clearTimer: () => {} });
  const opened = await service.openDocument(target, "owner password words");
  assert.equal(opened.migrationRequired, true);
  assert.equal(opened.canEdit, false);
  await assert.rejects(service.enterEditMode(), /must be migrated before editing or saving/);
  const result = await service.migrateDocument();
  assert.equal(result.migrated, true);
  assert.equal(result.compatibilityCode, "MIGRATION_COMPATIBILITY");
  assert.ok((await fs.readFile(target)).equals(migrated));
  assert.ok((await fs.readFile(path.join(directory,
    "document.backup-19700101T000001Z.scpefe"))).equals(legacy));
});

test("failed pre-migration backup leaves the older target untouched", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-migration-fail-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = await writeProfile(directory, "Ada", "Desk");
  const legacy = Buffer.from("legacy-container");
  await fs.writeFile(target, legacy);
  let migrated = false;
  const native = { openDocument: () => ({ content: "text", readOnly: true,
    canEdit: true, documentId: "61".repeat(16), baseRevision: "62".repeat(32),
    revisionGraph: [{ revisionId: "62".repeat(32), parentRevisionIds: [] }],
    journalKey: Buffer.alloc(32, 0x63), manuallySealed: true,
    containerFormatVersion: 2, historyEventType: "", historyEventDetail: "" }),
  migrateDocument() { migrated = true; return Buffer.from("bad"); } };
  const service = new DocumentService({ native, fs, profilePath,
    publicationCapabilities, now: () => 1000 });
  await service.openDocument(target, "owner password words");
  await assert.rejects(service.migrateDocument(target), /distinct pre-migration/);
  const unavailable = path.join(directory, "missing", "backup.scpefe");
  await assert.rejects(service.migrateDocument(unavailable),
    (error) => error.code === "MIGRATION_BACKUP_FAILED");
  assert.equal(migrated, false);
  assert.ok((await fs.readFile(target)).equals(legacy));
});

test("migration target race is tracked and never overwrites the competing value", async (t) => {
  const fixture = await migrationFixture(t, "scpefe-migration-race-");
  const competing = Buffer.from("competing-container");
  fixture.native.migrationHook = () => fsSync.writeFileSync(fixture.target, competing);
  await assert.rejects(fixture.service.migrateDocument(), /Publication/);
  assert.ok((await fs.readFile(fixture.target)).equals(competing));
  const pending = await fixture.service.journals.read(
    fixture.service.active.documentId, fixture.service.active.journalKey);
  assert.equal(pending.publication.purpose, "format-migration");
  assert.ok(Buffer.from(pending.publication.candidate, "base64").equals(fixture.candidate));
});

test("restart completes an interrupted tracked migration publication", async (t) => {
  const fixture = await migrationFixture(t, "scpefe-migration-restart-");
  const realRename = fs.rename.bind(fs);
  let interrupted = false;
  const faultFs = { ...fs, async rename(from, to) {
    if (!interrupted && to === fixture.target && from.includes("scpefe-txn")) {
      interrupted = true;
      throw new Error("simulated migration replace interruption");
    }
    return realRename(from, to);
  } };
  fixture.service.fs = faultFs;
  fixture.service.publications.fs = faultFs;
  fixture.service.journals.fs = faultFs;
  await assert.rejects(fixture.service.migrateDocument(),
    (error) => error.publicationPrepared === true);
  const pending = await fixture.service.journals.read(
    fixture.service.active.documentId, fixture.service.active.journalKey);
  assert.equal(pending.publication.purpose, "format-migration");
  const restarted = new DocumentService({ ...fixture.options, fs });
  const opened = await restarted.openDocument(fixture.target, "owner password words");
  assert.equal(opened.migrationRequired, undefined);
  assert.ok((await fs.readFile(fixture.target)).equals(fixture.candidate));
});

test("migration applies uncertain-clock observation and explicit takeover rules", async (t) => {
  const fixture = await migrationFixture(t, "scpefe-migration-clock-");
  let monotonic = 10;
  fixture.service.monotonicNow = () => monotonic;
  fixture.native.legacyLease = { active: true, sessionId: "79".repeat(16),
    heartbeatCounter: 4, holderUtcMs: 9_000_000, durationMs: 600_000,
    holderName: "Remote editor", holderEmail: "remote@example.test",
    deviceName: "Future clock" };
  let takeoverToken;
  await assert.rejects(fixture.service.migrateDocument(), (error) => {
    assert.equal(error.code, "LEASE_CLOCK_UNCERTAIN");
    assert.equal(error.lease.holderName, "Remote editor");
    assert.equal(typeof error.takeoverToken, "object");
    assert.equal(Object.isFrozen(error.takeoverToken), true);
    takeoverToken = error.takeoverToken;
    return true;
  });
  await assert.rejects(fixture.service.migrateDocument(undefined,
    { takeoverToken: Object.freeze({}) }), (error) => error.code === "LEASE_CHANGED");
  assert.equal(typeof takeoverToken, "object");
  assert.ok((await fs.readFile(fixture.target)).equals(fixture.legacy));
  monotonic += 599_999;
  await assert.rejects(fixture.service.migrateDocument(),
    (error) => error.code === "LEASE_CLOCK_UNCERTAIN");
  monotonic += 1;
  assert.equal((await fixture.service.migrateDocument()).migrated, true);
});

async function confirmedMigrationTakeover(service, beforeConfirm = () => {}) {
  let takeoverToken;
  await assert.rejects(service.migrateDocument(), (error) => {
    assert.equal(error.code, "LEASE_CLOCK_UNCERTAIN");
    takeoverToken = error.takeoverToken;
    return true;
  });
  await beforeConfirm();
  return service.migrateDocument(undefined, { takeoverToken });
}

test("confirmed migration takeover succeeds only for the presented lease", async (t) => {
  const fixture = await migrationFixture(t, "scpefe-migration-force-");
  fixture.native.legacyLease = { active: true, sessionId: "79".repeat(16),
    heartbeatCounter: 4, holderUtcMs: 9_000_000, durationMs: 600_000,
    holderName: "Remote editor", holderEmail: "remote@example.test",
    deviceName: "Future clock" };
  assert.equal((await confirmedMigrationTakeover(fixture.service)).migrated, true);
});

test("dialog confirmation rejects a refreshed lease before backup or migration", async (t) => {
  const fixture = await migrationFixture(t, "scpefe-migration-confirm-race-");
  fixture.native.legacyLease = { active: true, sessionId: "79".repeat(16),
    heartbeatCounter: 4, holderUtcMs: 9_000_000, durationMs: 600_000,
    holderName: "Remote editor", holderEmail: "remote@example.test",
    deviceName: "Future clock" };
  let candidateCreated = false;
  fixture.native.migrationHook = () => { candidateCreated = true; };
  await assert.rejects(confirmedMigrationTakeover(fixture.service, () => {
    fixture.native.legacyLease = { ...fixture.native.legacyLease,
      heartbeatCounter: 5, holderUtcMs: 9_000_100 };
  }), (error) => error.code === "LEASE_CHANGED");
  assert.equal(candidateCreated, false);
  await assert.rejects(fs.access(path.join(fixture.directory,
    "document.backup-19700101T000001Z.scpefe")), (error) => error.code === "ENOENT");
  assert.equal(await fixture.service.journals.read(
    fixture.service.active.documentId, fixture.service.active.journalKey), null);
  assert.ok((await fs.readFile(fixture.target)).equals(fixture.legacy));
});

test("confirmed migration still rejects a later candidate publication race", async (t) => {
  const racing = await migrationFixture(t, "scpefe-migration-force-race-");
  racing.native.legacyLease = { active: true, sessionId: "79".repeat(16),
    heartbeatCounter: 4, holderUtcMs: 9_000_000, durationMs: 600_000,
    holderName: "Remote editor", holderEmail: "remote@example.test",
    deviceName: "Future clock" };

  const competing = Buffer.from("competing-container");
  racing.native.migrationHook = () => fsSync.writeFileSync(racing.target, competing);
  await assert.rejects(confirmedMigrationTakeover(racing.service), /Publication/);
  assert.ok((await fs.readFile(racing.target)).equals(competing));
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

test("profile mismatch stays read-only until lease-backed reconciliation", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-identity-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = await writeProfile(directory, "Grace", "Private PC");
  await fs.writeFile(target, "base");
  const native = withLease({
    openDocument(bytes) {
      const reconciled = bytes.toString() === "reconciled";
      return { content: "secret", readOnly: true, canEdit: false,
        canAddPasswords: true, canRemovePasswords: true, recoverySlot: false,
        slotId: "12".repeat(16), slotIdentityName: reconciled ? "Grace" : "Old Grace",
        slotIdentityEmail: reconciled ? "grace@example.test" : "old@example.test",
        managedSlots: [], documentId: "31".repeat(16),
        baseRevision: "42".repeat(32), journalKey: Buffer.alloc(32, 5) };
    },
    reconcileIdentity(bytes, _password, input) {
      assert.equal(bytes.toString(), "base");
      assert.equal(input.name, "Grace");
      assert.equal(input.email, "grace@example.test");
      return Buffer.from("identity-reconciled");
    },
    saveDocument(bytes, _password, input) {
      assert.equal(bytes.toString(), "identity-reconciled");
      assert.equal(input.name, "Grace");
      assert.equal(input.email, "grace@example.test");
      return Buffer.from("reconciled");
    },
  });
  const service = new DocumentService({ native, fs, profilePath,
    publicationCapabilities });
  const opened = await service.openDocument(target, "password words");
  assert.equal(opened.canEdit, false);
  assert.equal(opened.content, "secret");
  assert.equal(opened.profileMismatch.editingBlocked, true);
  await assert.rejects(service.enterEditMode(), /Reconcile/);
  const reconciled = await service.reconcileIdentity();
  assert.equal(reconciled.slotIdentityName, "Grace");
  assert.equal(reconciled.canEdit, false);
  assert.equal(reconciled.profileMismatch, undefined);
  assert.equal((await fs.readFile(target)).toString(), "reconciled");
});

test("profile identity changes establish authoritative mismatch and deny administration",
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-profile-change-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const target = path.join(directory, "document.scpefe");
    const profilePath = await writeProfile(directory, "Ada", "Desk");
    await fs.writeFile(target, "base");
    const native = withLease({
      openDocument(bytes) {
        const reconciled = bytes.toString() === "reconciled";
        return { content: "secret", readOnly: true, canEdit: true,
          canAddPasswords: true, canRemovePasswords: true, recoverySlot: false,
          slotId: "81".repeat(16), slotIdentityName: reconciled ? "Grace" : "Ada",
          slotIdentityEmail: reconciled ? "grace@example.test" : "ada@example.test",
          managedSlots: [], documentId: "82".repeat(16),
          baseRevision: "83".repeat(32), journalKey: Buffer.alloc(32, 0x84) };
      },
      reconcileIdentity() { return Buffer.from("identity-reconciled"); },
      saveDocument(bytes) {
        assert.equal(bytes.toString(), "identity-reconciled");
        return Buffer.from("reconciled");
      },
    });
    const service = new DocumentService({ native, fs, profilePath,
      publicationCapabilities });
    await service.openDocument(target, "owner password words");
    await service.saveProfile({ name: "Grace", email: "grace@example.test",
      deviceName: "Desk" });
    const authoritative = await service.reconcileProfile();
    assert.equal(authoritative.profileMismatch.profileName, "Grace");
    assert.equal(authoritative.canEdit, false);
    assert.equal(service.active.profileMismatch.editingBlocked, true);
    await assert.rejects(service.changePassword({ currentPassword: "owner password words",
      newPassword: "replacement password words" }), /Reconcile/);
    await assert.rejects(service.createInvitation({ temporaryLabel: "Blocked" }),
      /Reconcile/);
    await assert.rejects(service.updateSlotPermissions({ slotId: "85".repeat(16) }),
      /Reconcile/);
    await assert.rejects(service.removeSlot("85".repeat(16)), /Reconcile/);
    const reconciled = await service.reconcileIdentity();
    assert.equal(reconciled.profileMismatch, undefined);
    assert.equal((await fs.readFile(target, "utf8")), "reconciled");
  });

test("profile identity changes fail before persistence while editing", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-profile-edit-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = await writeProfile(directory, "Ada", "Desk");
  await fs.writeFile(target, "base");
  const service = new DocumentService({ fs, profilePath, publicationCapabilities,
    native: withLease({ openDocument: () => ({ content: "secret", readOnly: true,
      canEdit: true, recoverySlot: false, slotIdentityName: "Ada",
      slotIdentityEmail: "ada@example.test", documentId: "91".repeat(16),
      baseRevision: "92".repeat(32), journalKey: Buffer.alloc(32, 0x93) }) }) });
  await service.openDocument(target, "owner password words");
  await service.enterEditMode();
  await service.saveProfile({ name: "Ada", email: "ada@example.test",
    deviceName: "Portable" });
  const deviceRefresh = await service.reconcileProfile();
  assert.equal(deviceRefresh.readOnly, false,
    "a device-only profile refresh preserves the active edit session");
  assert.equal(deviceRefresh.profileMismatch, undefined);
  await assert.rejects(service.saveProfile({ name: "Grace",
    email: "grace@example.test", deviceName: "Portable" }), /Leave edit mode/);
  assert.equal((await service.loadProfile()).name, "Ada");
});

test("recovery use never raises a profile mismatch", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-recovery-profile-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = await writeProfile(directory, "Grace", "Private PC");
  await fs.writeFile(target, "base");
  const service = new DocumentService({ fs, profilePath, publicationCapabilities,
    native: withLease({ openDocument: () => ({ content: "secret", readOnly: true,
      canEdit: true, recoverySlot: true, slotIdentityName: "",
      slotIdentityEmail: "", documentId: "51".repeat(16),
      baseRevision: "62".repeat(32), journalKey: Buffer.alloc(32, 7) }) }) });
  const opened = await service.openDocument(target, "recovery password words");
  assert.equal(opened.canEdit, true);
  assert.equal(opened.profileMismatch, undefined);
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

test("compaction creates an exact backup then publishes a verified shallow baseline",
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-compact-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const target = path.join(directory, "notes.scpefe");
    const profilePath = await writeProfile(directory, "Ada", "Desk");
    const current = Buffer.from("current-container");
    const candidate = Buffer.from("compacted-container");
    await fs.writeFile(target, current);
    const defaultBackup = path.join(directory,
      "notes.backup-20260920T010203Z.scpefe");
    await fs.writeFile(defaultBackup, "existing backup must not be replaced");
    const sessionId = "5a".repeat(16);
    const previousHead = "12".repeat(32);
    const compactedHead = "34".repeat(32);
    const documentId = "56".repeat(16);
    const journalKey = Buffer.alloc(32, 0x77);
    const lease = { active: true, sessionId, heartbeatCounter: 7,
      holderUtcMs: 1000, durationMs: 600_000, holderName: "Ada",
      holderEmail: "ada@example.test", deviceName: "Desk" };
    const common = { content: "current text", readOnly: true, canEdit: true,
      canAddPasswords: true, canRemovePasswords: true, manuallySealed: true,
      recoverySlot: true, slotId: "9a".repeat(16),
      documentId, lease, managedSlots: [] };
    const native = {
      openDocument(bytes) {
        if (bytes.equals(current)) return { ...common,
          journalKey: Buffer.from(journalKey), baseRevision: previousHead,
          revisionGraph: [
            { revisionId: "78".repeat(32), parentRevisionIds: [] },
            { revisionId: previousHead, parentRevisionIds: ["78".repeat(32)] },
          ] };
        if (bytes.equals(candidate)) return { ...common,
          journalKey: Buffer.from(journalKey), baseRevision: compactedHead,
          revisionGraph: [{ revisionId: compactedHead,
            parentRevisionIds: [previousHead] }] };
        throw new Error("unexpected container");
      },
      compactDocument(bytes, _password, heldLease) {
        assert.deepEqual(bytes, current);
        assert.deepEqual(heldLease, { sessionId, heartbeatCounter: 7 });
        return candidate;
      },
    };
    const service = new DocumentService({ native, fs, profilePath,
      publicationCapabilities, now: () => Date.UTC(2026, 8, 20, 1, 2, 3) });
    await service.openDocument(target, "owner password words");
    service.active.editMode = true;
    service.active.leaseSessionId = Buffer.from(sessionId, "hex");
    service.active.leaseCounter = 7;
    service.active.working = { content: "current text", cursor: { start: 0, end: 0 } };

    const result = await service.compactDocument(COMPACTION_CONFIRMATION);

    assert.deepEqual(result, { compacted: true, backupCreated: true,
      previousHead, head: compactedHead });
    assert.deepEqual(await fs.readFile(target), candidate);
    assert.equal(await fs.readFile(defaultBackup, "utf8"),
      "existing backup must not be replaced");
    assert.deepEqual(await fs.readFile(path.join(directory,
      "notes.backup-20260920T010203Z-1.scpefe")), current);
    assert.equal(service.active.editMode, true);
    assert.equal(service.active.baseRevision, compactedHead);
    assert.equal(service.active.opened.recoverySlot, true);
  });

test("compaction rejects missing confirmation, unclean state, and lost lease",
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-compact-gates-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const target = path.join(directory, "notes.scpefe");
    await fs.writeFile(target, "current");
    const sessionId = "6b".repeat(16);
    const native = { openDocument: () => ({ content: "text", readOnly: true,
      canEdit: true, canAddPasswords: true, canRemovePasswords: true,
      manuallySealed: true, documentId: "11".repeat(16),
      baseRevision: "22".repeat(32), journalKey: Buffer.alloc(32, 8),
      revisionGraph: [{ revisionId: "22".repeat(32), parentRevisionIds: [] }],
      lease: { active: true, sessionId, heartbeatCounter: 3, holderUtcMs: 1,
        durationMs: 600_000, holderName: "Ada", holderEmail: "ada@example.test",
        deviceName: "Desk" } }) };
    const service = new DocumentService({ native, fs,
      profilePath: path.join(directory, "profile.json"), publicationCapabilities });
    await service.openDocument(target, "owner password words");
    service.active.editMode = true;
    service.active.leaseSessionId = Buffer.from(sessionId, "hex");
    service.active.leaseCounter = 3;
    await assert.rejects(service.compactDocument("not confirmed"), /Confirm/);
    await assert.rejects(service.compactDocument(
      COMPACTION_CONFIRMATION, target), /distinct pre-compaction backup/);
    await assert.rejects(service.compactDocument(
      COMPACTION_CONFIRMATION, ""), /distinct pre-compaction backup/);
    service.active.dirty = true;
    await assert.rejects(service.compactDocument(COMPACTION_CONFIRMATION), /clean/);
    service.active.dirty = false;
    service.active.leaseCounter = 4;
    await assert.rejects(service.compactDocument(COMPACTION_CONFIRMATION),
      /lease changed/);
    await assert.rejects(fs.readFile(service.suggestedBackupTarget()),
      (error) => error.code === "ENOENT");
  });

test("compaction stops without rewriting when its mandatory backup fails", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-compact-backup-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "notes.scpefe");
  const current = Buffer.from("current");
  await fs.writeFile(target, current);
  const sessionId = "7c".repeat(16);
  let compactCalled = false;
  const native = { openDocument: () => ({ content: "text", readOnly: true,
    canEdit: true, canAddPasswords: true, canRemovePasswords: true,
    manuallySealed: true, documentId: "31".repeat(16),
    baseRevision: "42".repeat(32), journalKey: Buffer.alloc(32, 9),
    revisionGraph: [{ revisionId: "42".repeat(32), parentRevisionIds: [] }],
    lease: { active: true, sessionId, heartbeatCounter: 6, holderUtcMs: 1,
      durationMs: 600_000, holderName: "Ada", holderEmail: "ada@example.test",
      deviceName: "Desk" } }),
  compactDocument() { compactCalled = true; return Buffer.from("must-not-publish"); } };
  const failingFs = Object.create(fs);
  failingFs.link = async () => { throw new Error("backup destination failed"); };
  const service = new DocumentService({ native, fs: failingFs,
    profilePath: path.join(directory, "profile.json"), publicationCapabilities });
  await service.openDocument(target, "owner password words");
  service.active.editMode = true;
  service.active.leaseSessionId = Buffer.from(sessionId, "hex");
  service.active.leaseCounter = 6;

  await assert.rejects(service.compactDocument(COMPACTION_CONFIRMATION),
    (error) => error.code === "COMPACTION_BACKUP_FAILED"
      && /required pre-compaction backup/.test(error.message)
      && /backup destination failed/.test(error.cause?.message));
  assert.equal(compactCalled, false);
  assert.deepEqual(await fs.readFile(target), current);
});

test("failed pre-compaction backup verification removes no history", async (t) => {
  const fixture = await compactionFixture(t, "scpefe-compact-verify-backup-");
  let compactCalled = false;
  fixture.native.compactDocument = () => { compactCalled = true; return fixture.candidate; };
  const tamperedFs = Object.create(fs);
  let tampered = false;
  tamperedFs.readFile = async (file, ...args) => {
    if (!tampered && String(file).includes(".backup-")
        && !String(file).includes("backup-txn")) {
      tampered = true;
      await fs.writeFile(file, "tampered backup bytes");
    }
    return fs.readFile(file, ...args);
  };
  fixture.service.publications.fs = tamperedFs;

  await assert.rejects(
    fixture.service.compactDocument(COMPACTION_CONFIRMATION),
    (error) => error.code === "COMPACTION_BACKUP_FAILED"
      && /verification failed/.test(error.cause?.message));
  assert.equal(compactCalled, false);
  assert.deepEqual(await fs.readFile(fixture.target), fixture.current);
});

test("default backup failure followed by alternate selection completes compaction",
  async (t) => {
    const fixture = await compactionFixture(t, "scpefe-compact-alternate-");
    const alternate = path.join(fixture.directory, "alternate", "safe.scpefe");
    await fs.mkdir(path.dirname(alternate));
    const publishReplica = fixture.service.publications.publishReplica.bind(
      fixture.service.publications);
    let attempts = 0;
    fixture.service.publications.publishReplica = async (request) => {
      attempts += 1;
      if (attempts === 1) throw new Error("default destination unavailable");
      return publishReplica(request);
    };
    const dialog = { async showSaveDialog(_window, options) {
      assert.equal(options.defaultPath, fixture.service.suggestedBackupTarget());
      return { canceled: false, filePath: alternate };
    } };

    const result = await compactWithBackupSelection({ service: fixture.service,
      dialog, window: {}, confirmation: COMPACTION_CONFIRMATION });
    assert.equal(result.compacted, true);
    assert.equal(attempts, 2);
    assert.deepEqual(await fs.readFile(alternate), fixture.current);
    assert.deepEqual(await fs.readFile(fixture.target), fixture.candidate);
  });

test("target race after the verified backup aborts before candidate creation", async (t) => {
  const fixture = await compactionFixture(t, "scpefe-compact-target-race-");
  let compactCalled = false;
  fixture.native.compactDocument = () => { compactCalled = true; return fixture.candidate; };
  const normalRead = fs.readFile.bind(fs);
  let targetReads = 0;
  fixture.service.fs = Object.create(fs);
  fixture.service.fs.readFile = async (file, ...args) => {
    if (file === fixture.target && ++targetReads === 2) {
      await fs.writeFile(fixture.target, fixture.leaseChanged);
    }
    return normalRead(file, ...args);
  };

  await assert.rejects(
    fixture.service.compactDocument(COMPACTION_CONFIRMATION),
    /target changed after the pre-compaction backup/);
  assert.equal(compactCalled, false);
  assert.deepEqual(await fs.readFile(fixture.target), fixture.leaseChanged);
  assert.deepEqual(await fs.readFile(path.join(fixture.directory,
    "document.backup-20260920T010203Z.scpefe")), fixture.current);
});

test("lease race after backup preserves the compacted candidate for conflict recovery",
  async (t) => {
    const fixture = await compactionFixture(t, "scpefe-compact-lease-race-");
    const publish = fixture.service.publications.publish.bind(
      fixture.service.publications);
    fixture.service.publications.publish = async (request) => {
      await fs.writeFile(fixture.target, fixture.leaseChanged);
      return publish(request);
    };

    await assert.rejects(
      fixture.service.compactDocument(COMPACTION_CONFIRMATION),
      (error) => error.publicationPrepared === true);
    assert.deepEqual(await fs.readFile(fixture.target), fixture.leaseChanged);
    const pending = await fixture.service.journals.read(
      fixture.documentId, fixture.journalKey);
    assert.equal(pending.publication.purpose, "compaction");
    assert.deepEqual(Buffer.from(pending.publication.candidate, "base64"),
      fixture.candidate);
    assert.equal(fixture.service.active.opened.publicationState,
      "pending-publication");
  });

test("interrupted compaction publication resumes with shallow witness continuity",
  async (t) => {
    for (const fault of ["replace", "cleanup"]) {
      await t.test(fault, async (t) => {
        const fixture = await compactionFixture(t,
          `scpefe-compact-restart-${fault}-`);
        if (fault === "replace") {
          const faultFs = Object.create(fs);
          let fail = true;
          faultFs.rename = async (source, destination) => {
            if (fail && destination === fixture.target
                && String(source).includes(".scpefe-txn-")) {
              fail = false;
              throw new Error("simulated compaction replace interruption");
            }
            return fs.rename(source, destination);
          };
          fixture.service.fs = faultFs;
          fixture.service.publications.fs = faultFs;
        } else {
          const clear = fixture.service.journals.clear.bind(fixture.service.journals);
          let fail = true;
          fixture.service.journals.clear = async (...args) => {
            if (fail) {
              fail = false;
              throw new Error("simulated compaction cleanup interruption");
            }
            return clear(...args);
          };
        }
        await assert.rejects(
          fixture.service.compactDocument(COMPACTION_CONFIRMATION),
          (error) => error.publicationPrepared === true);
        const pending = await fixture.service.journals.read(
          fixture.documentId, fixture.journalKey);
        assert.equal(pending.publication.purpose, "compaction");

        const restarted = new DocumentService(fixture.options);
        const opened = await restarted.openDocument(
          fixture.target, "recovery or owner password");
        assert.equal(opened.content, "preserved text");
        assert.equal(opened.headMismatch, undefined);
        assert.equal(restarted.active.baseRevision, fixture.compactedHead);
        assert.deepEqual(restarted.active.revisionGraph, [{
          revisionId: fixture.compactedHead,
          parentRevisionIds: [fixture.previousHead],
        }]);
        assert.equal(await restarted.journals.read(
          fixture.documentId, fixture.journalKey), null);
        assert.deepEqual(await fs.readFile(fixture.target), fixture.candidate);
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
  await assert.rejects(service.claimInvitation("short"), /at least 12/);
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
    const pendingClaim = await first.journals.read(
      "31".repeat(16), Buffer.alloc(32, 7));
    assert.equal(pendingClaim.text, "");
    assert.equal(pendingClaim.publication.purpose, "invitation-claim");
    assert.equal(pendingClaim.publication.reopenPassword, replacement);
    assert.equal(Buffer.from(pendingClaim.publication.candidate, "base64").toString(),
      "claimed");
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
    assert.deepEqual(warnings, ["PUBLICATION_RECOVERED"]);
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

test("ordinary pending publications still require candidate plaintext to match", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-candidate-text-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = await writeProfile(directory, "Ada", "Desk PC");
  const base = Buffer.from("container");
  const candidate = Buffer.from("saved:different text");
  const documentId = "71".repeat(16);
  const baseRevision = "72".repeat(32);
  const journalKey = Buffer.alloc(32, 17);
  await fs.writeFile(target, base);
  const native = { openDocument: (bytes) => ({
    content: bytes.toString().startsWith("saved:")
      ? bytes.toString().slice(6) : "base",
    readOnly: true, canEdit: true, documentId, baseRevision,
    journalKey: Buffer.from(journalKey),
  }) };
  const writer = new DocumentService({ native, fs, profilePath,
    publicationCapabilities });
  await writer.journals.write(documentId, journalKey, {
    text: "expected text", baseRevision, cursor: { start: 0, end: 0 },
    target, state: "pending-publication", updateTime: 1,
    publication: {
      id: "73".repeat(16), target,
      transactionFile: path.join(directory, ".document.scpefe-txn-test"),
      baseFile: path.join(directory, ".document.scpefe.scpefe-recovery-base"),
      candidateHash: createHash("sha256").update(candidate).digest("hex"),
      baseHash: createHash("sha256").update(base).digest("hex"),
      base: base.toString("base64"), candidate: candidate.toString("base64"),
      stage: "prepared",
    },
  });

  const warnings = [];
  const restarted = new DocumentService({ native, fs, profilePath,
    publicationCapabilities,
    onJournalWarning: (warning) => warnings.push(warning) });
  const opened = await restarted.openDocument(target, "password words");
  assert.equal(opened.publicationState, "pending-publication");
  assert.equal(await fs.readFile(target, "utf8"), "container");
  assert.equal(warnings.includes("RECOVERY_READ_FAILED"), true);
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

  leasedNative.updateLease(Buffer.from("container"), "password words", {
    active: true, sessionId: "3a".repeat(16), heartbeatCounter: 7,
    holderUtcMs: 9_000_000, durationMs: 600_000, holderName: "Remote editor",
    holderEmail: "remote@example.test", deviceName: "Future clock" });

  const restarted = new DocumentService({ native: leasedNative, fs,
    publicationCapabilities,
    profilePath: path.join(directory, "profile.json"),
    utcNow: () => 1_000, monotonicNow: () => 10 });
  const opened = await restarted.openDocument(target, "password words");
  assert.deepEqual(opened.recovery, { content: "recovered secret",
    cursor: { start: 3, end: 8 }, state: "unsaved", updateTime: 29_000 });
  await assert.rejects(restarted.enterEditMode(), /Restore or discard/);
  let recoveryTakeover;
  await assert.rejects(restarted.restoreRecoveredWork(), (error) => {
    recoveryTakeover = error.takeoverToken;
    return error.code === "LEASE_CLOCK_UNCERTAIN" && Boolean(recoveryTakeover);
  });
  const restored = await restarted.restoreRecoveredWork(
    { takeoverToken: recoveryTakeover });
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
  assert.equal(result.warningCode, "LOCK_CHECKPOINT_FAILED");
  assert.equal(service.active, null);
});

test("lock start is synchronous, once-only, and precedes awaited journal cleanup", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-lock-start-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  await fs.writeFile(target, "container");
  let starts = 0; let finals = 0; let reentrantLock;
  const generation = new SessionGeneration();
  let protections;
  const service = new DocumentService({ fs, publicationCapabilities,
    profilePath: await writeProfile(directory, "Ada", "Desk"),
    native: withLease({ openDocument: () => ({ content: "base", readOnly: true,
      canEdit: true, documentId: "45".repeat(16), baseRevision: "56".repeat(32),
      journalKey: Buffer.alloc(32, 10) }) }),
    onLockStart: ({ reason }) => { starts += 1; generation.invalidate();
      protections?.cancelForLock(); assert.equal(reason, "screen-lock");
      reentrantLock = service.lock("screen-lock"); },
    onLocked: () => { finals += 1; },
  });
  await service.openDocument(target, "password words");
  await service.enterEditMode();
  service.updateWorkingCopy({ content: "plaintext held during flush",
    cursor: { start: 27, end: 27 } });
  let protectionRequest;
  protections = new SessionProtectionCoordinator({ getService: () => service,
    generation, present: (request) => { protectionRequest = request; } });
  const protectedOpen = protections.authorize("open");
  assert.equal(typeof protectionRequest.token, "string");
  let release; let writeStarted;
  const started = new Promise((resolve) => { writeStarted = resolve; });
  const write = service.journals.write.bind(service.journals);
  service.journals.write = async (...args) => { writeStarted();
    await new Promise((resolve) => { release = resolve; }); return write(...args); };
  const locking = service.lock("screen-lock");
  const duplicate = service.lock("screen-lock");
  assert.equal(locking, duplicate); assert.equal(locking, reentrantLock);
  assert.equal(starts, 1); assert.equal(generation.capture(), 1); assert.equal(finals, 0);
  await assert.rejects(protectedOpen, /locked/);
  assert.equal(service.active.working.content, "plaintext held during flush");
  await started; assert.equal(finals, 0); release();
  await locking;
  assert.equal(finals, 1); assert.equal(service.active, null);
  await service.lock("screen-lock");
  assert.equal(starts, 1, "inactive lock does not emit a false lock-start transition");
});

test("inactivity timer starts lock before an awaited journal flush", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-inactivity-start-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe"); await fs.writeFile(target, "container");
  let startLock; const started = new Promise((resolve) => { startLock = resolve; });
  let release; let writeStarted; let final = false;
  const writing = new Promise((resolve) => { writeStarted = resolve; });
  const timers = [];
  const service = new DocumentService({ fs, publicationCapabilities, inactivityMs: 100,
    profilePath: await writeProfile(directory, "Ada", "Desk"),
    native: withLease({ openDocument: () => ({ content: "base", readOnly: true,
      canEdit: true, documentId: "46".repeat(16), baseRevision: "57".repeat(32),
      journalKey: Buffer.alloc(32, 11) }) }),
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer); return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
    onLockStart: ({ reason }) => { assert.equal(reason, "inactivity"); startLock(); },
    onLocked: () => { final = true; },
  });
  await service.openDocument(target, "password words"); await service.enterEditMode();
  service.updateWorkingCopy({ content: "timer plaintext", cursor: { start: 15, end: 15 } });
  const write = service.journals.write.bind(service.journals);
  service.journals.write = async (...args) => {
    writeStarted();
    await new Promise((resolve) => { release = resolve; }); return write(...args); };
  const inactivity = timers.filter(
    (timer) => timer.delay === 100 && !timer.cleared).at(-1);
  assert.ok(inactivity, "active inactivity timer is captured");
  inactivity.callback();
  await started;
  assert.equal(final, false); assert.equal(service.active.working.content, "timer plaintext");
  await writing;
  release();
  await new Promise((resolve) => { const poll = () => final ? resolve() : setImmediate(poll); poll(); });
  assert.equal(service.active, null);
});

test("inactivity lock safely invalidates awaited edit entry and preserves its lease",
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-enter-lock-race-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const target = path.join(directory, "document.scpefe");
    await fs.writeFile(target, "container");
    const timers = [];
    let lockStarted;
    const started = new Promise((resolve) => { lockStarted = resolve; });
    let lockFinished;
    const locked = new Promise((resolve) => { lockFinished = resolve; });
    const native = withLease({ openDocument: () => ({ content: "base", readOnly: true,
      canEdit: true, documentId: "48".repeat(16), baseRevision: "59".repeat(32),
      journalKey: Buffer.alloc(32, 12) }) });
    const service = new DocumentService({ fs, publicationCapabilities, inactivityMs: 100,
      profilePath: await writeProfile(directory, "Ada", "Desk"),
      native,
      setTimer(callback, delay) {
        const timer = { callback, delay, cleared: false };
        timers.push(timer); return timer;
      },
      clearTimer(timer) { timer.cleared = true; },
      onLockStart: ({ reason }) => { assert.equal(reason, "inactivity"); lockStarted(); },
      onLocked: lockFinished,
    });
    await service.openDocument(target, "password words");
    const delayed = delayNextTargetRead(service, target);
    const editing = service.enterEditMode();
    await delayed.readStarted;
    timers.filter((timer) => timer.delay === 100 && !timer.cleared).at(-1).callback();
    await started;
    delayed.release();
    await assert.rejects(editing, (error) => error.code === "SESSION_LOCKED");
    await locked;
    assert.equal(service.active, null);
    const acquired = native.currentLease();
    await service.openDocument(target, "password words");
    await service.enterEditMode();
    assert.equal(native.currentLease().sessionId, acquired.sessionId);
  });

test("inactivity lock fences every lease-acquiring session transition", async (t) => {
  await t.test("identity reconciliation", async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-identity-lock-race-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const target = path.join(directory, "document.scpefe");
    await fs.writeFile(target, "base");
    let reconciliations = 0;
    const native = withLease({
      openDocument() {
        return { content: "secret", readOnly: true, canEdit: true,
          slotIdentityName: "Old Ada", slotIdentityEmail: "old@example.test",
          documentId: "49".repeat(16), baseRevision: "5a".repeat(32),
          journalKey: Buffer.alloc(32, 13) };
      },
      reconcileIdentity() { reconciliations += 1; return Buffer.from("identity"); },
    });
    const service = new DocumentService({ native, fs, publicationCapabilities,
      profilePath: await writeProfile(directory, "Ada", "Desk") });
    await service.openDocument(target, "password words");
    await lockDuringNextLeaseAcquisition({ service, native, target,
      operation: () => service.reconcileIdentity() });
    assert.equal(reconciliations, 0);
  });

  await t.test("recovered work restoration", async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-restore-lock-race-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const target = path.join(directory, "document.scpefe");
    await fs.writeFile(target, "container");
    const native = withLease({ openDocument: () => ({ content: "base", readOnly: true,
      canEdit: true, documentId: "4a".repeat(16), baseRevision: "5b".repeat(32),
      journalKey: Buffer.alloc(32, 14) }) });
    const service = new DocumentService({ native, fs, publicationCapabilities,
      profilePath: await writeProfile(directory, "Ada", "Desk") });
    await service.openDocument(target, "password words");
    service.active.recovery = { text: "recovered", cursor: { start: 3, end: 3 } };
    let activities = 0;
    const notifyActivity = service.notifyActivity.bind(service);
    service.notifyActivity = () => { activities += 1; return notifyActivity(); };
    await lockDuringNextLeaseAcquisition({ service, native, target,
      operation: () => service.restoreRecoveredWork() });
    assert.equal(activities, 0,
      "restoration does not resume activity after lock starts");
  });

  await t.test("divergence resolution", async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-divergence-lock-race-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const fixture = await divergentService(directory);
    await fixture.service.openDocument(fixture.target, "password words");
    let writes = 0;
    const write = fixture.service.journals.write.bind(fixture.service.journals);
    fixture.service.journals.write = async (...args) => {
      writes += 1; return write(...args);
    };
    await lockDuringNextLeaseAcquisition({ service: fixture.service,
      native: fixture.options.native, target: fixture.target,
      operation: () => fixture.service.beginDivergenceResolution() });
    assert.equal(writes, 0, "no merge draft is persisted after lock starts");
  });

  await t.test("provisional discard", async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-discard-lock-race-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const target = path.join(directory, "document.scpefe");
    await fs.writeFile(target, JSON.stringify({ content: "provisional", sealed: false }));
    let discards = 0;
    const native = withLease({
      openDocument(bytes) {
        const value = JSON.parse(bytes.toString());
        return { content: value.content, readOnly: true, canEdit: true,
          manuallySealed: value.sealed, documentId: "4c".repeat(16),
          baseRevision: "5d".repeat(32), journalKey: Buffer.alloc(32, 15) };
      },
      discardProvisional() {
        discards += 1;
        return Buffer.from(JSON.stringify({ content: "sealed", sealed: true }));
      },
    });
    const service = new DocumentService({ native, fs, publicationCapabilities,
      profilePath: await writeProfile(directory, "Ada", "Desk") });
    await service.openDocument(target, "password words");
    service.active.recovery = { text: "provisional", cursor: { start: 11, end: 11 } };
    await lockDuringNextLeaseAcquisition({ service, native, target,
      operation: () => service.discardRecoveredWork() });
    assert.equal(discards, 0);
  });
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
  assert.deepEqual(warnings, ["PUBLICATION_RECOVERED"]);
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
    publicationCapabilities, platform: "win32",
    profilePath: path.join(directory, "profile.json"),
    native: withLease({ openDocument: () => ({ content: "original", readOnly: true,
      canEdit: false, documentId: "88".repeat(16),
      baseRevision: "99".repeat(32), journalKey: Buffer.alloc(32, 13) }) }) });
  await assert.rejects(service.exportPlaintext(lfExport, {
    content: "secret", lineEndings: "lf",
  }), /Open a document/);
  await service.openDocument(target, "password words");
  await assert.rejects(service.exportPlaintext(
    path.join(directory, "DOCUMENT.SCPEFE"), {
      content: "secret", lineEndings: "lf",
    }), /cannot replace or alias the active encrypted container/);
  await assert.rejects(service.exportPlaintext(target, {
    content: "secret", lineEndings: "lf",
  }), /cannot replace or alias the active encrypted container/);
  assert.equal(await fs.readFile(target, "utf8"), "encrypted container and metadata");
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
  await first.runLifecycleBarrier(() => {});
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
  let takeover;
  await assert.rejects(forced.enterEditMode(), (error) => {
    takeover = error.takeoverToken;
    return error.code === "LEASE_CLOCK_UNCERTAIN" && Boolean(takeover);
  });
  await forced.enterEditMode({ takeoverToken: takeover });
  assert.equal(native.currentLease().holderName, "Katherine");
});

test("lease takeover tokens reject cancellation, replay, and changed lease evidence", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-token-race-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  await fs.writeFile(target, "container");
  const native = withLease({ openDocument: () => ({ content: "base", readOnly: true,
    canEdit: true, documentId: "ce".repeat(16), baseRevision: "df".repeat(32),
    journalKey: Buffer.alloc(32, 15) }) });
  const holder = new DocumentService({ native, fs, publicationCapabilities,
    profilePath: await writeProfile(directory, "Ada", "Future"),
    utcNow: () => 9_000_000, monotonicNow: () => 0 });
  await holder.openDocument(target, "password words");
  await holder.enterEditMode();
  const observer = new DocumentService({ native, fs, publicationCapabilities,
    profilePath: await writeProfile(directory, "Grace", "Desk"),
    utcNow: () => 1_000, monotonicNow: () => 10 });
  await observer.openDocument(target, "password words");

  let canceled;
  await assert.rejects(observer.enterEditMode(), (error) => {
    canceled = error.takeoverToken; return error.code === "LEASE_CLOCK_UNCERTAIN";
  });
  assert.equal(observer.cancelLeaseTakeover(canceled), true);
  await assert.rejects(observer.enterEditMode({ takeoverToken: canceled }),
    (error) => error.code === "LEASE_CHANGED");

  let raced;
  await assert.rejects(observer.enterEditMode(), (error) => {
    raced = error.takeoverToken; return error.code === "LEASE_CLOCK_UNCERTAIN";
  });
  const changedLease = { ...native.currentLease(), heartbeatCounter: 2 };
  native.updateLease(Buffer.from("container"), "password words", changedLease);
  await assert.rejects(observer.enterEditMode({ takeoverToken: raced }),
    (error) => error.code === "LEASE_CHANGED");

  let accepted;
  await assert.rejects(observer.enterEditMode(), (error) => {
    accepted = error.takeoverToken; return error.code === "LEASE_CLOCK_UNCERTAIN";
  });
  await observer.enterEditMode({ takeoverToken: accepted });
  await assert.rejects(observer.enterEditMode({ takeoverToken: accepted }),
    (error) => error.code === "LEASE_CHANGED");
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

test("real lease-refresh failure starts lock before final journal cleanup", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-lease-fail-start-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe"); await fs.writeFile(target, "container");
  const native = withLease({ openDocument: () => ({ content: "base", readOnly: true,
    canEdit: true, documentId: "47".repeat(16), baseRevision: "58".repeat(32),
    journalKey: Buffer.alloc(32, 12) }) });
  const timers = []; let startLock; let final = false; let release; let writeStarted;
  const started = new Promise((resolve) => { startLock = resolve; });
  const writing = new Promise((resolve) => { writeStarted = resolve; });
  const service = new DocumentService({ native, fs, publicationCapabilities,
    inactivityMs: 999_999, profilePath: await writeProfile(directory, "Ada", "Desk"),
    setTimer(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimer() {}, onLockStart: ({ reason }) => {
      assert.equal(reason, "lease-refresh-failed"); startLock(); },
    onLocked: () => { final = true; } });
  await service.openDocument(target, "password words"); await service.enterEditMode();
  service.updateWorkingCopy({ content: "lease failure plaintext", cursor: { start: 23, end: 23 } });
  service.fs = { ...fs, async readFile(file, ...args) {
    if (file === target) throw new Error("injected lease provider failure");
    return fs.readFile(file, ...args);
  } };
  const write = service.journals.write.bind(service.journals);
  service.journals.write = async (...args) => {
    writeStarted();
    await new Promise((resolve) => { release = resolve; }); return write(...args); };
  timers.find((timer) => timer.delay === 120_000).callback();
  await started;
  assert.equal(final, false);
  assert.equal(service.active.working.content, "lease failure plaintext");
  await writing;
  release();
  await new Promise((resolve) => { const poll = () => final ? resolve() : setImmediate(poll); poll(); });
  assert.equal(service.active, null);
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

function mergeContainer(content, head, graph) {
  return Buffer.from(JSON.stringify({ content, head, graph }));
}

function mergeNative(documentId, journalKey, mergedHead) {
  const native = {
    openDocument(bytes) {
      const parsed = JSON.parse(bytes.toString());
      return { content: parsed.content, readOnly: true, canEdit: true,
        documentId, baseRevision: parsed.head, revisionGraph: parsed.graph,
        journalKey: Buffer.from(journalKey) };
    },
    mergeDocument(currentBytes, localBytes, _password, input) {
      const current = JSON.parse(currentBytes.toString());
      const local = JSON.parse(localBytes.toString());
      return mergeContainer(input.content, mergedHead,
        [...current.graph, ...local.graph.filter((candidate) =>
          !current.graph.some((node) => node.revisionId === candidate.revisionId)),
        { revisionId: mergedHead,
          parentRevisionIds: [local.head, current.head] }]);
    },
  };
  return withLease(native);
}

async function divergentService(directory) {
  const target = path.join(directory, "document.scpefe");
  const documentId = "71".repeat(16);
  const journalKey = Buffer.alloc(32, 41);
  const ancestor = "72".repeat(32);
  const local = "73".repeat(32);
  const current = "74".repeat(32);
  const merged = "75".repeat(32);
  const ancestorBytes = mergeContainer("base", ancestor,
    [{ revisionId: ancestor, parentRevisionIds: [] }]);
  const localBytes = mergeContainer("local branch", local,
    [{ revisionId: ancestor, parentRevisionIds: [] },
      { revisionId: local, parentRevisionIds: [ancestor] }]);
  const currentBytes = mergeContainer("current branch", current,
    [{ revisionId: ancestor, parentRevisionIds: [] },
      { revisionId: current, parentRevisionIds: [ancestor] }]);
  await fs.writeFile(target, currentBytes);
  const options = { native: mergeNative(documentId, journalKey, merged), fs,
    publicationCapabilities, profilePath: await writeProfile(directory, "Ada", "Desk") };
  const service = new DocumentService(options);
  let record = await service.publications.prepare({ documentId, journalKey, target,
    base: ancestorBytes, candidate: localBytes, text: "local branch",
    cursor: { start: 0, end: 0 }, baseRevision: ancestor });
  record = await service.publications.markDiverged(documentId, journalKey, record);
  return { service, options, target, documentId, journalKey, ancestor,
    local, current, merged, record };
}

test("resolves an overlapping divergence only after markers are removed", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-merge-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixture = await divergentService(directory);
  const opened = await fixture.service.openDocument(fixture.target, "password words");
  assert.equal(opened.publicationState, "conflict");
  fixture.options.native.updateLease(Buffer.from("ignored"), "password words", {
    active: true, sessionId: "4b".repeat(16), heartbeatCounter: 3,
    holderUtcMs: Date.now() + 9_000_000, durationMs: 600_000,
    holderName: "Remote editor", holderEmail: "remote@example.test",
    deviceName: "Future clock" });
  let divergenceTakeover;
  await assert.rejects(fixture.service.beginDivergenceResolution(), (error) => {
    divergenceTakeover = error.takeoverToken;
    return error.code === "LEASE_CLOCK_UNCERTAIN" && Boolean(divergenceTakeover);
  });
  const draft = await fixture.service.beginDivergenceResolution(
    { takeoverToken: divergenceTakeover });
  assert.equal(draft.ancestorRevision, fixture.ancestor);
  assert.equal(draft.localRevision, fixture.local);
  assert.equal(draft.currentRevision, fixture.current);
  assert.match(draft.content, /^<<<<<<< local/m);
  await assert.rejects(fixture.service.saveDivergenceResolution(draft.content),
    /every conflict marker/);
  assert.deepEqual(await fixture.service.saveDivergenceResolution("resolved text"),
    { saved: true, content: "resolved text", publicationState: "target-published" });
  const published = fixture.options.native.openDocument(
    await fs.readFile(fixture.target), "password words");
  const mergeNode = published.revisionGraph.find(
    (node) => node.revisionId === fixture.merged);
  assert.deepEqual(mergeNode.parentRevisionIds, [fixture.local, fixture.current]);
});

test("merge drafts survive restart and authenticated journal tampering is rejected", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-merge-restart-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixture = await divergentService(directory);
  await fixture.service.openDocument(fixture.target, "password words");
  await fixture.service.beginDivergenceResolution();
  fixture.service.updateWorkingCopy({ content: "partly resolved",
    cursor: { start: 5, end: 5 } });
  await fixture.service.lock("restart");
  const restarted = new DocumentService(fixture.options);
  const opened = await restarted.openDocument(fixture.target, "password words");
  assert.equal(opened.content, "partly resolved");
  assert.equal(opened.publicationState, "conflict");

  const journalPath = path.join(directory, "work-journals",
    `${fixture.documentId}.work-journal`);
  const envelope = JSON.parse(await fs.readFile(journalPath, "utf8"));
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
  await fs.writeFile(journalPath, JSON.stringify(envelope));
  await assert.rejects(restarted.journals.read(
    fixture.documentId, fixture.journalKey));
  assert.equal(JSON.parse((await fs.readFile(fixture.target)).toString()).content,
    "current branch");
});

test("target revalidation prevents a changed head from being overwritten", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-merge-race-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixture = await divergentService(directory);
  await fixture.service.openDocument(fixture.target, "password words");
  await fixture.service.beginDivergenceResolution();
  const changed = "76".repeat(32);
  await fs.writeFile(fixture.target, mergeContainer("newer current", changed,
    [{ revisionId: fixture.ancestor, parentRevisionIds: [] },
      { revisionId: changed, parentRevisionIds: [fixture.ancestor] }]));
  await assert.rejects(fixture.service.saveDivergenceResolution("resolved text"),
    (error) => error.code === "MERGE_TARGET_CHANGED");
  assert.equal(JSON.parse((await fs.readFile(fixture.target)).toString()).head, changed);
});

test("a target race after merge revalidation preserves the newer replica", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-merge-publish-race-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixture = await divergentService(directory);
  await fixture.service.openDocument(fixture.target, "password words");
  await fixture.service.beginDivergenceResolution();
  const racedHead = "77".repeat(32);
  const racedBytes = mergeContainer("raced current", racedHead,
    [{ revisionId: fixture.ancestor, parentRevisionIds: [] },
      { revisionId: racedHead, parentRevisionIds: [fixture.ancestor] }]);
  let publicationTargetReads = 0;
  fixture.service.publications.fs = new Proxy(fs, { get(target, property) {
    if (property !== "readFile") return target[property];
    return async (file, ...args) => {
      const bytes = await target.readFile(file, ...args);
      if (file === fixture.target && ++publicationTargetReads === 1) {
        await target.writeFile(file, racedBytes);
      }
      return bytes;
    };
  } });
  await assert.rejects(fixture.service.saveDivergenceResolution("resolved text"),
    (error) => error.publicationPrepared === true);
  assert.deepEqual(await fs.readFile(fixture.target), racedBytes);
  const journal = await fixture.service.journals.read(
    fixture.documentId, fixture.journalKey);
  assert.equal(journal.state, "pending-publication");
  assert.equal(journal.text, "resolved text");
});

test("validated client settings opt into cumulative regular provisional saves", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-regular-save-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = await writeProfile(directory, "Ada", "Desk PC");
  const settingsPath = path.join(directory, "settings.json");
  const initial = Buffer.from(JSON.stringify({ content: "base", sealed: true,
    parent: null }));
  await fs.writeFile(target, initial);
  const revisionId = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const regularInputs = [];
  const native = withLease({
    openDocument(bytes) {
      const value = JSON.parse(bytes.toString());
      const head = revisionId(bytes);
      return { content: value.content, readOnly: true, canEdit: true,
        manuallySealed: value.sealed, documentId: "15".repeat(16),
        baseRevision: head, journalKey: Buffer.alloc(32, 15),
        revisionGraph: [{ revisionId: value.parent ?? head,
          parentRevisionIds: [] }, ...(value.parent ? [{ revisionId: head,
            parentRevisionIds: [value.parent] }] : [])] };
    },
    regularSaveDocument(bytes, _password, input) {
      const value = JSON.parse(bytes.toString());
      const parent = value.sealed ? revisionId(bytes) : value.parent;
      regularInputs.push({ content: input.content, parent });
      return Buffer.from(JSON.stringify({ content: input.content,
        sealed: false, parent, base: value.sealed ? value : value.base }));
    },
    saveDocument(bytes, _password, input) {
      const value = JSON.parse(bytes.toString());
      return Buffer.from(JSON.stringify({ content: input.content, sealed: true,
        parent: value.sealed ? revisionId(bytes) : value.parent }));
    },
    discardProvisional(bytes) {
      const value = JSON.parse(bytes.toString());
      return Buffer.from(JSON.stringify(value.base));
    },
  });
  const timers = [];
  const service = new DocumentService({ native, fs, profilePath, settingsPath,
    publicationCapabilities, setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false }; timers.push(timer); return timer;
    }, clearTimer(timer) { timer.cleared = true; } });

  assert.deepEqual(await service.loadClientSettings(), {
    regularSaveEnabled: false, regularSaveIntervalMs: 120_000 });
  await assert.rejects(service.saveClientSettings({ regularSaveEnabled: true,
    regularSaveIntervalMs: 9999 }), /between 10 seconds and 24 hours/);
  assert.deepEqual(await service.saveClientSettings({ regularSaveEnabled: true,
    regularSaveIntervalMs: 15_000 }), {
    regularSaveEnabled: true, regularSaveIntervalMs: 15_000 });
  await service.openDocument(target, "password words");
  await service.enterEditMode();
  assert.equal(timers.some((timer) => timer.delay === 15_000), true);

  service.updateWorkingCopy({ content: "first", cursor: { start: 5, end: 5 } });
  assert.deepEqual(await service.regularSaveDocument(), {
    published: true, provisional: true, content: "first" });
  const firstParent = regularInputs[0].parent;
  assert.equal(service.active.manuallySealed, false);
  assert.equal(service.active.dirty, true);
  service.updateWorkingCopy({ content: "second", cursor: { start: 6, end: 6 } });
  await service.regularSaveDocument();
  assert.equal(regularInputs.length, 2);
  assert.equal(regularInputs[1].parent, firstParent);
  assert.equal(service.active.revisionGraph.length, 2);

  await service.saveDocument("second");
  assert.equal(service.active.manuallySealed, true);
  assert.equal(service.active.dirty, false);
  assert.equal((await service.journals.read(
    service.active.documentId, service.active.journalKey)), null);

  service.updateWorkingCopy({ content: "third", cursor: { start: 5, end: 5 } });
  await service.regularSaveDocument();
  await service.lock("crash-restart");
  const recovered = await service.openDocument(target, "password words");
  assert.equal(recovered.provisional, true);
  assert.equal(recovered.recovery.content, "third");
  const discarded = await service.discardRecoveredWork();
  assert.equal(discarded.content, "second");
  assert.equal(discarded.provisional, undefined);
});

async function regularPublicationFixture(directory) {
  const target = path.join(directory, "document.scpefe");
  const profilePath = await writeProfile(directory, "Ada", "Desk PC");
  const settingsPath = path.join(directory, "settings.json");
  const initial = Buffer.from(JSON.stringify({ content: "base", sealed: true,
    parent: null }));
  await fs.writeFile(target, initial);
  const revisionId = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const native = withLease({
    openDocument(bytes) {
      const value = JSON.parse(bytes.toString());
      const head = revisionId(bytes);
      return { content: value.content, readOnly: true, canEdit: true,
        manuallySealed: value.sealed, documentId: "25".repeat(16),
        baseRevision: head, journalKey: Buffer.alloc(32, 25),
        revisionGraph: [{ revisionId: value.parent ?? head,
          parentRevisionIds: [] }, ...(value.parent ? [{ revisionId: head,
            parentRevisionIds: [value.parent] }] : [])] };
    },
    regularSaveDocument(bytes, _password, input) {
      const value = JSON.parse(bytes.toString());
      const parent = value.sealed ? revisionId(bytes) : value.parent;
      return Buffer.from(JSON.stringify({ content: input.content,
        sealed: false, parent, base: value.sealed ? value : value.base }));
    },
    saveDocument(bytes, _password, input) {
      const value = JSON.parse(bytes.toString());
      return Buffer.from(JSON.stringify({ content: input.content, sealed: true,
        parent: value.sealed ? revisionId(bytes) : value.parent }));
    },
    mergeDocument(currentBytes, localBytes, _password, input) {
      return Buffer.from(JSON.stringify({ content: input.content, sealed: true,
        parent: revisionId(currentBytes), localParent: revisionId(localBytes) }));
    },
    discardProvisional(bytes) {
      return Buffer.from(JSON.stringify(JSON.parse(bytes.toString()).base));
    },
  });
  const options = { native, fs, profilePath, settingsPath,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    publicationCapabilities };
  const service = new DocumentService(options);
  await service.saveClientSettings({ regularSaveEnabled: true,
    regularSaveIntervalMs: 120_000 });
  await service.openDocument(target, "password words");
  await service.enterEditMode();
  service.updateWorkingCopy({ content: "local unsaved",
    cursor: { start: 13, end: 13 } });
  return { service, options, target, initial, revisionId };
}

test("real service staged Open faults and lock fences preserve original journal and restart",
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-real-open-stage-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const fixture = await regularPublicationFixture(directory);
    const original = fixture.service;
    const active = original.active;
    await original.journals.write(active.documentId, active.journalKey, {
      text: active.working.content, baseRevision: active.baseRevision,
      cursor: { ...active.working.cursor }, target: active.target, state: "unsaved",
      updateTime: Date.now(),
    });
    const assertOriginal = async () => {
      assert.equal(original.active, active);
      assert.equal(original.active.working.content, "local unsaved");
      assert.equal((await original.journals.read(active.documentId,
        active.journalKey)).text, "local unsaved");
    };

    await t.test("Open authentication failure", async () => {
      const native = fixture.options.native;
      const coordinator = new ReplacementCoordinator({
        makeCandidate: () => new DocumentService({ ...fixture.options,
          native: { ...native, openDocument(bytes, password) {
            if (password === "wrong password") throw new Error("authentication failed");
            return native.openDocument(bytes, password);
          } } }),
        authorizeCurrent: async (_operation, commit) => { await commit(); return true; },
        adopt: () => assert.fail("authentication failure must not adopt"),
      });
      await assert.rejects(coordinator.open(fixture.target, "wrong password"),
        /authentication failed/);
      await assertOriginal();
    });
    await t.test("Open post-approval revalidation failure", async () => {
      const candidate = new DocumentService(fixture.options);
      candidate.revalidateTargetForReplacement = async () => {
        throw new Error("injected revalidation failure");
      };
      const coordinator = new ReplacementCoordinator({ makeCandidate: () => candidate,
        authorizeCurrent: async (_operation, commit) => { await commit(); return true; },
        adopt: () => assert.fail("revalidation failure must not adopt") });
      await assert.rejects(coordinator.open(fixture.target, "password words"),
        /revalidation failure/);
      await assertOriginal();
    });
    for (const stage of ["authentication stage", "adoption revalidation"]) {
      await t.test(`Open auto-lock during ${stage}`, async () => {
        const generation = new SessionGeneration();
        const candidate = new DocumentService(fixture.options);
        let release; let started;
        const waiting = new Promise((resolve) => { started = resolve; });
        if (stage === "authentication stage") {
          const open = candidate.openDocument.bind(candidate);
          candidate.openDocument = async (...args) => { started();
            await new Promise((resolve) => { release = resolve; }); return open(...args); };
        } else {
          const revalidate = candidate.revalidateTargetForReplacement.bind(candidate);
          candidate.revalidateTargetForReplacement = async (...args) => { started();
            await new Promise((resolve) => { release = resolve; }); return revalidate(...args); };
        }
        const coordinator = new ReplacementCoordinator({ generation,
          makeCandidate: () => candidate,
          authorizeCurrent: async (_operation, commit) => { await commit(); return true; },
          adopt: () => assert.fail("locked stage must not adopt") });
        const opening = coordinator.open(fixture.target, "password words");
        await waiting; generation.invalidate(); release();
        await assert.rejects(opening, /session locked/);
        await assertOriginal();
      });
    }
    const restarted = new DocumentService(fixture.options);
    const reopened = await restarted.openDocument(fixture.target, "password words");
    assert.equal(reopened.recovery.content, "local unsaved");
  });

test("real DocumentService New candidate faults, lock fencing, cleanup, and retry", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-real-new-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const originalFixture = await regularPublicationFixture(directory);
  const original = originalFixture.service; const active = original.active;
  await original.journals.write(active.documentId, active.journalKey, {
    text: active.working.content, baseRevision: active.baseRevision,
    cursor: { ...active.working.cursor }, target: active.target, state: "unsaved",
    updateTime: Date.now(),
  });
  const profilePath = originalFixture.options.profilePath;
  const target = path.join(directory, "new.scpefe");
  const request = { ownerPassword: "owner password words", recoveryPassword: "",
    ownerPasswordConfirmation: "owner password words", recoveryPasswordConfirmation: "",
    content: "", understandsIrrecoverable: true, storedRecoverySeparately: false };
  const makeCandidate = ({ createFault = false, editFault = false, gate = null } = {}) => {
    let lease = { active: false, sessionId: "0".repeat(32), heartbeatCounter: 0,
      holderUtcMs: 0, durationMs: 600_000, holderName: "", holderEmail: "", deviceName: "" };
    const native = { createDocument() {
      if (createFault) throw new Error("injected native create failure");
      return Buffer.from("real-created-container");
    }, openDocument(bytes, password) {
      assert.equal(bytes.toString(), "real-created-container");
      assert.equal(password, "owner password words");
      return { content: "", readOnly: true, canEdit: true, manuallySealed: true,
        documentId: "48".repeat(16), baseRevision: "59".repeat(32),
        revisionGraph: [{ revisionId: "59".repeat(32), parentRevisionIds: [] }],
        journalKey: Buffer.alloc(32, 13), lease: { ...lease } };
    }, updateLease(bytes, _password, next) {
      if (editFault) throw new Error("injected enter-edit lease failure");
      lease = { ...next }; return Buffer.from(bytes);
    } };
    let readAfterCreate = false;
    const candidateFs = gate ? { ...fs, async readFile(file, ...args) {
      if (file === target && !readAfterCreate) {
        readAfterCreate = true; gate.started();
        await new Promise((resolve) => { gate.release = resolve; });
      }
      return fs.readFile(file, ...args);
    } } : fs;
    return new DocumentService({ native, fs: candidateFs, profilePath,
      publicationCapabilities, journalDirectory: path.join(directory, "candidate-journals"),
      witnessDirectory: path.join(directory, "candidate-witnesses") });
  };
  for (const [name, options, pattern] of [
    ["native create failure", { createFault: true }, /native create failure/],
    ["enter-edit failure", { editFault: true }, /enter-edit lease failure/],
  ]) await t.test(name, async () => {
    const coordinator = new ReplacementCoordinator({ makeCandidate: () => makeCandidate(options),
      authorizeCurrent: async (_operation, commit) => { await commit(); return true; },
      adopt: () => assert.fail("failed New must not adopt") });
    await assert.rejects(coordinator.create(target, request), pattern);
    assert.equal(await fs.stat(target).then(() => true, () => false), false);
    assert.equal(original.active, active);
    assert.equal((await original.journals.read(active.documentId,
      active.journalKey)).text, "local unsaved");
  });
  const generation = new SessionGeneration(); let startGate;
  const gate = { started: () => startGate() }; let fencedCandidate;
  const coordinator = new ReplacementCoordinator({ generation,
    makeCandidate: () => { fencedCandidate = makeCandidate({ gate }); return fencedCandidate; },
    authorizeCurrent: async (_operation, commit) => { await commit(); return true; },
    adopt: () => assert.fail("locked New must not adopt") });
  const started = new Promise((resolve) => { startGate = resolve; });
  const creating = coordinator.create(target, request);
  await started; generation.invalidate(); gate.release();
  await assert.rejects(creating, /session locked/);
  assert.equal(await fs.stat(target).then(() => true, () => false), false);
  assert.equal(original.active, active);

  let adopted; const retry = new ReplacementCoordinator({ generation,
    makeCandidate: () => makeCandidate(),
    authorizeCurrent: async (_operation, commit) => { await commit(); return true; },
    adopt: (staged) => { adopted = staged.candidate; } });
  const opened = await retry.create(target, request);
  assert.equal(opened.content, ""); assert.ok(adopted instanceof DocumentService);
  await adopted.abandonCreatedDocument();
  assert.equal(await fs.stat(target).then(() => true, () => false), false);
  assert.equal((await original.journals.read(active.documentId,
    active.journalKey)).text, "local unsaved");
});

for (const stage of ["prepare-write", "atomic-rename", "cleanup-directory-flush"]) {
  test(`integrated lifecycle publication fault | ${stage} | real journal restart and retry`,
    async (t) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), `scpefe-lifecycle-${stage}-`));
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      const fixture = await regularPublicationFixture(directory);
      let failed = false;
      if (stage === "prepare-write") {
        const prepare = fixture.service.publications.prepare.bind(fixture.service.publications);
        fixture.service.publications.prepare = async (...args) => {
          const record = await prepare(...args);
          if (!failed) { failed = true; throw new Error("injected prepare write acknowledgement fault"); }
          return record;
        };
      } else if (stage === "atomic-rename") {
        fixture.service.publications.fs = new Proxy(fs, { get(target, property) {
          if (property !== "rename") return target[property];
          return async (...args) => {
            if (!failed) { failed = true; throw new Error("injected atomic rename fault"); }
            return target.rename(...args);
          };
        } });
      } else {
        const clear = fixture.service.journals.clear.bind(fixture.service.journals);
        fixture.service.publications.journals = new Proxy(fixture.service.journals,
          { get(target, property) {
            if (property !== "clear") {
              const value = target[property];
              return typeof value === "function" ? value.bind(target) : value;
            }
            return async (...args) => {
              if (!failed) { failed = true; throw new Error("injected cleanup directory flush fault"); }
              return clear(...args);
            };
          } });
      }
      let request; let closes = 0;
      const protections = new SessionProtectionCoordinator({
        getService: () => fixture.service, present: (value) => { request = value; },
      });
      const lifecycle = new NativeLifecycleCoordinator({
        getService: () => fixture.service, protections,
        lockActive: (reason) => fixture.service.lock(reason),
        closeWindow: () => { closes += 1; }, report: () => {},
      });
      const closing = lifecycle.requestExit();
      const first = await protections.decide({ token: request.token, decision: "save" });
      assert.equal(first.completed, false);
      assert.equal(fixture.service.active.working.content, "local unsaved");
      assert.equal(closes, 0);
      const pending = await fixture.service.journals.read(
        fixture.service.active.documentId, fixture.service.active.journalKey);
      assert.equal(typeof pending.publication.stage, "string");
      fixture.service.publications.fs = fs;
      const canceled = assert.rejects(closing, /locked/);
      assert.equal(protections.cancelForLock(), true);
      await canceled;
      const restarted = new DocumentService(fixture.options);
      const opened = await restarted.openDocument(fixture.target, "password words");
      assert.equal(opened.content, "local unsaved");
      assert.equal(restarted.active.pendingPublication, false);
      assert.equal(await restarted.journals.read(restarted.active.documentId,
        restarted.active.journalKey), null);
      assert.equal(closes, 0);
    });
}

test("regular-save divergence remains restart-safe and accessible", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-regular-diverged-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixture = await regularPublicationFixture(directory);
  const initialHead = fixture.revisionId(fixture.initial);
  const remote = Buffer.from(JSON.stringify({ content: "remote", sealed: true,
    parent: initialHead }));
  await fs.writeFile(fixture.target, remote);

  assert.deepEqual(await fixture.service.regularSaveDocument(), {
    published: false, conflict: true, content: "local unsaved" });
  const record = await fixture.service.journals.read(
    fixture.service.active.documentId, fixture.service.active.journalKey);
  assert.equal(record.state, "conflict");
  assert.equal(record.publication.purpose, "regular-save");

  const restarted = new DocumentService(fixture.options);
  const opened = await restarted.openDocument(fixture.target, "password words");
  assert.equal(opened.publicationState, "conflict");
  assert.equal(opened.content, "local unsaved");
  assert.equal(restarted.active.pendingRecord.state, "conflict");
});

test("second regular save resolves divergence from the sealed ancestor", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),
    "scpefe-regular-second-diverged-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixture = await regularPublicationFixture(directory);
  await fixture.service.regularSaveDocument();
  fixture.service.updateWorkingCopy({ content: "local amended",
    cursor: { start: 13, end: 13 } });
  const remote = Buffer.from(JSON.stringify({ content: "remote", sealed: true,
    parent: fixture.revisionId(fixture.initial) }));
  let publicationTargetReads = 0;
  fixture.service.publications.fs = new Proxy(fs, { get(target, property) {
    if (property !== "readFile") return target[property];
    return async (file, ...args) => {
      const bytes = await target.readFile(file, ...args);
      if (file === fixture.target && ++publicationTargetReads === 1) {
        await target.writeFile(file, remote);
      }
      return bytes;
    };
  } });

  await assert.rejects(fixture.service.regularSaveDocument(),
    (error) => error.publicationPrepared === true);
  const record = await fixture.service.journals.read(
    fixture.service.active.documentId, fixture.service.active.journalKey);
  assert.deepEqual(Buffer.from(record.publication.mergeAncestor, "base64"),
    fixture.initial);
  await fixture.service.exitEditMode();

  const restarted = new DocumentService(fixture.options);
  const opened = await restarted.openDocument(fixture.target, "password words");
  assert.equal(opened.publicationState, "conflict");
  assert.equal(opened.content, "local amended");
  const draft = await restarted.beginDivergenceResolution();
  assert.equal(draft.ancestorRevision, fixture.revisionId(fixture.initial));
  assert.match(draft.content, /^<<<<<<< local/m);
  assert.deepEqual(await restarted.saveDivergenceResolution("resolved"), {
    saved: true, content: "resolved", publicationState: "target-published" });
  const published = JSON.parse(await fs.readFile(fixture.target, "utf8"));
  assert.equal(published.content, "resolved");
  assert.equal(published.sealed, true);
  assert.equal(restarted.active.pendingPublication, false);
});

async function interruptSecondRegularSave(fixture) {
  await fixture.service.regularSaveDocument();
  fixture.service.updateWorkingCopy({ content: "local amended",
    cursor: { start: 13, end: 13 } });
  fixture.service.publications.fs = new Proxy(fs, { get(target, property) {
    if (property !== "rename") return target[property];
    return async () => {
      const error = new Error("provider unavailable before replacement");
      error.code = "ENOENT";
      throw error;
    };
  } });
  assert.deepEqual(await fixture.service.regularSaveDocument(), {
    published: false });
  assert.equal(fixture.service.active.pendingPublication, true);
  assert.equal(JSON.parse(await fs.readFile(fixture.target, "utf8")).content,
    "local unsaved");
}

test("discard close restores sealed base after interrupted second regular save", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),
    "scpefe-regular-close-discard-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixture = await regularPublicationFixture(directory);
  await interruptSecondRegularSave(fixture);
  fixture.service.publications.fs = fs;

  assert.equal(await applyCloseDecision(fixture.service, "discard"), true);
  assert.deepEqual(await fs.readFile(fixture.target), fixture.initial);
  assert.equal(fixture.service.active.manuallySealed, true);
  assert.equal(fixture.service.active.pendingPublication, false);

  const restarted = new DocumentService(fixture.options);
  const opened = await restarted.openDocument(fixture.target, "password words");
  assert.equal(opened.content, "base");
  assert.equal(opened.provisional, undefined);
  assert.equal(restarted.active.manuallySealed, true);
});

test("discard close refuses while interrupted regular-save target is unavailable",
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(),
      "scpefe-regular-close-unavailable-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const fixture = await regularPublicationFixture(directory);
    await interruptSecondRegularSave(fixture);
    const unavailableFs = new Proxy(fs, { get(target, property) {
      if (property !== "readFile") return target[property];
      return async (file, ...args) => {
        if (file === fixture.target) {
          const error = new Error("provider unavailable");
          error.code = "ENOENT";
          throw error;
        }
        return target.readFile(file, ...args);
      };
    } });
    fixture.service.fs = unavailableFs;
    fixture.service.publications.fs = unavailableFs;

    await assert.rejects(applyCloseDecision(fixture.service, "discard"),
      (error) => error.code === "CLOSE_DISCARD_BLOCKED");
    assert.equal(fixture.service.active.pendingPublication, true);
    assert.equal(JSON.parse(await fs.readFile(fixture.target, "utf8")).sealed, false);
  });

for (const fault of ["before-replace", "race", "post-replace"]) {
  test(`regular-save ${fault} recovers as logically unsaved`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(),
      `scpefe-regular-${fault}-`));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const fixture = await regularPublicationFixture(directory);
    if (fault === "before-replace") {
      fixture.service.publications.fs = new Proxy(fs, { get(target, property) {
        if (property !== "rename") return target[property];
        return async () => { throw new Error("injected crash before replace"); };
      } });
    } else if (fault === "race") {
      let targetReads = 0;
      const remote = Buffer.from(JSON.stringify({ content: "remote", sealed: true,
        parent: fixture.revisionId(fixture.initial) }));
      fixture.service.publications.fs = new Proxy(fs, { get(target, property) {
        if (property !== "readFile") return target[property];
        return async (file, ...args) => {
          const bytes = await target.readFile(file, ...args);
          if (file === fixture.target && ++targetReads === 1) {
            await target.writeFile(file, remote);
          }
          return bytes;
        };
      } });
    } else {
      let failClear = true;
      fixture.service.publications.journals = new Proxy(fixture.service.journals,
        { get(target, property) {
          if (property !== "clear") {
            const value = target[property];
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (...args) => {
            if (failClear) { failClear = false; throw new Error("injected post-replace crash"); }
            return target.clear(...args);
          };
        } });
    }
    await assert.rejects(fixture.service.regularSaveDocument(),
      (error) => error.publicationPrepared === true);

    const restarted = new DocumentService(fixture.options);
    const opened = await restarted.openDocument(fixture.target, "password words");
    if (fault === "race") {
      assert.equal(opened.publicationState, "conflict");
      assert.equal(opened.content, "local unsaved");
    } else {
      assert.equal(opened.provisional, true);
      assert.equal(opened.recovery.content, "local unsaved");
      assert.equal(restarted.active.manuallySealed, false);
    }
  });
}

for (const fault of ["before-replace", "race", "post-replace"]) {
  test(`provisional discard ${fault} recovers safely`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(),
      `scpefe-discard-${fault}-`));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const fixture = await regularPublicationFixture(directory);
    await fixture.service.regularSaveDocument();
    if (fault === "before-replace") {
      fixture.service.publications.fs = new Proxy(fs, { get(target, property) {
        if (property !== "rename") return target[property];
        return async () => { throw new Error("discard crash before replace"); };
      } });
    } else if (fault === "race") {
      let targetReads = 0;
      const remote = Buffer.from(JSON.stringify({ content: "remote", sealed: true,
        parent: fixture.revisionId(fixture.initial) }));
      fixture.service.publications.fs = new Proxy(fs, { get(target, property) {
        if (property !== "readFile") return target[property];
        return async (file, ...args) => {
          const bytes = await target.readFile(file, ...args);
          if (file === fixture.target && ++targetReads === 1) {
            await target.writeFile(file, remote);
          }
          return bytes;
        };
      } });
    } else {
      let failClear = true;
      fixture.service.publications.journals = new Proxy(fixture.service.journals,
        { get(target, property) {
          if (property !== "clear") {
            const value = target[property];
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (...args) => {
            if (failClear) { failClear = false; throw new Error("discard cleanup crash"); }
            return target.clear(...args);
          };
        } });
    }
    await assert.rejects(fixture.service.discardWorkingCopy(),
      (error) => error.publicationPrepared === true);
    const tracked = await fixture.service.journals.read(
      fixture.service.active.documentId, fixture.service.active.journalKey);
    assert.equal(tracked.publication.purpose, "provisional-discard");

    const restarted = new DocumentService(fixture.options);
    const opened = await restarted.openDocument(fixture.target, "password words");
    if (fault === "race") {
      assert.equal(opened.publicationState, "conflict");
      assert.equal(opened.content, "base");
      assert.equal(restarted.active.pendingPublication, true);
    } else {
      assert.equal(opened.content, "base");
      assert.equal(opened.provisional, undefined);
      assert.equal(restarted.active.pendingPublication, false);
    }
  });
}
