import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// @ts-expect-error The JavaScript host has no generated declaration file.
import { COMPACTION_CONFIRMATION, DocumentService } from "../src/document-service.mjs";

const addonPath = process.env.SCPEFE_NATIVE_ADDON_PATH;
const native = addonPath ? createRequire(import.meta.url)(addonPath) : null;
const password = "owner passphrase with independent words";

async function setup(t: import("node:test").TestContext, revisions = 1,
  fsImpl: typeof fs = fs) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-compaction-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
    email: "ada@example.test", deviceName: "Ada PC" }));
  const bridge = Object.fromEntries(Object.getOwnPropertyNames(native)
    .map((name) => [name, native[name]]));
  bridge.compactDocument = () => {
    throw new Error("legacy compaction writer must not run");
  };
  const options = { native: bridge, fs: fsImpl, profilePath,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" } };
  const service = new DocumentService(options);
  const seed = native.createContainerContext();
  const initial = seed.create({ name: "Ada", email: "ada@example.test",
    deviceName: "Ada PC", content: "first version", ownerPassword: password,
    timestampMs: 1 });
  seed.close();
  await fs.writeFile(target, initial);
  await service.openDocument(target, password);
  await service.enterEditMode();
  for (let index = 1; index <= revisions; index += 1) {
    const content = `version ${index}`;
    service.updateWorkingCopy({ content,
      cursor: { start: content.length, end: content.length } });
    await service.saveDocument(content);
  }
  return { service, target, directory, options };
}

test("stateful compaction publishes only after exact durable backup and keeps old metadata", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { service, target } = await setup(t, 12);
  const before = await fs.readFile(target);
  const old = service.container.historyPage(0, 50).items;
  assert.ok(old.length >= 2);
  const result = await service.compactDocument(COMPACTION_CONFIRMATION);
  assert.equal(result.compacted, true);
  assert.equal(result.backupCreated, true);
  const after = service.container.historyPage(0, 50).items;
  assert.equal(result.previousHead, after[1].revisionId);
  assert.notEqual(result.head, result.previousHead);
  assert.equal(service.container.bytes().equals(await fs.readFile(target)), true);
  const backups = (await fs.readdir(path.dirname(target))).filter((name) =>
    /^document\.backup-.*\.scpefe$/u.test(name));
  assert.equal(backups.length, 1);
  const backup = path.join(path.dirname(target), backups[0]);
  const backupBytes = await fs.readFile(backup);
  assert.notDeepEqual(backupBytes, before);
  assert.equal(native?.inspectDocument(backupBytes, password).historyEventType,
    "backup-attempted");
  assert.equal(after.length, old.length + 3);
  assert.equal(after[0].eventType, "compaction");
  assert.equal(after[0].previousHead, after[1].revisionId);
  assert.equal(after[1].eventType, "backup-succeeded");
  assert.equal(after[2].eventType, "backup-attempted");
  assert.equal(after[2].previousHead, old[0].revisionId);
  for (const record of old) {
    assert.ok(after.some((item: { revisionId: string }) =>
      item.revisionId === record.revisionId));
  }
  assert.equal(after.at(-1)?.textAvailable, false);
  assert.deepEqual(service.container.historyCompare(
    after.at(-1)!.revisionId, after[0].revisionId), { available: false });
  assert.equal(service.active.opened.content, "version 12");
  assert.equal(service.pendingNativeCandidate, null);
  assert.equal(service.container.bytes().equals(await fs.readFile(target)), true);
});

test("failed backup and unsaved journal leave history intact", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { service, target } = await setup(t);
  const before = await fs.readFile(target);
  const original = service.publications.publishReplica.bind(service.publications);
  service.publications.publishReplica = async () => {
    throw new Error("injected backup failure");
  };
  await assert.rejects(service.compactDocument(COMPACTION_CONFIRMATION),
    (error: any) => error.code === "COMPACTION_BACKUP_FAILED");
  const failedSource = await fs.readFile(target);
  assert.notDeepEqual(failedSource, before);
  assert.equal(native?.inspectDocument(failedSource, password).historyEventType,
    "backup-failed");
  assert.equal(native?.inspectDocument(failedSource, password).content,
    native?.inspectDocument(before, password).content);
  assert.equal(service.pendingNativeCandidate, null);
  service.publications.publishReplica = original;
  await service.journals.write(service.active.documentId, service.active.journalKey,
    { text: "journal-only work", baseRevision: service.active.baseRevision,
      cursor: { start: 0, end: 0 }, target, state: "unsaved",
      updateTime: Date.now() });
  await assert.rejects(service.compactDocument(COMPACTION_CONFIRMATION), /clean/);
  assert.equal((await fs.readdir(path.dirname(target))).some((name) =>
    name.includes(".backup-")), false);
  await service.journals.clear(service.active.documentId);
  service.updateWorkingCopy({ content: "unsaved words",
    cursor: { start: 13, end: 13 } });
  await assert.rejects(service.compactDocument(COMPACTION_CONFIRMATION), /clean/);
  assert.deepEqual(await fs.readFile(target), failedSource);
});

test("edits arriving during backup or publication are rejected without losing work", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { service, target } = await setup(t);
  const before = await fs.readFile(target);
  const originalBackup = service.publications.publishReplica.bind(
    service.publications);
  const originalPublish = service.publications.publish.bind(
    service.publications);
  let rejected = 0;
  const lateEdit = () => {
    assert.throws(() => service.updateWorkingCopy({
      content: "late unsaved words", cursor: { start: 18, end: 18 },
    }), /Compaction is in progress/);
    rejected += 1;
  };
  service.publications.publishReplica = async (request: object) => {
    const backup = await originalBackup(request);
    lateEdit();
    return backup;
  };
  service.publications.publish = async (request: object) => {
    lateEdit();
    return originalPublish(request);
  };

  const result = await service.compactDocument(COMPACTION_CONFIRMATION);
  assert.equal(rejected, 4);
  assert.equal(result.compacted, true);
  assert.equal(service.active.working.content, "version 1");
  assert.equal(service.active.dirty, false);
  assert.equal(await service.journals.read(
    service.active.documentId, service.active.journalKey), null);
  assert.notDeepEqual(await fs.readFile(target), before);
  assert.deepEqual(service.container.bytes(), await fs.readFile(target));
  assert.equal(service.active.opened.content, "version 1");
  assert.equal(service.pendingNativeCandidate, null);
  service.updateWorkingCopy({ content: "new work after compaction",
    cursor: { start: 25, end: 25 } });
  assert.equal(service.active.dirty, true);
});

test("compaction rejects missing confirmation or lease before creating a backup", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { service, directory } = await setup(t);
  await assert.rejects(service.compactDocument("not confirmed"),
    /Confirm irreversible local history removal/);
  await service.exitEditMode();
  await assert.rejects(service.compactDocument(COMPACTION_CONFIRMATION),
    /Enter edit mode with a full administrative slot/);
  assert.deepEqual((await fs.readdir(directory)).filter((name) =>
    name.includes(".backup-")), []);
});

test("definite compaction preparation failure releases the native candidate", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { service, target, directory } = await setup(t);
  const originalPrepare = service.publications.prepare.bind(service.publications);
  service.publications.prepare = async (request: { purpose: string }) => {
    if (request.purpose === "compaction") {
      throw new Error("compaction journal could not be prepared");
    }
    return originalPrepare(request);
  };
  await assert.rejects(service.compactDocument(COMPACTION_CONFIRMATION),
    /compaction journal could not be prepared/);
  assert.equal(service.pendingNativeCandidate, null);
  assert.equal(service.active.pendingPublication, false);
  assert.equal(await service.journals.read(service.active.documentId,
    service.active.journalKey), null);
  assert.equal(native?.inspectDocument(await fs.readFile(target), password)
    .historyEventType, "backup-succeeded");
  assert.equal((await fs.readdir(directory)).filter((name) =>
    name.includes(".backup-")).length, 1);
});

test("interrupted compaction retains its exact candidate and backup for restart", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  let sourceTarget = "";
  let interrupt = false;
  const interruptedFs = { ...fs, async rename(
    from: Parameters<typeof fs.rename>[0],
    to: Parameters<typeof fs.rename>[1]) {
    if (interrupt && to === sourceTarget) {
      const candidate = await fs.readFile(from);
      if (native?.inspectDocument(candidate, password).historyEventType
          === "compaction") {
        interrupt = false;
        await fs.rename(from, to);
        throw Object.assign(new Error("interrupted after compaction replacement"),
          { code: "EIO" });
      }
    }
    return fs.rename(from, to);
  } };
  const { service, target, directory, options } = await setup(t, 3,
    interruptedFs);
  sourceTarget = target;
  const oldHistory = service.container.historyPage(0, 50).items;
  interrupt = true;
  await assert.rejects(service.compactDocument(COMPACTION_CONFIRMATION),
    /interrupted after compaction replacement/);
  const pending = await service.journals.read(service.active.documentId,
    service.active.journalKey);
  assert.equal(pending.publication.purpose, "compaction");
  assert.equal(pending.publication.stage, "flushed");
  assert.equal(service.active.pendingPublication, true);
  assert.equal(service.pendingNativeCandidate !== null, true);
  const candidate = Buffer.from(pending.publication.candidate, "base64");
  assert.deepEqual(await fs.readFile(target), candidate);
  assert.notDeepEqual(service.container.bytes(), candidate);
  const backups = (await fs.readdir(directory)).filter((name) =>
    /^document\.backup-.*\.scpefe$/u.test(name));
  assert.equal(backups.length, 1);
  const backup = await fs.readFile(path.join(directory, backups[0]));
  assert.equal(native?.inspectDocument(backup, password).historyEventType,
    "backup-attempted");
  assert.equal(native?.inspectDocument(backup, password).content, "version 3");
  await assert.rejects(service.compactDocument(COMPACTION_CONFIRMATION),
    /clean, manually sealed, conflict-free/);

  const restarted = new DocumentService({ ...options, fs });
  const opened = await restarted.openDocument(target, password);
  assert.equal(opened.content, "version 3");
  assert.equal(opened.publicationState, "target-published");
  assert.deepEqual(restarted.container.bytes(), candidate);
  assert.equal(await restarted.journals.read(restarted.active.documentId,
    restarted.active.journalKey), null);
  const history = restarted.container.historyPage(0, 50).items;
  assert.equal(history[0].eventType, "compaction");
  for (const item of oldHistory) {
    assert.ok(history.some((record: { revisionId: string }) =>
      record.revisionId === item.revisionId));
  }
  assert.deepEqual((await fs.readdir(directory)).filter((name) =>
    /^document\.backup-.*\.scpefe$/u.test(name)), backups);
});
