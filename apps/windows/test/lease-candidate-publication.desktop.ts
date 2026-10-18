// @ts-nocheck -- stateful host fixtures retain the legacy native bridge shape.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DocumentService } from "../src/document-service.mjs";
import { statefulFake } from "./support/stateful-native-fake.ts";

const emptyLease = { active: false, sessionId: "0".repeat(32),
  heartbeatCounter: 0, holderUtcMs: 0, durationMs: 600_000,
  holderName: "", holderEmail: "", deviceName: "" };
const encode = (lease) => Buffer.from(JSON.stringify({ lease }));
const decode = (bytes) => JSON.parse(bytes.toString()).lease;

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-lease-candidate-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(target, encode(emptyLease));
  await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
    email: "ada@example.test", deviceName: "Desk" }));
  const native = statefulFake({ leaseEncodedInBytes: true,
    openDocument(bytes) {
      return { content: "base", readOnly: true, canEdit: true,
        documentId: "56".repeat(16), baseRevision: "78".repeat(32),
        journalKey: Buffer.alloc(32, 8), lease: decode(bytes) };
    },
    updateLease(_bytes, _password, next) { return encode(next); },
  });
  const options = { native, fs, profilePath, utcNow: () => 10_000,
    setTimer: () => ({ unref() {} }), clearTimer() {},
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" } };
  const service = new DocumentService(options);
  await service.openDocument(target, "password words");
  return { service, options, target };
}

function interruptReplacement(service, target) {
  let interrupted = false;
  service.publications.fs = { ...fs, async rename(source, destination) {
    if (!interrupted && destination === target) {
      interrupted = true;
      throw new Error("interrupted lease replacement");
    }
    return fs.rename(source, destination);
  } };
}

test("an unpublished lease candidate does not enter Edit mode and can be retried",
  async (t) => {
    const { service, target } = await fixture(t);
    service.publications.publish = async () => {
      throw new Error("publication rejected before preparation");
    };
    await assert.rejects(service.enterEditMode(), /before preparation/);
    assert.equal(service.pendingNativeCandidate, null);
    assert.equal(service.container.leaseMode().editing, false);
    assert.deepEqual(await fs.readFile(target), encode(emptyLease));
    assert.equal((await service.journals.read(service.active.documentId,
      service.active.journalKey))?.publication, undefined);
  });

test("an interrupted acquisition resumes its exact candidate after restart",
  async (t) => {
    const { service, options, target } = await fixture(t);
    interruptReplacement(service, target);
    await assert.rejects(service.enterEditMode(), /interrupted lease replacement/);
    assert.equal(service.container.leaseMode().editing, false);
    assert.equal(service.active.editMode, false);
    const record = await service.journals.read(service.active.documentId,
      service.active.journalKey);
    const candidate = Buffer.from(record.publication.candidate, "base64");
    assert.equal(record.publication.purpose, "lease-change");
    assert.deepEqual(await fs.readFile(target), encode(emptyLease));

    const restarted = new DocumentService(options);
    const opened = await restarted.openDocument(target, "password words");
    assert.equal(opened.publicationState, "target-published");
    assert.deepEqual(await fs.readFile(target), candidate);
    assert.deepEqual(restarted.container.bytes(), candidate);
    assert.equal((await restarted.journals.read(restarted.active.documentId,
      restarted.active.journalKey))?.publication, undefined);
  });

test("a stale target leaves the candidate pending without claiming its lease",
  async (t) => {
    const { service, options, target } = await fixture(t);
    const publish = service.publications.publish.bind(service.publications);
    const changed = encode({ ...emptyLease, heartbeatCounter: 4 });
    service.publications.publish = async (request) => {
      await fs.writeFile(target, changed);
      return publish(request);
    };
    await assert.rejects(service.enterEditMode(),
      (error) => error.publicationPrepared === true);
    assert.equal(service.container.leaseMode().editing, false);
    assert.equal(service.active.editMode, false);
    assert.deepEqual(await fs.readFile(target), changed);
    const restarted = new DocumentService(options);
    const opened = await restarted.openDocument(target, "password words");
    assert.equal(opened.publicationState, "conflict");
    assert.deepEqual(await fs.readFile(target), changed);
  });

test("an interrupted release retains unsaved work and resumes exact bytes",
  async (t) => {
    const { service, options, target } = await fixture(t);
    await service.enterEditMode();
    service.updateWorkingCopy({ content: "private unfinished text",
      cursor: { start: 23, end: 23 } });
    interruptReplacement(service, target);
    await assert.rejects(service.exitEditMode(), /interrupted lease replacement/);
    const summary = await service.unresolvedJournalSummary();
    assert.equal(summary.pendingPublications, 1);
    const record = await service.journals.read("56".repeat(16),
      Buffer.alloc(32, 8));
    assert.equal(record.text, "private unfinished text");
    assert.equal(record.publication.purpose, "lease-change");
    const candidate = Buffer.from(record.publication.candidate, "base64");

    const restarted = new DocumentService(options);
    const opened = await restarted.openDocument(target, "password words");
    assert.equal(opened.publicationState, "target-published");
    assert.equal(opened.recovery?.content, "private unfinished text");
    assert.deepEqual(await fs.readFile(target), candidate);
    assert.equal(decode(restarted.container.bytes()).active, false);
  });

test("a suspended release journals exact bytes and keeps unsaved work on restart",
  async (t) => {
    const { service, options, target } = await fixture(t);
    await service.enterEditMode();
    service.updateWorkingCopy({ content: "locked unfinished text",
      cursor: { start: 22, end: 22 } });
    await service.lock("screen-lock");
    assert.equal(service.hasSuspendedLease(), true);
    interruptReplacement(service, target);
    await assert.rejects(service.releaseSuspendedLease(target),
      /interrupted lease replacement/);
    const record = await service.journals.read("56".repeat(16), Buffer.alloc(32, 8));
    assert.equal(record.text, "locked unfinished text");
    const candidate = Buffer.from(record.publication.candidate, "base64");
    assert.equal(service.pendingNativeCandidate !== null, true);

    const restarted = new DocumentService(options);
    const opened = await restarted.openDocument(target, "password words");
    assert.equal(opened.publicationState, "target-published");
    assert.equal(opened.recovery?.content, "locked unfinished text");
    assert.deepEqual(await fs.readFile(target), candidate);
    assert.equal(decode(restarted.container.bytes()).active, false);
  });

test("retrying a suspended release resumes its journaled candidate",
  async (t) => {
    const { service, target } = await fixture(t);
    await service.enterEditMode();
    await service.lock("screen-lock");
    interruptReplacement(service, target);
    await assert.rejects(service.releaseSuspendedLease(target),
      /interrupted lease replacement/);
    const record = await service.journals.read("56".repeat(16), Buffer.alloc(32, 8));
    const candidate = Buffer.from(record.publication.candidate, "base64");
    assert.deepEqual(await service.releaseSuspendedLease(target), { released: true });
    assert.equal(service.hasSuspendedLease(), false);
    assert.equal(service.pendingNativeCandidate, null);
    assert.deepEqual(await fs.readFile(target), candidate);
    assert.equal(decode(service.container.bytes()).active, false);
  });
