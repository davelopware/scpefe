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
