// @ts-nocheck -- exercises the host target interface through the public document workflow.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DocumentService } from "../src/document-service.mjs";
import { statefulFake } from "./support/stateful-native-fake.ts";

const target = "provider:opaque-document-42";
const capabilities = Object.freeze({ readReread: true,
  exactCandidatePublication: true, exactByteVerification: true, outcomes: true });

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-opaque-target-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let image = null;
  let access = "available";
  let publication = "verified";
  let candidate = null;
  let publishes = 0;
  const documentTargets = {
    capabilities,
    owns: (reference) => reference === target,
    async read(reference) {
      assert.equal(reference, target);
      if (access !== "available" || image === null) {
        const error = new Error("Provider target cannot be read");
        error.code = access === "unavailable" ? "EIO" : "ENOENT";
        throw error;
      }
      return Buffer.from(image);
    },
    async create(reference, bytes) {
      assert.equal(reference, target);
      if (image !== null) throw Object.assign(new Error("target exists"), { code: "EEXIST" });
      image = Buffer.from(bytes);
      return "verified";
    },
    async removeCreated(reference, expected) {
      assert.equal(reference, target);
      assert.deepEqual(image, expected);
      image = null;
    },
    async publish(reference, base, bytes) {
      assert.equal(reference, target);
      assert.deepEqual(image, base);
      publishes += 1;
      candidate = Buffer.from(bytes);
      if (publication === "changed") {
        image = Buffer.from("saved:foreign work");
        return "ambiguous";
      }
      if (publication === "ambiguous") return "ambiguous";
      if (publication === "definite-failure") return "definite-failure";
      image = Buffer.from(bytes);
      return publication === "uncertain-after-write" ? "ambiguous" : "verified";
    },
  };
  let lease = { active: false, sessionId: "0".repeat(32), heartbeatCounter: 0,
    holderUtcMs: 0, durationMs: 600_000, holderName: "", holderEmail: "",
    deviceName: "" };
  const native = statefulFake({
    assessPasswordPolicy: () => "accepted",
    currentLease: () => ({ ...lease }),
    createDocument: () => Buffer.from("sealed:base"),
    openDocument(bytes) {
      const value = bytes.toString();
      if (!value.startsWith("sealed:") && !value.startsWith("saved:")) {
        throw new Error("unexpected target bytes");
      }
      return { content: value.slice(value.indexOf(":") + 1), readOnly: true,
        canEdit: true, documentId: "11".repeat(16),
        baseRevision: "22".repeat(32), journalKey: Buffer.alloc(32, 3),
        lease: { ...lease } };
    },
    saveDocument(_bytes, _password, input) {
      return Buffer.from(`saved:${input.content}`);
    },
    updateLease(bytes, _password, value) {
      lease = { ...value };
      return Buffer.from(bytes);
    },
  });
  const service = new DocumentService({ native, fs, documentTargets,
    profilePath: path.join(directory, "profile.json"),
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses") });
  await service.saveProfile({ name: "Ada", email: "ada@example.test",
    deviceName: "Device" });
  await service.createDocument(target, { ownerPassword: "owner password words",
    ownerPasswordConfirmation: "owner password words", recoveryPassword: "",
    recoveryPasswordConfirmation: "", content: "base",
    understandsIrrecoverable: true, storedRecoverySeparately: false });
  await service.openDocument(target, "owner password words");
  assert.deepEqual(service.publicationCapabilities(), capabilities);
  await service.enterEditMode();
  publishes = 0;
  candidate = null;
  return { service, documentTargets, get image() { return image; },
    set image(value) { image = value; },
    get candidate() { return candidate; },
    get publishes() { return publishes; },
    set access(value) { access = value; },
    set publication(value) { publication = value; } };
}

test("opaque target publishes and verifies the exact candidate through DocumentService",
  async (t) => {
    const f = await fixture(t);
    assert.deepEqual(await f.service.saveDocument("local work"), {
      saved: true, content: "local work", publicationState: "target-published" });
    assert.equal(f.publishes, 1);
    assert.deepEqual(f.image, f.candidate);
    assert.equal((await f.service.journals.read(f.service.active.documentId,
      f.service.active.journalKey)), null);
  });

for (const access of ["missing", "unavailable"]) {
  test(`opaque target ${access} preserves a pending exact candidate`, async (t) => {
    const f = await fixture(t);
    f.access = access;
    assert.equal((await f.service.saveDocument("offline work")).publicationState,
      "pending-publication");
    const journal = await f.service.journals.read(f.service.active.documentId,
      f.service.active.journalKey);
    assert.equal(journal.publication.kind, "host-target");
    assert.equal(journal.publication.transactionFile, undefined);
    assert.equal((await f.service.reconnectPendingPublication()).publicationState,
      "pending-publication");
    assert.equal((await f.service.journals.read(f.service.active.documentId,
      f.service.active.journalKey)).publication.candidate,
    journal.publication.candidate);
  });
}

test("opaque target change preserves candidate and enters conflict", async (t) => {
  const f = await fixture(t);
  f.publication = "changed";
  await assert.rejects(f.service.saveDocument("local work"),
    (error) => error.publicationPrepared === true);
  const journal = await f.service.journals.read(f.service.active.documentId,
    f.service.active.journalKey);
  assert.deepEqual(Buffer.from(journal.publication.candidate, "base64"), f.candidate);
  assert.equal((await f.service.reconnectPendingPublication()).publicationState,
    "conflict");
  const conflict = await f.service.journals.read(f.service.active.documentId,
    f.service.active.journalKey);
  assert.equal(conflict.state, "conflict");
  assert.equal(conflict.publication.candidate, journal.publication.candidate);
});

test("opaque target uncertain write is confirmed by byte reread", async (t) => {
  const f = await fixture(t);
  f.publication = "uncertain-after-write";
  assert.equal((await f.service.saveDocument("confirmed work")).publicationState,
    "target-published");
  assert.deepEqual(f.image, f.candidate);
});

test("opaque target ambiguous outcome retains candidate until reconnect", async (t) => {
  const f = await fixture(t);
  f.publication = "ambiguous";
  await assert.rejects(f.service.saveDocument("pending work"),
    (error) => error.publicationPrepared === true);
  const journal = await f.service.journals.read(f.service.active.documentId,
    f.service.active.journalKey);
  f.publication = "verified";
  assert.equal((await f.service.reconnectPendingPublication()).publicationState,
    "target-published");
  assert.deepEqual(f.image, Buffer.from(journal.publication.candidate, "base64"));
});

test("opaque target definite failure does not claim publication", async (t) => {
  const f = await fixture(t);
  const before = Buffer.from(f.image);
  const prior = { text: "recoverable draft", baseRevision: f.service.active.baseRevision,
    target, state: "unsaved", updateTime: 1, cursor: { start: 0, end: 0 } };
  await f.service.journals.write(f.service.active.documentId,
    f.service.active.journalKey, prior);
  f.publication = "definite-failure";
  await assert.rejects(f.service.saveDocument("unsaved work"),
    (error) => error.code === "TARGET_PUBLICATION_DEFINITE_FAILURE"
      && error.publicationPrepared !== true);
  assert.deepEqual(f.image, before);
  assert.equal(f.service.active.pendingPublication, false);
  assert.deepEqual(await f.service.journals.read(f.service.active.documentId,
    f.service.active.journalKey), prior);
});
