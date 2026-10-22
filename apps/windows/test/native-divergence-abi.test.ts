import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// @ts-expect-error The JavaScript host has no generated declaration file.
import { DocumentService } from "../src/document-service.mjs";

interface Context {
  create(input: object): Buffer;
  open(bytes: Buffer): Buffer;
  unlock(password: string): true;
  close(): true;
  confirmEditLease(): true;
  assessMerge(local: Buffer, localPassword: string, targetPassword: string,
    input: object): true;
  prepareMerge(local: Buffer, localPassword: string, targetPassword: string,
    input: object): { bytes: Buffer; operationId: number };
  prepareSave(kind: string, password: string, input: object):
    { bytes: Buffer; operationId: number };
  prepareSlotChange(kind: string, password: string, input: object):
    { bytes: Buffer; operationId: number };
  finishSave(operationId: number, outcome: string): number;
  lock(): true;
  historyPage(offset: number, count: number): { items: Array<{
    revisionId: string; foreign: boolean; resolvedBy?: string;
    mergeSources: string[]; bodyAvailable: boolean; textAvailable: boolean;
  }> };
}
interface Native {
  createContainerContext(): Context;
  inspectDocument(bytes: Buffer, password: string): {
    content: string; contentType: "plain-text" | "csv";
    baseRevision: string; canEdit: boolean; slotId: string;
  };
}

function merge(target: Buffer, local: Buffer, localPassword: string,
  details: object & { targetPassword?: string }): Buffer {
  assert.ok(native);
  const targetPassword = details.targetPassword ?? localPassword;
  const context = native.createContainerContext();
  try {
    context.open(target);
    context.unlock(targetPassword);
    context.assessMerge(local, localPassword, targetPassword, details);
    context.confirmEditLease();
    const candidate = context.prepareMerge(local, localPassword,
      targetPassword, { ...details, operationId: 1 });
    context.finishSave(candidate.operationId, "verified");
    return candidate.bytes;
  } finally { context.close(); }
}

const addonPath = process.env.SCPEFE_NATIVE_ADDON_PATH;
const native = addonPath ? createRequire(import.meta.url)(addonPath) as Native : null;
const password = "owner passphrase with independent words";
const rotatedPassword = "rotated owner passphrase with distinct words";
const profile = { name: "Ada", email: "ada@example.test", deviceName: "Ada PC" };
const input = (content: string, timestampMs: number) =>
  ({ ...profile, content, timestampMs });

function branch(base: Buffer, content: string, timestampMs: number,
  credential = password): Buffer {
  assert.ok(native);
  const context = native.createContainerContext();
  try {
    context.open(base);
    context.unlock(credential);
    context.confirmEditLease();
    const candidate = context.prepareSave("manual", credential,
      { ...input(content, timestampMs), operationId: 1 });
    context.finishSave(candidate.operationId, "verified");
    return candidate.bytes;
  } finally { context.close(); }
}

function slotChange(base: Buffer, kind: string, credential: string,
  operationId: number, extra: object): Buffer {
  assert.ok(native);
  const context = native.createContainerContext();
  try {
    context.open(base);
    context.unlock(credential);
    const candidate = context.prepareSlotChange(kind, credential, {
      operationId, clientName: profile.name, clientEmail: profile.email,
      deviceName: profile.deviceName, timestampMs: operationId + 100,
      ...extra,
    });
    context.finishSave(candidate.operationId, "verified");
    return candidate.bytes;
  } finally { context.close(); }
}

test("Windows revised merge imports foreign metadata and respects target wrappers", {
  skip: !native && "native addon path was not supplied",
}, () => {
  assert.ok(native);
  const owner = native.createContainerContext();
  const base = owner.create({ ...input("base\n", 1), ownerPassword: password });
  owner.close();
  const local = branch(base, "local\n", 2);
  const target = branch(base, "target\n", 3);
  const localHead = native.inspectDocument(local, password).baseRevision;
  const targetHead = native.inspectDocument(target, password).baseRevision;
  const merged = merge(target, local, password,
    input("resolved\n", 4));
  const opened = native.inspectDocument(merged, password);
  assert.equal(opened.content, "resolved\n");
  const history = native.createContainerContext();
  try {
    history.open(merged);
    history.unlock(password);
    const items = history.historyPage(0, 10).items;
    const merge = items.find((item) => item.revisionId === opened.baseRevision);
    const foreign = items.find((item) => item.revisionId === targetHead);
    assert.deepEqual(merge?.mergeSources, [targetHead]);
    assert.equal(foreign?.foreign, true);
    assert.equal(foreign?.resolvedBy, merge?.revisionId);
    assert.equal(foreign?.bodyAvailable, false);
    assert.equal(foreign?.textAvailable, false);
    assert.ok(items.some((item) => item.revisionId === localHead));
  } finally { history.close(); }

  const changed = native.createContainerContext();
  let rotated: Buffer;
  try {
    changed.open(target);
    changed.unlock(password);
    const candidate = changed.prepareSlotChange("password", password, {
      operationId: 1, clientName: profile.name, clientEmail: profile.email,
      deviceName: profile.deviceName, timestampMs: 5,
      newPassword: rotatedPassword,
    });
    changed.finishSave(candidate.operationId, "verified");
    rotated = candidate.bytes;
  } finally { changed.close(); }
  assert.throws(() => merge(rotated, local, password,
    input("resolved\n", 6)), (error: any) => error.status === 10);
  const reauthenticated = merge(rotated, local, password,
    { ...input("resolved\n", 6), targetPassword: rotatedPassword });
  assert.equal(native.inspectDocument(reauthenticated, rotatedPassword).content,
    "resolved\n");
  assert.throws(() => native.inspectDocument(reauthenticated, password),
    (error: any) => error.status === 10);
  assert.throws(() => merge(base, local, password,
    input("resolved\n", 7)), (error: any) => error.status === 21);
});

test("Windows publishes a revised merge through its recovery journal", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  assert.ok(native);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-revised-merge-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(profilePath, JSON.stringify(profile));
  const owner = native.createContainerContext();
  const base = owner.create({ ...input("base\n", 1), ownerPassword: password });
  owner.close();
  const local = branch(base, "local\n", 2);
  const current = branch(base, "remote\n", 3);
  await fs.writeFile(target, current);
  const options = { native, fs, profilePath,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" } };
  const service = new DocumentService(options);
  const baseOpened = native.inspectDocument(base, password) as unknown as {
    documentId: string; journalKey: Buffer; baseRevision: string };
  let record = await service.publications.prepare({
    documentId: baseOpened.documentId, journalKey: baseOpened.journalKey,
    target, base, candidate: local, text: "local\n",
    cursor: { start: 6, end: 6 }, baseRevision: baseOpened.baseRevision,
  });
  record = await service.publications.markDiverged(
    baseOpened.documentId, baseOpened.journalKey, record);
  assert.equal(record.state, "conflict");
  await service.openDocument(target, password);
  const draft = await service.beginDivergenceResolution();
  assert.equal(draft.hasConflicts, true);
  assert.equal((await service.journals.read(baseOpened.documentId,
    baseOpened.journalKey))?.state, "conflict");
  service.updateWorkingCopy({ content: "later unsaved\n",
    cursor: { start: 5, end: 5 }, journalScope: "merge", revision: 2 });
  await service.saveDivergenceResolution("resolved\n",
    { journalScope: "merge", revision: 1 });
  const merged = await fs.readFile(target);
  assert.equal(native.inspectDocument(merged, password).content, "resolved\n");
  const history = native.createContainerContext();
  try {
    history.open(merged);
    history.unlock(password);
    assert.ok(history.historyPage(0, 10).items.some((item) => item.foreign));
  } finally { history.close(); }
  assert.equal((await service.journals.read(baseOpened.documentId,
    baseOpened.journalKey))?.state, undefined);
  assert.equal(service.active.dirty, true);
  await service.lock("test-restart");
  const restarted = new DocumentService(options);
  const reopened = await restarted.openDocument(target, password);
  assert.equal(reopened.recovery?.content, "later unsaved\n");
  assert.deepEqual(reopened.recovery?.cursor, { start: 5, end: 5 });
});

test("CSV divergence restores source repair and publishes rectangular content with merge ancestry", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  assert.ok(native);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-csv-merge-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(profilePath, JSON.stringify(profile));
  const owner = native.createContainerContext();
  const base = owner.create({ ...input("name,value\nbase,1", 1),
    contentType: "csv", ownerPassword: password });
  owner.close();
  const local = branch(base, "name,value\nlocal,1", 2);
  const current = branch(base, "name,value\ncurrent,1", 3);
  await fs.writeFile(target, current);
  const options = { native, fs, profilePath,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    checkpointIdleMs: 1,
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" } };
  const service = new DocumentService(options);
  const openedBase = native.inspectDocument(base, password) as unknown as {
    documentId: string; journalKey: Buffer; baseRevision: string };
  const localHead = native.inspectDocument(local, password).baseRevision;
  const currentHead = native.inspectDocument(current, password).baseRevision;
  let record = await service.publications.prepare({
    documentId: openedBase.documentId, journalKey: openedBase.journalKey,
    target, base, candidate: local, text: "name,value\nlocal,1",
    cursor: { start: 0, end: 0 }, baseRevision: openedBase.baseRevision,
  });
  record = await service.publications.markDiverged(
    openedBase.documentId, openedBase.journalKey, record);
  assert.equal((await service.openDocument(target, password)).contentType, "csv");
  const draft = await service.beginDivergenceResolution();
  assert.equal(draft.hasConflicts, true);
  assert.match(draft.content, /^<<<<<<< local/m);
  await assert.rejects(service.saveDivergenceResolution(draft.content),
    /every conflict marker/);
  // A single-column marker block is valid CSV syntax until conflict rules reject it.
  await assert.rejects(service.saveDivergenceResolution(
    "<<<<<<< local\nlocal\n=======\ncurrent\n>>>>>>> current"),
  /every conflict marker/);
  service.updateWorkingCopy({ content: "name,value\npartial",
    cursor: { start: 17, end: 17 } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await service.flushChain;
  const restarted = new DocumentService(options);
  const reopened = await restarted.openDocument(target, password);
  assert.equal(reopened.contentType, "csv");
  assert.equal(reopened.content, "name,value\npartial");
  assert.equal(reopened.publicationState, "conflict");
  assert.equal(draft.ancestorRevision, openedBase.baseRevision);
  assert.equal(draft.localRevision, localHead);
  assert.equal(draft.currentRevision, currentHead);
  await assert.rejects(service.saveDivergenceResolution("name,value\npartial"),
    /Invalid CSV/);
  await service.saveDivergenceResolution("name,value\nresolved,2");
  const merged = await fs.readFile(target);
  const saved = native.inspectDocument(merged, password);
  assert.equal(saved.contentType, "csv");
  assert.equal(saved.content, "name,value\nresolved,2");
  const history = native.createContainerContext();
  try {
    history.open(merged);
    history.unlock(password);
    const rows = history.historyPage(0, 20).items;
    const merge = rows.find((item) => item.revisionId === saved.baseRevision);
    assert.deepEqual(merge?.mergeSources, [currentHead]);
    assert.ok(rows.some((item) => item.revisionId === localHead));
    assert.ok(rows.some((item) => item.revisionId === currentHead
      && item.foreign && item.resolvedBy === saved.baseRevision));
  } finally { history.close(); }
  assert.equal(await service.journals.read(openedBase.documentId,
    openedBase.journalKey), null);
});

test("Windows merge distinguishes demotion from removal of an editor slot", {
  skip: !native && "native addon path was not supplied",
}, () => {
  assert.ok(native);
  const temporary = "temporary editor password with private words";
  const editor = "claimed editor password with private words";
  const owner = native.createContainerContext();
  const base = owner.create({ ...input("base\n", 1), ownerPassword: password });
  owner.close();
  const invited = slotChange(base, "invitation", password, 1,
    { newPassword: temporary, name: "Editor", canEdit: true });
  const claimed = slotChange(invited, "claim", temporary, 2,
    { newPassword: editor, name: "Grace", email: "grace@example.test" });
  const editorSlotId = native.inspectDocument(claimed, editor).slotId;
  const local = branch(claimed, "local\n", 4, editor);
  const target = branch(claimed, "remote\n", 5);
  const demoted = slotChange(target, "permissions", password, 3,
    { slotId: editorSlotId, canEdit: false });
  assert.throws(() => merge(demoted, local, editor,
    input("resolved\n", 6)), (error: any) => error.status === 24);
  const removed = slotChange(target, "remove", password, 4,
    { slotId: editorSlotId });
  assert.throws(() => merge(removed, local, editor,
    { ...input("resolved\n", 7), targetPassword: password }),
  (error: any) => error.status === 23);
});

test("Windows reauthenticates a rotated target without losing the local journal", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  assert.ok(native);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-rotated-merge-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(profilePath, JSON.stringify(profile));
  const owner = native.createContainerContext();
  const base = owner.create({ ...input("base\n", 1), ownerPassword: password });
  owner.close();
  const local = branch(base, "local\n", 2);
  const remote = branch(base, "remote\n", 3);
  const rotated = slotChange(remote, "password", password, 4,
    { newPassword: rotatedPassword });
  await fs.writeFile(target, rotated);
  const service = new DocumentService({ native, fs, profilePath,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" } });
  const opened = native.inspectDocument(base, password) as unknown as {
    documentId: string; journalKey: Buffer; baseRevision: string };
  let record = await service.publications.prepare({
    documentId: opened.documentId, journalKey: opened.journalKey,
    target, base, candidate: local, text: "local\n",
    cursor: { start: 6, end: 6 }, baseRevision: opened.baseRevision,
  });
  record = await service.publications.markDiverged(
    opened.documentId, opened.journalKey, record);
  assert.equal(record.state, "conflict");
  await service.openDocument(target, password);
  await assert.rejects(service.beginDivergenceResolution(),
    (error: any) => error.code === "MERGE_TARGET_REAUTHENTICATION");
  assert.equal((await service.journals.read(opened.documentId,
    opened.journalKey))?.text, "local\n");
  const draft = await service.beginDivergenceResolution({
    targetPassword: rotatedPassword });
  assert.equal(draft.hasConflicts, true);
  await service.saveDivergenceResolution("resolved\n");
  assert.equal(native.inspectDocument(await fs.readFile(target), rotatedPassword).content,
    "resolved\n");
  assert.equal(await service.journals.read(opened.documentId, opened.journalKey), null);
});
