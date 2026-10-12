import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// @ts-expect-error The JavaScript host has no generated declaration file.
import { DocumentService } from "../src/document-service.mjs";

const addonPath = process.env.SCPEFE_NATIVE_ADDON_PATH;
const native = addonPath ? createRequire(import.meta.url)(addonPath) : null;
const password = "owner passphrase with independent words";

async function setup(t: import("node:test").TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-native-lease-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
    email: "ada@example.test", deviceName: "Ada PC" }));
  const bridge = Object.fromEntries(Object.getOwnPropertyNames(native)
    .map((name) => [name, native[name]]));
  bridge.updateLease = () => { throw new Error("legacy lease writer must not run"); };
  let utc = 1_000;
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const service = new DocumentService({ native: bridge, fs, profilePath,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" },
    utcNow: () => utc,
    setTimer(callback: () => void, delay: number) {
      const timer = { callback, delay }; timers.push(timer); return timer;
    }, clearTimer() {} });
  await service.createDocument(target, { ownerPassword: password,
    content: "base", understandsIrrecoverable: true });
  await service.openDocument(target, password);
  return { service, target, directory, profilePath, bridge, timers,
    advance: (milliseconds: number) => { utc += milliseconds; } };
}

function restartWithSameStore(directory: string, profilePath: string,
  bridge: Record<string, unknown>) {
  return new DocumentService({ native: bridge, fs, profilePath,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" } });
}

test("native lease candidates drive Edit mode, heartbeat, Lock/Unlock and release", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { service, target, timers, advance } = await setup(t);
  await service.enterEditMode();
  assert.deepEqual(service.container.leaseMode(),
    { editing: true, leaseStatus: "held" });
  const acquired = service.container.authenticatedLease();
  assert.equal(acquired.heartbeatCounter, 1);
  assert.deepEqual(service.container.bytes(), await fs.readFile(target));

  advance(120_000);
  timers.filter((timer) => timer.delay === 120_000).at(-1)!.callback();
  await service.runLifecycleBarrier(() => {});
  assert.equal(service.container.authenticatedLease().heartbeatCounter, 2);
  assert.deepEqual(service.container.bytes(), await fs.readFile(target));

  await service.lock("screen-lock");
  assert.throws(() => service.container.authenticatedLease(), /status 15/);
  await service.openDocument(target, password);
  await service.enterEditMode();
  assert.equal(service.container.authenticatedLease().sessionId, acquired.sessionId);
  assert.equal(service.container.authenticatedLease().heartbeatCounter, 3);
  assert.deepEqual(service.container.bytes(), await fs.readFile(target));
  assert.deepEqual(await service.exitEditMode(), { released: true });
  assert.deepEqual(service.container.leaseMode(),
    { editing: false, leaseStatus: "none" });
  assert.equal(service.container.authenticatedLease().active, false);
  assert.deepEqual(service.container.bytes(), await fs.readFile(target));
  await service.lock("document-close");
});

test("failed lease release locks and retains the submitted working copy in the journal", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { service, target } = await setup(t);
  await service.enterEditMode();
  service.updateWorkingCopy({ content: "pending private words",
    cursor: { start: 21, end: 21 } });
  const originalRead = service.fs.readFile.bind(service.fs);
  service.fs = { ...service.fs, async readFile(file: string, ...args: unknown[]) {
    if (file === target) throw new Error("injected provider failure");
    return originalRead(file, ...args as []);
  } };
  await assert.rejects(service.exitEditMode(), /provider failure/);
  assert.equal(service.active, null);
  assert.equal(service.hasSuspendedLease(), true);
  const journals = await service.unresolvedJournalSummary();
  assert.ok(journals.total > 0);
});

test("successful release preserves unsaved work while clearing only the lease transaction", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { service, target } = await setup(t);
  await service.enterEditMode();
  service.updateWorkingCopy({ content: "unsubmitted words",
    cursor: { start: 17, end: 17 } });
  await service.exitEditMode();
  assert.equal((await service.unresolvedJournalSummary()).total, 1);
  assert.equal(service.container.authenticatedLease().active, false);
  assert.deepEqual(service.container.bytes(), await fs.readFile(target));
  await service.lock("document-close");
});

test("restoring work keeps its journal through acquisition and immediate restart", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { service, target, directory, profilePath, bridge } = await setup(t);
  await service.enterEditMode();
  service.updateWorkingCopy({ content: "unsaved recovery words",
    cursor: { start: 22, end: 22 } });
  await service.exitEditMode();
  await service.lock("restart");

  const restoring = restartWithSameStore(directory, profilePath, bridge);
  assert.equal((await restoring.openDocument(target, password)).recovery?.content,
    "unsaved recovery words");
  const restored = await restoring.restoreRecoveredWork();
  assert.equal(restored.content, "unsaved recovery words");
  assert.equal((await restoring.unresolvedJournalSummary()).total, 1);

  const restarted = restartWithSameStore(directory, profilePath, bridge);
  const reopened = await restarted.openDocument(target, password);
  assert.equal(reopened.recovery?.content, "unsaved recovery words");
  assert.deepEqual(reopened.recovery?.cursor, { start: 22, end: 22 });
});

test("interrupted recovery acquisition retains the work through publication resume", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { service, target, directory, profilePath, bridge } = await setup(t);
  await service.enterEditMode();
  service.updateWorkingCopy({ content: "recovery under interruption",
    cursor: { start: 27, end: 27 } });
  await service.exitEditMode();
  await service.lock("restart");

  const restoring = restartWithSameStore(directory, profilePath, bridge);
  await restoring.openDocument(target, password);
  let interrupted = false;
  const guardedFs = Object.create(fs);
  guardedFs.rename = async (source: string, destination: string) => {
    if (!interrupted && destination === target) {
      interrupted = true;
      throw new Error("injected acquisition interruption");
    }
    return fs.rename(source, destination);
  };
  restoring.publications.fs = guardedFs;
  await assert.rejects(restoring.restoreRecoveredWork(),
    /acquisition interruption/);
  assert.equal((await restoring.unresolvedJournalSummary()).pendingPublications, 1);

  const restarted = restartWithSameStore(directory, profilePath, bridge);
  const reopened = await restarted.openDocument(target, password);
  assert.equal(reopened.recovery?.content, "recovery under interruption");
  assert.equal((await restarted.unresolvedJournalSummary()).total, 1);
});

test("Lock releases its suspended native lease before a document switch", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { service, target } = await setup(t);
  await service.enterEditMode();
  await service.lock("document-switch");
  assert.equal(service.hasSuspendedLease(), true);
  assert.deepEqual(await service.releaseSuspendedLease(target), { released: true });
  assert.equal(service.hasSuspendedLease(), false);
  await service.openDocument(target, password);
  assert.equal(service.container.authenticatedLease().active, false);
  assert.deepEqual(service.container.bytes(), await fs.readFile(target));
  await service.lock("document-close");
});

test("core lease advice gates a confirmed takeover and rejects the old heartbeat", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { service: first, target, directory, profilePath, bridge } = await setup(t);
  await first.enterEditMode();
  const original = first.container.authenticatedLease();
  const second = new DocumentService({ native: bridge, fs, profilePath,
    journalDirectory: path.join(directory, "other-journals"),
    witnessDirectory: path.join(directory, "other-witnesses"),
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" },
    utcNow: () => 500, monotonicNow: () => 500 });
  await second.openDocument(target, password);
  assert.equal(second.container.leaseAdvice({ suspendedSessionId: "0".repeat(32),
    suspendedCounter: 0, nowUtcMs: 500, unchangedMonotonicMs: 0 }),
  "confirm-takeover");
  let token: object | undefined;
  await assert.rejects(second.enterEditMode(), (error: any) => {
    token = error.takeoverToken;
    return error.code === "LEASE_CLOCK_UNCERTAIN" && Boolean(token);
  });
  await second.enterEditMode({ takeoverToken: token });
  assert.equal(second.container.leaseMode().leaseStatus, "held");
  assert.notEqual(second.container.authenticatedLease().sessionId, original.sessionId);
  assert.deepEqual(second.container.bytes(), await fs.readFile(target));
  await assert.rejects(first.exitEditMode(), (error: any) =>
    error.code === "LEASE_CHANGED");
  assert.equal(first.active, null);
  await second.exitEditMode();
  await second.lock("document-close");
});

test("interrupted lease release recovers exact bytes and the unsaved working copy", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  const { service, target, directory, profilePath, bridge } = await setup(t);
  await service.enterEditMode();
  service.updateWorkingCopy({ content: "recover these words",
    cursor: { start: 19, end: 19 } });
  let interrupted = false;
  const guardedFs = Object.create(fs);
  guardedFs.rename = async (source: string, destination: string) => {
    if (!interrupted && destination === target) {
      interrupted = true;
      throw new Error("injected lease replacement interruption");
    }
    return fs.rename(source, destination);
  };
  service.publications.fs = guardedFs;
  await assert.rejects(service.exitEditMode(), /lease replacement interruption/);
  assert.equal(service.active, null);
  assert.equal((await service.unresolvedJournalSummary()).pendingPublications, 1);

  const restarted = new DocumentService({ native: bridge, fs, profilePath,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" } });
  const opened = await restarted.openDocument(target, password);
  assert.equal(opened.recovery?.content, "recover these words",
    JSON.stringify({ publicationState: opened.publicationState,
      recovery: opened.recovery, journal: await restarted.unresolvedJournalSummary() }));
  assert.equal(opened.publicationState, "target-published");
  assert.equal(restarted.container.authenticatedLease().active, false);
  assert.deepEqual(restarted.container.bytes(), await fs.readFile(target));
  assert.equal((await restarted.unresolvedJournalSummary()).total, 1);
  await restarted.lock("document-close");
});
