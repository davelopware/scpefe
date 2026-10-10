import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DocumentLifecycleHost } from "../src/document-lifecycle-host.mjs";
import { DocumentService } from "../src/document-service.mjs";

test("the production host resumes its own editing lease after lock and unlock", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-host-lease-resume-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(target, "container");
  await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
    email: "ada@example.test", deviceName: "Desk" }));
  let lease = { active: false, sessionId: "0".repeat(32), heartbeatCounter: 0,
    holderUtcMs: 0, durationMs: 600_000, holderName: "", holderEmail: "",
    deviceName: "" };
  const native = {
    openDocument() {
      return { content: "base", readOnly: true, canEdit: true,
        documentId: "56".repeat(16), baseRevision: "78".repeat(32),
        journalKey: Buffer.alloc(32, 8), lease: { ...lease } };
    },
    updateLease(bytes, _password, next) {
      lease = { ...next };
      return Buffer.from(bytes);
    },
  };
  const handlers = new Map();
  const host = await new DocumentLifecycleHost({
    ipc: { handle: (name, handler) => handlers.set(name, handler) },
    window: { on() {}, webContents: { send() {} } },
    picker: { chooseOpenTarget: async () => target },
    serviceFactory: (callbacks) => new DocumentService({ native, fs, profilePath,
      publicationCapabilities: { sameFilesystemTransaction: true,
        replacementGuarantee: "atomic-replace" },
      utcNow: () => 10_000, setTimer: () => ({ unref() {} }), clearTimer() {},
      ...callbacks }),
  }).start();

  await handlers.get("document:choose-open-target")();
  const opened = await handlers.get("document:open-selected")(null, "password words");
  assert.equal(opened.canEdit, true);
  assert.equal((await handlers.get("document:enter-edit-mode")()).readOnly, false);
  const firstSession = lease.sessionId;
  await host.lockActive("app-lock");
  assert.equal(host.service.active, null);

  const unlocked = await handlers.get("document:unlock")(null, "password words");
  assert.equal(unlocked.canEdit, true);
  assert.equal((await handlers.get("document:enter-edit-mode")()).readOnly, false);
  assert.equal(lease.sessionId, firstSession);
  assert.equal(lease.heartbeatCounter, 2);
  await host.lockActive("app-lock");

  lease = { ...lease, heartbeatCounter: 3 };
  await handlers.get("document:unlock")(null, "password words");
  await assert.rejects(handlers.get("document:enter-edit-mode")(),
    (error) => error.code === "LEASE_CHANGED");
  assert.equal(lease.heartbeatCounter, 3,
    "a changed lease is never overwritten during resume");
  await host.lockActive("app-lock");
});
