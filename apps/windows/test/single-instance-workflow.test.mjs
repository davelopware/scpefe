import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { openTargetFromAdditionalData,
  openTargetFromCommandLine, acknowledgementToken } from "../src/single-instance.mjs";
import { applySwitchDecision, finishDocumentSwitch,
  OpenRequestQueue } from "../src/switch-document.mjs";

test("accepts only SCPEFE shell targets from command lines and instance metadata", () => {
  assert.equal(openTargetFromCommandLine(
    ["C:\\app\\SCPEFE.exe", "relative.scpefe"], "/documents"),
  "/documents/relative.scpefe");
  assert.equal(openTargetFromCommandLine(["app", "--inspect", "notes.txt"]), null);
  assert.equal(openTargetFromAdditionalData({ openTarget: "/safe/document.SCPEFE" }),
    "/safe/document.SCPEFE");
  assert.equal(openTargetFromAdditionalData({ openTarget: "relative.scpefe" }), null);
  assert.equal(openTargetFromAdditionalData({ openTarget: "/safe/document.txt" }), null);
  assert.equal(acknowledgementToken({
    acknowledgementToken: "123e4567-e89b-42d3-a456-426614174000",
  }), "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(acknowledgementToken({ acknowledgementToken: "../unsafe" }), null);
});

test("serializes racing shell open requests even after one fails", async () => {
  const queue = new OpenRequestQueue();
  const calls = [];
  let release;
  const first = queue.run(async () => {
    calls.push("first-start");
    await new Promise((resolve) => { release = resolve; });
    calls.push("first-end");
    throw new Error("wrong password");
  });
  const second = queue.run(async () => { calls.push("second"); return 2; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["first-start"]);
  release();
  await assert.rejects(first, /wrong password/);
  assert.equal(await second, 2);
  assert.deepEqual(calls, ["first-start", "first-end", "second"]);
});

test("switch choices save, preserve pending saves, or explicitly discard", async () => {
  const saved = { active: { dirty: true, recovery: null, manuallySealed: true,
    pendingPublication: false, unresolvedJournal: false, editMode: false,
    working: null },
  async enterEditMode() { this.active.editMode = true;
    this.active.working = { content: "changed" }; },
  async saveDocument(content) { assert.equal(content, "changed");
    this.active.dirty = false; return { publicationState: "target-published" }; } };
  assert.deepEqual(await applySwitchDecision(saved, "save"),
    { proceed: true, pendingPublication: false });

  const pending = { active: { dirty: false, recovery: null, manuallySealed: true,
    pendingPublication: true, unresolvedJournal: true, editMode: false,
    pendingRecord: { state: "pending-publication", publication: {} } },
  async reconnectPendingPublication() {
    return { publicationState: "pending-publication" };
  } };
  assert.deepEqual(await applySwitchDecision(pending, "save"),
    { proceed: true, pendingPublication: true });

  const discarded = { active: { ...pending.active }, calls: [],
    async discardPendingPublication() { this.calls.push("discard-publication");
      this.active.pendingPublication = false; this.active.unresolvedJournal = false; },
    async discardUnsavedForClose() { this.calls.push("discard-unsaved"); } };
  assert.deepEqual(await applySwitchDecision(discarded, "discard"),
    { proceed: true, pendingPublication: false });
  assert.deepEqual(discarded.calls, ["discard-publication"]);
});

test("provisional pending saves and conflicts block switching without data loss", async () => {
  const active = { dirty: false, recovery: null, manuallySealed: true,
    pendingPublication: true, unresolvedJournal: true, editMode: false };
  const provisional = { active: { ...active,
    pendingRecord: { state: "pending-publication",
      publication: { purpose: "regular-save" } } },
  async reconnectPendingPublication() {
    return { publicationState: "pending-publication" };
  } };
  await assert.rejects(applySwitchDecision(provisional, "save"),
    (error) => error.code === "DOCUMENT_SWITCH_PROVISIONAL_PENDING");
  assert.equal(provisional.active.pendingPublication, true);

  const conflict = { active: { ...active,
    pendingRecord: { state: "conflict", publication: {} } },
  async reconnectPendingPublication() { return { publicationState: "conflict" }; } };
  await assert.rejects(applySwitchDecision(conflict, "save"),
    (error) => error.code === "DOCUMENT_SWITCH_CONFLICT");
  assert.equal(conflict.active.pendingPublication, true);
});

test("a resumed manual pending save is not sealed a second time", async () => {
  let saveCalls = 0;
  const service = { active: { dirty: false, recovery: null, manuallySealed: true,
    pendingPublication: true, unresolvedJournal: true, editMode: false,
    pendingRecord: { state: "pending-publication", publication: {} } },
  async reconnectPendingPublication() {
    this.active.pendingPublication = false;
    return { publicationState: "target-published" };
  },
  async enterEditMode() { throw new Error("must not enter edit mode"); },
  async saveDocument() { saveCalls += 1; } };
  assert.deepEqual(await applySwitchDecision(service, "save"),
    { proceed: true, pendingPublication: false });
  assert.equal(saveCalls, 0);
});

test("finishing a switch releases edit mode before locking", async () => {
  const calls = [];
  const service = { active: { editMode: true },
    async exitEditMode() { calls.push("release"); this.active.editMode = false; },
    async lock(reason) { calls.push(`lock:${reason}`); this.active = null;
      return { journalSaved: true }; } };
  assert.deepEqual(await finishDocumentSwitch(service), { switched: true });
  assert.deepEqual(calls, ["release", "lock:open-another"]);
});

test("a pending publication locks without touching its unavailable target", async () => {
  const calls = [];
  const service = { active: { editMode: true, pendingPublication: true },
    async exitEditMode() { calls.push("unexpected-release"); },
    async lock(reason) { calls.push(`lock:${reason}`); this.active = null;
      return { journalSaved: true }; } };
  await finishDocumentSwitch(service);
  assert.deepEqual(calls, ["lock:open-another"]);
});

test("renderer makes external requests and unresolved journals accessible alerts", async () => {
  const renderer = await fs.readFile(
    new URL("../src/renderer.tsx", import.meta.url), "utf8");
  assert.match(renderer, /aria-labelledby="unresolved-journals-heading"/);
  assert.match(renderer, /Recovery work needs attention/);
  assert.match(renderer, /aria-labelledby="external-open-heading"/);
  assert.match(renderer, /Document password/);
});
