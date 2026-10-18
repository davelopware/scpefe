import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The host remains JavaScript while its renderer-facing tests are TypeScript.
// @ts-expect-error The JavaScript host has no generated declaration file.
import { DocumentService } from "../src/document-service.mjs";

const addonPath = process.env.SCPEFE_NATIVE_ADDON_PATH;
const native = addonPath ? createRequire(import.meta.url)(addonPath) : null;

function createRevised(profile: object, content: string, password: string,
  timestampMs: number): Buffer {
  const context = native.createContainerContext();
  const bytes = context.create({ ...profile, content, ownerPassword: password,
    timestampMs });
  context.close();
  return bytes;
}

function saveRevised(bytes: Buffer, profile: object, content: string,
  password: string, timestampMs: number): Buffer {
  const context = native.createContainerContext();
  context.open(bytes);
  context.unlock(password);
  context.confirmEditLease();
  const prepared = context.prepareSave("manual", password,
    { ...profile, content, timestampMs, operationId: 1 });
  context.finishSave(prepared.operationId, "verified");
  context.close();
  return prepared.bytes;
}

test("document service keeps the native handle on Lock and reauthenticates on Unlock", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-native-lifecycle-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profilePath = path.join(directory, "profile.json");
  const target = path.join(directory, "document.scpefe");
  await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
    email: "ada@example.test", deviceName: "Ada PC" }));
  const service = new DocumentService({ native, fs, profilePath,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" } });
  const password = "owner passphrase with independent words";
  await service.createDocument(target, { ownerPassword: password,
    content: "private words", understandsIrrecoverable: true });
  const opened = await service.openDocument(target, password);
  assert.equal(opened.content, "private words");
  const handle = service.container;
  assert.equal(handle.read().content, "private words");
  const locked = await service.lock("app-lock");
  assert.equal(locked.journalSaved, true);
  assert.equal(service.active, null);
  assert.equal(service.container, handle);
  assert.throws(() => handle.read(), /status 15/);
  await assert.rejects(service.openDocument(target, "incorrect password"));
  assert.throws(() => handle.read(), /status 15/);
  const unlocked = await service.openDocument(target, password);
  assert.equal(unlocked.content, "private words");
  assert.equal(service.container, handle);
  assert.equal(handle.read().content, "private words");
  await service.lock("document-close");
  service.closeContainer();
  assert.throws(() => handle.read(), /status 14/);
});

for (const recovery of ["published", "unavailable", "changed-target", "replaced-target"] as const) {
  test(`recovery ${recovery} authenticates a native handle before showing content`, {
    skip: !native && "native addon path was not supplied",
  }, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-native-recovery-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const profilePath = path.join(directory, "profile.json");
    const target = path.join(directory, "document.scpefe");
    const password = "owner passphrase with independent words";
    const profile = { name: "Ada", email: "ada@example.test", deviceName: "Ada PC" };
    await fs.writeFile(profilePath, JSON.stringify(profile));
    const base = createRevised(profile, "base words", password, 1);
    await fs.writeFile(target, base);
    const authenticatedBase = native.inspectDocument(base, password);
    const candidate = saveRevised(base, profile, "pending words", password, 2);
    let unavailable = recovery === "unavailable";
    const guardedFs = Object.create(fs);
    guardedFs.readFile = async (file: string, ...args: unknown[]) => {
      if (unavailable && file === target) {
        const error = new Error("provider disconnected") as NodeJS.ErrnoException;
        error.code = "ENODEV";
        throw error;
      }
      return fs.readFile(file, ...args as []);
    };
    const service = new DocumentService({ native, fs: guardedFs, profilePath,
      journalDirectory: path.join(directory, "journals"),
      witnessDirectory: path.join(directory, "witnesses"),
      publicationCapabilities: { sameFilesystemTransaction: true,
        replacementGuarantee: "atomic-replace" } });
    await service.publications.prepare({ documentId: authenticatedBase.documentId,
      journalKey: authenticatedBase.journalKey, target, base, candidate,
      text: "pending words", cursor: { start: 0, end: 0 },
      baseRevision: authenticatedBase.baseRevision });
    authenticatedBase.journalKey.fill(0);

    if (recovery === "changed-target") {
      const remote = saveRevised(base, profile, "remote words", password, 3);
      await fs.writeFile(target, remote);
    } else if (recovery === "replaced-target") {
      const replacement = createRevised(profile, "other document", password, 4);
      await fs.writeFile(target, replacement);
    }

    const opened = await service.openDocument(target, password);
    assert.equal(opened.content, "pending words");
    assert.equal(opened.publicationState, recovery === "published"
      ? "target-published" : recovery === "unavailable"
        ? "pending-publication" : "conflict");
    const handle = service.container;
    assert.equal(handle.status().locked, false);
    assert.equal(handle.read().content, recovery === "published" ? "pending words"
      : recovery === "changed-target" ? "remote words" : "base words");
    if (recovery === "replaced-target") {
      assert.equal(native.inspectDocument(await fs.readFile(target), password)
        .content, "other document");
    }
    await service.lock("app-lock");
    assert.equal(service.active, null);
    assert.equal(handle.status().locked, true);
    assert.throws(() => handle.read(), /status 15/);
    await assert.rejects(service.openDocument(target, "incorrect password"));
    assert.equal(service.active, null);
    assert.equal(handle.status().locked, true);
    const unlocked = await service.openDocument(target, password);
    assert.equal(unlocked.content, "pending words");
    assert.equal(service.container, handle);
    assert.equal(handle.status().locked, false);
    await service.lock("document-close");
    service.closeContainer();
    assert.throws(() => handle.read(), /status 14/);
    unavailable = false;
  });
}

test("manual save publishes and adopts the native candidate without legacy save", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  assert.ok(native);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-native-save-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profilePath = path.join(directory, "profile.json");
  const target = path.join(directory, "document.scpefe");
  const password = "owner passphrase with independent words";
  await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
    email: "ada@example.test", deviceName: "Ada PC" }));
  const bridge = Object.fromEntries(Object.getOwnPropertyNames(native)
    .map((name) => [name, native[name]]));
  bridge.saveDocument = () => { throw new Error("legacy save must not run"); };
  bridge.regularSaveDocument = () => { throw new Error("legacy regular save must not run"); };
  bridge.discardProvisional = () => { throw new Error("legacy discard must not run"); };
  const service = new DocumentService({ native: bridge, fs, profilePath,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" } });
  await service.createDocument(target, { ownerPassword: password,
    content: "base", understandsIrrecoverable: true });
  await service.openDocument(target, password);
  await service.enterEditMode();
  const submittedVersion = { journalScope: "native-save", revision: 1 };
  service.updateWorkingCopy({ content: "submitted", cursor: { start: 9, end: 9 },
    ...submittedVersion });
  const result = await service.saveDocument("submitted", submittedVersion);
  assert.deepEqual(result, { saved: true, content: "submitted",
    publicationState: "target-published", ...submittedVersion });
  assert.equal(native.inspectDocument(await fs.readFile(target), password).content,
    "submitted");
  assert.equal(service.container.read().content, "submitted");
  service.updateWorkingCopy({ content: "submitted", cursor: { start: 9, end: 9 },
    journalScope: "native-save", revision: 2 });
  assert.equal(service.active.dirty, true,
    "a later edit revision remains dirty even with identical text");
  await service.saveClientSettings({ regularSaveEnabled: true });
  const regular = await service.regularSaveDocument();
  assert.deepEqual(regular, { published: true, provisional: true,
    content: "submitted" });
  assert.deepEqual(service.container.bytes(), await fs.readFile(target));
  assert.equal(service.active.dirty, true);
  await service.discardUnsavedForClose();
  assert.equal(native.inspectDocument(await fs.readFile(target), password).content,
    "submitted");
  assert.equal(service.active.manuallySealed, true);
  await service.lock("document-close");
});

test("offline native candidate resumes exact journal bytes before another save", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  assert.ok(native);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-native-offline-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profilePath = path.join(directory, "profile.json");
  const target = path.join(directory, "document.scpefe");
  const password = "owner passphrase with independent words";
  await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
    email: "ada@example.test", deviceName: "Ada PC" }));
  let offline = false;
  const guardedFs = Object.create(fs);
  guardedFs.readFile = async (file: string, ...args: unknown[]) => {
    if (offline && file === target) {
      const error = new Error("provider disconnected") as NodeJS.ErrnoException;
      error.code = "ENODEV";
      throw error;
    }
    return fs.readFile(file, ...args as []);
  };
  const service = new DocumentService({ native, fs: guardedFs, profilePath,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" } });
  await service.createDocument(target, { ownerPassword: password,
    content: "base", understandsIrrecoverable: true });
  await service.openDocument(target, password);
  await service.enterEditMode();
  offline = true;
  const result = await service.saveDocument("offline draft");
  assert.equal(result.publicationState, "pending-publication");
  const record = service.active.pendingRecord;
  const candidate = Buffer.from(record.publication.candidate, "base64");
  assert.notDeepEqual(service.container.bytes(), candidate);
  await assert.rejects(service.saveDocument("replacement"), /interrupted publication/);
  offline = false;
  const resumed = await service.reconnectPendingPublication();
  assert.equal(resumed.publicationState, "target-published");
  assert.deepEqual(await fs.readFile(target), candidate);
  assert.deepEqual(service.container.bytes(), candidate);
  offline = true;
  const second = await service.saveDocument("another offline draft");
  assert.equal(second.publicationState, "pending-publication");
  const remote = saveRevised(candidate, { name: "Ada",
    email: "ada@example.test", deviceName: "Ada PC" }, "remote work",
    password, Date.now());
  await fs.writeFile(target, remote);
  offline = false;
  const conflict = await service.reconnectPendingPublication();
  assert.equal(conflict.publicationState, "conflict");
  assert.equal(service.pendingNativeCandidate, null,
    "a changed target resolves the ambiguous native operation");
  assert.deepEqual(await fs.readFile(target), remote);
  await service.lock("document-close");
});

test("manual save releases a native candidate when journal preparation definitely fails", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-native-definite-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profilePath = path.join(directory, "profile.json");
  const target = path.join(directory, "document.scpefe");
  const password = "owner passphrase with independent words";
  await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
    email: "ada@example.test", deviceName: "Ada PC" }));
  let failJournal = false;
  const guardedFs = Object.create(fs);
  guardedFs.open = async (file: string, ...args: unknown[]) => {
    if (failJournal && file.includes(".work-journal.tmp-")) {
      const error = new Error("journal preparation failed") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    }
    return fs.open(file, ...args as []);
  };
  const service = new DocumentService({ native, fs: guardedFs, profilePath,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" } });
  await service.createDocument(target, { ownerPassword: password,
    content: "base", understandsIrrecoverable: true });
  await service.openDocument(target, password);
  await service.enterEditMode();
  const base = await fs.readFile(target);
  failJournal = true;
  await assert.rejects(service.saveDocument("first attempt"),
    (error: Error & { publicationPrepared?: boolean }) =>
      error.message === "journal preparation failed"
      && error.publicationPrepared !== true);
  assert.equal(service.pendingNativeCandidate, null);
  assert.equal(service.active.pendingPublication, false);
  assert.deepEqual(await fs.readFile(target), base);
  failJournal = false;
  const retried = await service.saveDocument("retried candidate");
  assert.equal(retried.publicationState, "target-published");
  assert.equal(native.inspectDocument(await fs.readFile(target), password).content,
    "retried candidate");
  assert.deepEqual(service.container.bytes(), await fs.readFile(target));
  await service.lock("document-close");
});

test("lost journal acknowledgement retains the exact native candidate", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-native-journal-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profilePath = path.join(directory, "profile.json");
  const target = path.join(directory, "document.scpefe");
  const password = "owner passphrase with independent words";
  await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
    email: "ada@example.test", deviceName: "Ada PC" }));
  let loseAcknowledgement = false;
  const guardedFs = Object.create(fs);
  guardedFs.rename = async (from: string, to: string) => {
    await fs.rename(from, to);
    if (loseAcknowledgement && to.endsWith(".work-journal")) {
      loseAcknowledgement = false;
      const error = new Error("journal acknowledgement lost") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    }
  };
  const service = new DocumentService({ native, fs: guardedFs, profilePath,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" } });
  await service.createDocument(target, { ownerPassword: password,
    content: "base", understandsIrrecoverable: true });
  await service.openDocument(target, password);
  await service.enterEditMode();
  const base = await fs.readFile(target);
  loseAcknowledgement = true;
  await assert.rejects(service.saveDocument("journaled candidate"),
    (error: Error & { publicationPrepared?: boolean }) =>
      error.message === "journal acknowledgement lost"
      && error.publicationPrepared === true);
  const candidate = Buffer.from(service.active.pendingRecord.publication.candidate,
    "base64");
  assert.deepEqual(await fs.readFile(target), base);
  assert.deepEqual(service.container.bytes(), base);
  assert.notEqual(service.pendingNativeCandidate, null);
  const resumed = await service.reconnectPendingPublication();
  assert.equal(resumed.publicationState, "target-published");
  assert.deepEqual(await fs.readFile(target), candidate);
  assert.deepEqual(service.container.bytes(), candidate);
  assert.equal(service.pendingNativeCandidate, null);
  await service.lock("document-close");
});

for (const targetAlreadyPublished of [false, true]) {
  test(`ambiguous manual save resumes exact candidate after restart (${targetAlreadyPublished ? "already published" : "base unchanged"})`, {
    skip: !native && "native addon path was not supplied",
  }, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-native-ambiguous-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const profilePath = path.join(directory, "profile.json");
    const target = path.join(directory, "document.scpefe");
    const password = "owner passphrase with independent words";
    await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
      email: "ada@example.test", deviceName: "Ada PC" }));
    let failReplacement = false;
    const guardedFs = Object.create(fs);
    guardedFs.rename = async (from: string, to: string) => {
      if (failReplacement && to === target && from.includes(".scpefe-txn-")) {
        const error = new Error("replacement result unknown") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return fs.rename(from, to);
    };
    const options = { native, fs: guardedFs, profilePath,
      journalDirectory: path.join(directory, "journals"),
      witnessDirectory: path.join(directory, "witnesses"),
      publicationCapabilities: { sameFilesystemTransaction: true,
        replacementGuarantee: "atomic-replace" } };
    const service = new DocumentService(options);
    await service.createDocument(target, { ownerPassword: password,
      content: "base", understandsIrrecoverable: true });
    await service.openDocument(target, password);
    await service.enterEditMode();
    const base = await fs.readFile(target);
    failReplacement = true;
    await assert.rejects(service.saveDocument("journaled candidate"),
      (error: Error & { publicationPrepared?: boolean }) =>
        error.message === "replacement result unknown"
        && error.publicationPrepared === true);
    assert.equal(service.active.pendingPublication, true);
    const candidate = Buffer.from(service.active.pendingRecord.publication.candidate,
      "base64");
    assert.deepEqual(service.container.bytes(), base,
      "native state remains at the base until publication is verified");
    assert.notEqual(service.pendingNativeCandidate, null);
    assert.equal(native.inspectDocument(candidate, password).content,
      "journaled candidate");
    if (targetAlreadyPublished) await fs.writeFile(target, candidate);
    service.closeContainer();
    failReplacement = false;
    const restarted = new DocumentService(options);
    const opened = await restarted.openDocument(target, password);
    assert.equal(opened.publicationState, "target-published");
    assert.equal(opened.content, "journaled candidate");
    assert.deepEqual(await fs.readFile(target), candidate);
    assert.deepEqual(restarted.container.bytes(), candidate);
    assert.equal((await restarted.unresolvedJournalSummary()).pendingPublications, 0);
    await restarted.lock("document-close");
  });
}
