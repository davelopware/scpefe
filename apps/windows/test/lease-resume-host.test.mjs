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
  await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
    email: "ada@example.test", deviceName: "Desk" }));
  const initialLease = { active: false, sessionId: "0".repeat(32), heartbeatCounter: 0,
    holderUtcMs: 0, durationMs: 600_000, holderName: "", holderEmail: "",
    deviceName: "" };
  const encodeLease = (lease) => Buffer.from(JSON.stringify({ lease }));
  const decodeLease = (bytes) => JSON.parse(bytes.toString("utf8")).lease;
  const currentLease = async () => decodeLease(await fs.readFile(target));
  let selectedTarget = target;
  await fs.writeFile(target, encodeLease(initialLease));
  const native = {
    openDocument(bytes, password) {
      return { content: "base", readOnly: true, canEdit: true,
        recoverySlot: password === "master words",
        documentId: "56".repeat(16), baseRevision: "78".repeat(32),
        journalKey: Buffer.alloc(32, 8), lease: decodeLease(bytes) };
    },
    updateLease(bytes, _password, next) {
      return encodeLease(next);
    },
  };
  const handlers = new Map();
  const host = await new DocumentLifecycleHost({
    ipc: { handle: (name, handler) => handlers.set(name, handler) },
    window: { on() {}, webContents: { send() {} } },
    picker: { chooseOpenTarget: async () => selectedTarget },
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
  const firstSession = (await currentLease()).sessionId;
  const secondLocalSession = new DocumentService({ native, fs, profilePath,
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" }, utcNow: () => 10_000,
    setTimer: () => ({ unref() {} }), clearTimer() {} });
  await secondLocalSession.openDocument(target, "password words");
  await assert.rejects(secondLocalSession.enterEditMode(),
    (error) => error.code === "LEASE_ACTIVE",
    "matching local profile details do not authorize a second editing session");
  await secondLocalSession.lock("app-lock");
  await host.lockActive("app-lock");
  assert.equal(host.service.active, null);

  const unlocked = await handlers.get("document:unlock")(null, "password words");
  assert.equal(unlocked.canEdit, true);
  assert.equal((await handlers.get("document:enter-edit-mode")()).readOnly, false);
  assert.equal((await currentLease()).sessionId, firstSession);
  assert.equal((await currentLease()).heartbeatCounter, 2);
  await host.lockActive("app-lock");

  assert.equal(await handlers.get("document:close")(), true);
  assert.equal((await currentLease()).active, false,
    "closing a locked document releases its editing lease");
  const otherTarget = path.join(directory, "other.scpefe");
  await fs.writeFile(otherTarget, encodeLease(initialLease));
  selectedTarget = otherTarget;
  await handlers.get("document:choose-open-target")();
  await handlers.get("document:open-selected")(null, "password words");
  await handlers.get("document:enter-edit-mode")();
  await host.lockActive("app-lock");
  selectedTarget = target;
  await handlers.get("document:choose-open-target")();
  await handlers.get("document:open-selected")(null, "password words");
  assert.equal(decodeLease(await fs.readFile(otherTarget)).active, false,
    "switching away from a locked document releases its old lease");
  assert.equal((await handlers.get("document:enter-edit-mode")()).readOnly, false);
  await host.lockActive("app-lock");

  const lockedBytes = await fs.readFile(target);
  const lockedLease = decodeLease(lockedBytes);
  await fs.writeFile(target, encodeLease({ ...lockedLease,
    heartbeatCounter: lockedLease.heartbeatCounter + 1 }));
  assert.equal(await handlers.get("document:close")(), true,
    "Close can finish without erasing a lease changed by another session");
  assert.equal((await currentLease()).heartbeatCounter,
    lockedLease.heartbeatCounter + 1);
  await fs.writeFile(target, encodeLease(initialLease));

  await handlers.get("document:choose-open-target")();
  await handlers.get("document:open-selected")(null, "password words");
  assert.equal((await handlers.get("document:enter-edit-mode")()).readOnly, false);
  await host.lockActive("app-lock");

  const lease = await currentLease();
  await fs.writeFile(target, encodeLease({ ...lease,
    heartbeatCounter: lease.heartbeatCounter + 1 }));
  await handlers.get("document:unlock")(null, "password words");
  await assert.rejects(handlers.get("document:enter-edit-mode")(),
    (error) => error.code === "LEASE_CHANGED");
  assert.equal((await currentLease()).heartbeatCounter, lease.heartbeatCounter + 1,
    "a changed lease is never overwritten during resume");
  await host.lockActive("app-lock");

  const master = new DocumentService({ native, fs, profilePath,
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" }, utcNow: () => 10_000,
    setTimer: () => ({ unref() {} }), clearTimer() {} });
  await master.openDocument(target, "master words");
  let staleToken;
  await assert.rejects(master.enterEditMode(), (error) => {
    staleToken = error.takeoverToken;
    return error.code === "LEASE_ACTIVE" && Boolean(staleToken);
  });
  const beforeTakeover = await currentLease();
  await fs.writeFile(target, encodeLease({ ...beforeTakeover,
    heartbeatCounter: beforeTakeover.heartbeatCounter + 1 }));
  await assert.rejects(master.enterEditMode({ takeoverToken: staleToken }),
    (error) => error.code === "LEASE_CHANGED",
    "master confirmation cannot overwrite a lease changed after the warning");
  let token;
  await assert.rejects(master.enterEditMode(), (error) => {
    token = error.takeoverToken;
    return error.code === "LEASE_ACTIVE" && Boolean(token);
  });
  assert.equal((await master.enterEditMode({ takeoverToken: token })).readOnly, false);
  assert.notEqual((await currentLease()).sessionId, beforeTakeover.sessionId);
  await master.exitEditMode();
});
