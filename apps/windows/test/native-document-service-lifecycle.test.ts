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
    const base = native.createDocument({ ...profile, content: "base words",
      ownerPassword: password, timestampMs: 1 });
    await fs.writeFile(target, base);
    const authenticatedBase = native.openDocument(base, password);
    const candidate = native.saveDocument(base, password, { ...profile,
      content: "pending words", timestampMs: 2 });
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
      const remote = native.saveDocument(base, password, { ...profile,
        content: "remote words", timestampMs: 3 });
      await fs.writeFile(target, remote);
    } else if (recovery === "replaced-target") {
      const replacement = native.createDocument({ ...profile,
        content: "other document", ownerPassword: password, timestampMs: 4 });
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
      assert.equal(native.openDocument(await fs.readFile(target), password)
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
