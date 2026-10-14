import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// The Windows host is JavaScript and has no generated TypeScript declarations.
// @ts-expect-error JavaScript host module has no declaration file.
import { DocumentService } from "../src/document-service.mjs";

interface NativeContext {
  create(input: object): Buffer;
  close(): true;
}
interface NativeAddon {
  createContainerContext(): NativeContext;
  inspectDocument(bytes: Buffer, password: string): {
    content: string; baseRevision: string; historyEventType: string };
}

const addonPath = process.env.SCPEFE_NATIVE_ADDON_PATH;
const native = addonPath ? createRequire(import.meta.url)(addonPath) as NativeAddon : null;
const password = "owner passphrase with independent words";
const capabilities = { sameFilesystemTransaction: true,
  replacementGuarantee: "atomic-replace" as const };

async function fixture(t: import("node:test").TestContext,
  fsImpl: typeof fs = fs) {
  assert.ok(native);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-activity-flow-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
    email: "ada@example.test", deviceName: "Desk" }));
  const context = native.createContainerContext();
  const original = context.create({ name: "Ada", email: "ada@example.test",
    deviceName: "Desk", content: "published words", ownerPassword: password,
    timestampMs: 1 });
  context.close();
  await fs.writeFile(target, original);
  const options = { native, fs: fsImpl, profilePath, publicationCapabilities: capabilities,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses") };
  const service = new DocumentService(options);
  await service.openDocument(target, password);
  return { directory, target, original, service, options };
}

test("backup includes the published attempt and leaves a later success outcome", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { directory, target, original, service } = await fixture(t);
  const backup = path.join(directory, "backup.scpefe");
  assert.deepEqual(await service.backupDocument(backup), { backedUp: true });
  const copied = await fs.readFile(backup);
  const source = await fs.readFile(target);
  assert.notDeepEqual(copied, original);
  assert.notDeepEqual(source, copied);
  assert.equal(native?.inspectDocument(copied, password).historyEventType,
    "backup-attempted");
  assert.equal(native?.inspectDocument(source, password).historyEventType,
    "backup-succeeded");
  assert.equal(service.active.opened.activityOutcomePending, undefined);
});

test("attempt publication failure prevents the external backup action", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  let target = "";
  const failingFs = { ...fs, async rename(from: Parameters<typeof fs.rename>[0],
    to: Parameters<typeof fs.rename>[1]) {
    if (to === target) throw Object.assign(new Error("source unavailable"), { code: "EIO" });
    return fs.rename(from, to);
  } };
  const fixtureResult = await fixture(t, failingFs);
  target = fixtureResult.target;
  const backup = path.join(fixtureResult.directory, "blocked.scpefe");
  await assert.rejects(fixtureResult.service.backupDocument(backup), /source unavailable/);
  assert.deepEqual(await fs.readFile(target), fixtureResult.original);
  await assert.rejects(fs.readFile(backup), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
  const pending = await fixtureResult.service.journals.read(
    fixtureResult.service.active.documentId, fixtureResult.service.active.journalKey);
  assert.equal(pending.publication.purpose, "activity-attempt");
  assert.equal(pending.publication.stage, "flushed");
  assert.equal(pending.publication.candidateHash,
    createHash("sha256")
      .update(Buffer.from(pending.publication.candidate, "base64")).digest("hex"));
});

test("restart recovers a replaced attempt candidate without running its host action", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  let target = "";
  let failed = false;
  const interruptedFs = { ...fs, async rename(
    from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) {
    await fs.rename(from, to);
    if (to === target && !failed) {
      failed = true;
      throw Object.assign(new Error("crash after attempt replacement"), { code: "EIO" });
    }
  } };
  const { directory, service, options, target: source } =
    await fixture(t, interruptedFs);
  target = source;
  const backup = path.join(directory, "interrupted.scpefe");
  await assert.rejects(service.backupDocument(backup), /crash after attempt replacement/);
  await assert.rejects(fs.readFile(backup), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
  const pending = await service.journals.read(
    service.active.documentId, service.active.journalKey);
  assert.equal(pending.publication.purpose, "activity-attempt");
  assert.equal(pending.publication.stage, "flushed");
  assert.deepEqual(Buffer.from(pending.publication.candidate, "base64"),
    await fs.readFile(source));
  const restarted = new DocumentService({ ...options, fs });
  const opened = await restarted.openDocument(source, password);
  assert.equal(opened.activityOutcomePending, undefined);
  assert.equal(native?.inspectDocument(await fs.readFile(source), password).historyEventType,
    "backup-failed");
  assert.equal(await restarted.journals.read(restarted.active.documentId,
    restarted.active.journalKey), null);
  await assert.rejects(fs.readFile(backup), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("reconnecting an interrupted attempt publishes a failed outcome without a backup", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  let target = "";
  let failOnce = true;
  const interruptedFs = { ...fs, async rename(
    from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) {
    if (to === target && failOnce) {
      failOnce = false;
      throw Object.assign(new Error("attempt replacement unavailable"), { code: "EIO" });
    }
    return fs.rename(from, to);
  } };
  const { directory, service, target: source } =
    await fixture(t, interruptedFs);
  target = source;
  const backup = path.join(directory, "not-started.scpefe");
  await assert.rejects(service.backupDocument(backup),
    /attempt replacement unavailable/);
  assert.equal(service.active.pendingPublication, true);
  assert.deepEqual(await service.reconnectPendingPublication(), {
    publicationState: "target-published", content: "published words" });
  assert.equal(native?.inspectDocument(await fs.readFile(source), password).historyEventType,
    "backup-failed");
  assert.equal(service.active.opened.activityOutcomePending, undefined);
  assert.equal(await service.journals.read(service.active.documentId,
    service.active.journalKey), null);
  await assert.rejects(fs.readFile(backup), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("v3 backup and export fail closed when native activity support disappears", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { directory, target, original, service } = await fixture(t);
  service.container = Object.create(service.container,
    { prepareActivity: { value: undefined } });
  const backup = path.join(directory, "backup.scpefe");
  const exported = path.join(directory, "private.txt");
  await assert.rejects(service.backupDocument(backup),
    /Native activity interface is unavailable/);
  await assert.rejects(service.exportPlaintext(exported,
    { content: "plain text", lineEndings: "lf" }),
  /Native activity interface is unavailable/);
  assert.deepEqual(await fs.readFile(target), original);
  await assert.rejects(fs.readFile(backup), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
  await assert.rejects(fs.readFile(exported), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("failed backup action publishes a failure outcome without a replica", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  let destination = "";
  const failingFs = { ...fs, async link(from: Parameters<typeof fs.link>[0],
    to: Parameters<typeof fs.link>[1]) {
    if (to === destination) {
      throw Object.assign(new Error("destination unavailable"), { code: "EIO" });
    }
    return fs.link(from, to);
  } };
  const { directory, target, service } = await fixture(t, failingFs);
  destination = path.join(directory, "backup.scpefe");
  assert.deepEqual(await service.backupDocument(destination), { backedUp: false });
  assert.equal(native?.inspectDocument(await fs.readFile(target), password).historyEventType,
    "backup-failed");
  await assert.rejects(fs.readFile(destination), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("successful copy reports and recovers an unpublished activity outcome", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  let target = "";
  let sourceReplacements = 0;
  const failingFs = { ...fs, async rename(from: Parameters<typeof fs.rename>[0],
    to: Parameters<typeof fs.rename>[1]) {
    if (to === target && ++sourceReplacements === 2) {
      throw Object.assign(new Error("outcome unavailable"), { code: "EIO" });
    }
    return fs.rename(from, to);
  } };
  const { directory, service, options, target: source } = await fixture(t, failingFs);
  target = source;
  const backup = path.join(directory, "pending.scpefe");
  assert.deepEqual(await service.backupDocument(backup),
    { backedUp: true, outcomePending: true });
  assert.equal(service.active.opened.activityOutcomePending, true);
  assert.equal(native?.inspectDocument(await fs.readFile(backup), password).historyEventType,
    "backup-attempted");
  const journal = await service.journals.read(service.active.documentId,
    service.active.journalKey);
  assert.equal(journal.activity.succeeded, true);
  const restarted = new DocumentService({ ...options, fs });
  const reopened = await restarted.openDocument(source, password);
  assert.equal(reopened.activityOutcomePending, undefined);
  assert.equal(native?.inspectDocument(await fs.readFile(source), password).historyEventType,
    "backup-succeeded");
  assert.equal(await restarted.journals.read(restarted.active.documentId,
    restarted.active.journalKey), null);
});

test("restart recognizes exact outcome candidate after replacement", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  let target = "";
  let sourceReplacements = 0;
  const interruptedFs = { ...fs, async rename(
    from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) {
    await fs.rename(from, to);
    if (to === target && ++sourceReplacements === 2) {
      throw Object.assign(new Error("crash after outcome replacement"), { code: "EIO" });
    }
  } };
  const { directory, service, options, target: source } =
    await fixture(t, interruptedFs);
  target = source;
  const backup = path.join(directory, "outcome-interrupted.scpefe");
  assert.deepEqual(await service.backupDocument(backup),
    { backedUp: true, outcomePending: true });
  const pending = await service.journals.read(
    service.active.documentId, service.active.journalKey);
  assert.equal(pending.publication.purpose, "activity-outcome");
  assert.equal(pending.publication.stage, "flushed");
  assert.equal(pending.activity.succeeded, true);
  assert.deepEqual(Buffer.from(pending.publication.candidate, "base64"),
    await fs.readFile(source));
  assert.equal(native?.inspectDocument(await fs.readFile(backup), password).historyEventType,
    "backup-attempted");
  const restarted = new DocumentService({ ...options, fs });
  const opened = await restarted.openDocument(source, password);
  assert.equal(opened.activityOutcomePending, undefined);
  assert.equal(native?.inspectDocument(await fs.readFile(source), password).historyEventType,
    "backup-succeeded");
  assert.equal(await restarted.journals.read(restarted.active.documentId,
    restarted.active.journalKey), null);
});

test("restart does not claim failure when the host action result was not journaled", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { directory, target, service, options } = await fixture(t);
  const write = service.journals.write.bind(service.journals);
  let failOnce = true;
  service.journals.write = async (...args: Parameters<typeof write>) => {
    if (failOnce && args[2]?.activity?.actionState === "known") {
      failOnce = false;
      throw Object.assign(new Error("outcome journal unavailable"), { code: "EIO" });
    }
    return write(...args);
  };
  const backup = path.join(directory, "completed-but-unrecorded.scpefe");
  assert.deepEqual(await service.backupDocument(backup),
    { backedUp: true, outcomePending: true });
  assert.equal(native?.inspectDocument(await fs.readFile(backup), password).historyEventType,
    "backup-attempted");
  assert.equal(native?.inspectDocument(await fs.readFile(target), password).historyEventType,
    "backup-attempted");
  const pending = await service.journals.read(
    service.active.documentId, service.active.journalKey);
  assert.equal(pending.activity.actionState, "started");
  const restarted = new DocumentService(options);
  const opened = await restarted.openDocument(target, password);
  assert.equal(opened.activityOutcomePending, true);
  assert.equal(opened.activityConfirmationRequired, true);
  assert.equal(native?.inspectDocument(await fs.readFile(target), password).historyEventType,
    "backup-attempted");
  assert.equal((await restarted.journals.read(restarted.active.documentId,
    restarted.active.journalKey)).activity.actionState, "started");
  await assert.rejects(restarted.resolvePendingActivityOutcome({ succeeded: true,
    replicaTarget: target }), /Select the completed external result/);
  const unrelated = path.join(directory, "unrelated.scpefe");
  await fs.writeFile(unrelated, "not a backup");
  await assert.rejects(restarted.resolvePendingActivityOutcome({ succeeded: true,
    replicaTarget: unrelated }), /External result differs/);
  assert.equal((await restarted.journals.read(restarted.active.documentId,
    restarted.active.journalKey)).activity.actionState, "started");
  const resolved = await restarted.resolvePendingActivityOutcome({ succeeded: true,
    replicaTarget: backup });
  assert.equal(resolved.activityOutcomePending, undefined);
  assert.equal(native?.inspectDocument(await fs.readFile(target), password).historyEventType,
    "backup-succeeded");
  assert.equal(await restarted.journals.read(restarted.active.documentId,
    restarted.active.journalKey), null);
});

test("explicit failure confirmation records the interrupted backup outcome", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { directory, target, service, options } = await fixture(t);
  const write = service.journals.write.bind(service.journals);
  service.journals.write = async (...args: Parameters<typeof write>) => {
    if (args[2]?.activity?.actionState === "known") {
      throw Object.assign(new Error("outcome journal unavailable"), { code: "EIO" });
    }
    return write(...args);
  };
  const inaccessible = path.join(directory, "missing", "backup.scpefe");
  assert.deepEqual(await service.backupDocument(inaccessible),
    { backedUp: false, outcomePending: true });
  const restarted = new DocumentService(options);
  assert.equal((await restarted.openDocument(target, password)).activityConfirmationRequired,
    true);
  const resolved = await restarted.resolvePendingActivityOutcome({ succeeded: false });
  assert.equal(resolved.activityOutcomePending, undefined);
  assert.equal(native?.inspectDocument(await fs.readFile(target), password).historyEventType,
    "backup-failed");
  assert.equal(await restarted.journals.read(restarted.active.documentId,
    restarted.active.journalKey), null);
});

test("in-session outcome retry durably records the known result before publication", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { directory, target, service } = await fixture(t);
  const write = service.journals.write.bind(service.journals);
  let failOnce = true;
  service.journals.write = async (...args: Parameters<typeof write>) => {
    if (failOnce && args[2]?.activity?.actionState === "known") {
      failOnce = false;
      throw Object.assign(new Error("outcome journal unavailable"), { code: "EIO" });
    }
    return write(...args);
  };
  const backup = path.join(directory, "retry-known.scpefe");
  assert.deepEqual(await service.backupDocument(backup),
    { backedUp: true, outcomePending: true });
  assert.equal((await service.journals.read(service.active.documentId,
    service.active.journalKey)).activity.actionState, "started");
  const resolved = await service.resolvePendingActivityOutcome();
  assert.equal(resolved.activityOutcomePending, undefined);
  assert.equal(native?.inspectDocument(await fs.readFile(target), password).historyEventType,
    "backup-succeeded");
  assert.equal(await service.journals.read(service.active.documentId,
    service.active.journalKey), null);
});

async function pendingDirtyExport(t: import("node:test").TestContext) {
  let target = "";
  let sourceReplacements = 0;
  let failOn = Infinity;
  const failingFs = { ...fs, async rename(from: Parameters<typeof fs.rename>[0],
    to: Parameters<typeof fs.rename>[1]) {
    if (to === target && ++sourceReplacements === failOn) {
      throw Object.assign(new Error("outcome unavailable"), { code: "EIO" });
    }
    return fs.rename(from, to);
  } };
  const fixtureResult = await fixture(t, failingFs);
  target = fixtureResult.target;
  const { directory, service, options } = fixtureResult;
  await service.enterEditMode();
  const draft = "unsaved local draft";
  const working = { content: draft, cursor: { start: draft.length, end: draft.length } };
  service.updateWorkingCopy(working);
  failOn = sourceReplacements + 2;
  const exported = path.join(directory, "draft.txt");
  assert.deepEqual(await service.exportPlaintext(exported,
    { content: draft, lineEndings: "lf" }),
  { exported: true, outcomePending: true });
  assert.equal(await fs.readFile(exported, "utf8"), draft);
  assert.equal(native?.inspectDocument(await fs.readFile(target), password).historyEventType,
    "export-attempted");
  return { target, service, options, draft, working,
    documentId: service.active.documentId,
    journalKey: Buffer.from(service.active.journalKey) };
}

for (const checkpoint of ["lock", "timer"] as const) {
  test(`dirty ${checkpoint} checkpoint retains a pending export outcome across restart`, {
    skip: !native && "native addon path was not supplied",
  }, async (t) => {
    const { target, service, options, draft, working, documentId, journalKey } =
      await pendingDirtyExport(t);
    if (checkpoint === "timer") {
      service.checkpointIdleMs = 0;
      service.checkpointContinuousMs = 0;
      service.updateWorkingCopy(working);
      const deadline = Date.now() + 2_000;
      while (service.checkpointTimer !== null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(service.checkpointTimer, null, "checkpoint timer did not run");
      await service.flushChain;
      const timed = await service.journals.read(documentId, journalKey);
      assert.equal(timed.state, "unsaved");
      assert.equal(timed.text, draft);
      assert.equal(timed.activity.succeeded, true);
    }
    assert.equal((await service.lock("test-lock")).journalSaved, true);
    const locked = await service.journals.read(documentId, journalKey);
    assert.equal(locked.state, "unsaved");
    assert.equal(locked.text, draft);
    assert.equal(locked.activity.kind, "export");
    assert.equal(locked.activity.succeeded, true);
    const restarted = new DocumentService({ ...options, fs });
    const reopened = await restarted.openDocument(target, password);
    assert.equal(reopened.activityOutcomePending, undefined);
    assert.equal(reopened.recovery.content, draft);
    assert.equal(native?.inspectDocument(await fs.readFile(target), password).historyEventType,
      "export-succeeded");
    const resolved = await restarted.journals.read(documentId, journalKey);
    assert.equal(resolved.activity, undefined);
    assert.equal(resolved.text, draft);
  });
}

test("restart clears a journal after the source already published its outcome", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  let journalDirectory = "";
  let failOnce = true;
  const failingFs = { ...fs, async unlink(file: Parameters<typeof fs.unlink>[0]) {
    if (failOnce && String(file).startsWith(journalDirectory)
        && String(file).endsWith(".work-journal")) {
      failOnce = false;
      throw Object.assign(new Error("journal cleanup unavailable"), { code: "EIO" });
    }
    return fs.unlink(file);
  } };
  const { directory, service, options, target } = await fixture(t, failingFs);
  journalDirectory = path.join(directory, "journals");
  const backup = path.join(directory, "backup.scpefe");
  assert.deepEqual(await service.backupDocument(backup),
    { backedUp: true, outcomePending: true });
  assert.equal(native?.inspectDocument(await fs.readFile(target), password).historyEventType,
    "backup-succeeded");
  const restarted = new DocumentService({ ...options, fs });
  const opened = await restarted.openDocument(target, password);
  assert.equal(opened.activityOutcomePending, undefined);
  assert.equal(await restarted.journals.read(restarted.active.documentId,
    restarted.active.journalKey), null);
});

test("plaintext export publishes its outcome and records a failed host action", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { directory, service, target } = await fixture(t);
  const exported = path.join(directory, "private.txt");
  const result = await service.exportPlaintext(exported,
    { content: "resolved text", lineEndings: "lf" });
  assert.deepEqual(result, { exported: true });
  assert.equal(await fs.readFile(exported, "utf8"), "resolved text");
  assert.equal(native?.inspectDocument(await fs.readFile(target), password).historyEventType,
    "export-succeeded");
  assert.deepEqual(await service.exportPlaintext(target,
    { content: "must not overwrite", lineEndings: "lf" }),
  { exported: false });
  assert.equal(native?.inspectDocument(await fs.readFile(target), password).historyEventType,
    "export-failed");
  assert.equal(native?.inspectDocument(await fs.readFile(target), password).content,
    "published words");
});

test("export activity preserves an unsaved work journal across restart", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { directory, target, service, options } = await fixture(t);
  const draft = "unsaved local draft";
  await service.journals.write(service.active.documentId, service.active.journalKey, {
    text: draft, baseRevision: service.active.baseRevision,
    cursor: { start: draft.length, end: draft.length }, target,
    state: "unsaved", updateTime: 42 });
  const exported = path.join(directory, "draft.txt");
  assert.deepEqual(await service.exportPlaintext(exported,
    { content: draft, lineEndings: "lf" }), { exported: true });
  assert.equal(await fs.readFile(exported, "utf8"), draft);
  const persisted = await service.journals.read(service.active.documentId,
    service.active.journalKey);
  assert.equal(persisted.text, draft);
  assert.equal(persisted.baseRevision, service.active.baseRevision);
  const restarted = new DocumentService(options);
  const reopened = await restarted.openDocument(target, password);
  assert.equal(reopened.recovery.content, draft);
});
