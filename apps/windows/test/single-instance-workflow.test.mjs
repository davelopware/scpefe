import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { openTargetFromAdditionalData,
  openTargetFromCommandLine, openTargetFromUrl, acknowledgementCredentials,
  acknowledgementTargetHash, createAcknowledgement, validateAcknowledgement,
  OrderedOpenRequests } from "../src/single-instance.mjs";
import { applySwitchDecision, finishDocumentSwitch,
  OpenRequestQueue } from "../src/switch-document.mjs";

test("accepts only SCPEFE shell targets from command lines and instance metadata", () => {
  assert.equal(openTargetFromCommandLine(
    ["C:\\app\\SCPEFE.exe", "relative.scpefe"], path.resolve("/documents")),
  path.resolve("/documents", "relative.scpefe"));
  assert.equal(openTargetFromCommandLine(["app", "--inspect", "notes.txt"]), null);
  const absoluteTarget = path.resolve("/safe/document.SCPEFE");
  assert.equal(openTargetFromAdditionalData({ openTarget: absoluteTarget }),
    absoluteTarget);
  assert.equal(openTargetFromAdditionalData({ openTarget: "relative.scpefe" }), null);
  assert.equal(openTargetFromAdditionalData({ openTarget: "/safe/document.txt" }), null);
  assert.deepEqual(acknowledgementCredentials({
    acknowledgementId: "123e4567-e89b-42d3-a456-426614174000",
    acknowledgementSecret: "123e4567-e89b-42d3-a456-426614174001",
  }), { id: "123e4567-e89b-42d3-a456-426614174000",
    secret: "123e4567-e89b-42d3-a456-426614174001" });
  assert.equal(acknowledgementCredentials({ acknowledgementId: "../unsafe",
    acknowledgementSecret: "123e4567-e89b-42d3-a456-426614174001" }), null);
  const fileTarget = path.resolve("safe/document.scpefe");
  const linkedTarget = path.resolve("safe/linked.scpefe");
  assert.equal(openTargetFromUrl(pathToFileURL(fileTarget).href), fileTarget);
  const linkedUrl = new URL("scpefe://open");
  linkedUrl.searchParams.set("target", pathToFileURL(linkedTarget).href);
  assert.equal(openTargetFromUrl(linkedUrl.href), linkedTarget);
  assert.equal(openTargetFromUrl("https://example.test/document.scpefe"), null);
});

test("acknowledgements authenticate launch, target, request, and protocol state", () => {
  const credentials = { id: "123e4567-e89b-42d3-a456-426614174000",
    secret: "123e4567-e89b-42d3-a456-426614174001" };
  const targetHash = acknowledgementTargetHash(path.resolve("safe/document.scpefe"));
  const value = createAcknowledgement(credentials, {
    requestToken: "123e4567-e89b-42d3-a456-426614174002",
    targetHash, sequence: 1, status: "queued",
  });
  assert.deepEqual(validateAcknowledgement(credentials, value, targetHash), {
    id: credentials.id, requestToken: value.requestToken,
    targetHash, sequence: 1, status: "queued",
  });
  assert.equal(validateAcknowledgement(credentials,
    { ...value, status: "opened" }, targetHash), null);
  const invalidTransition = createAcknowledgement(credentials,
    { ...value, status: "opened" });
  assert.equal(validateAcknowledgement(credentials, invalidTransition, targetHash), null);
  assert.equal(validateAcknowledgement(credentials, value,
    acknowledgementTargetHash(path.resolve("safe/other.scpefe"))), null);
  assert.equal(validateAcknowledgement({ ...credentials,
    secret: "123e4567-e89b-42d3-a456-426614174003" }, value, targetHash), null);
  assert.equal(validateAcknowledgement(credentials,
    { ...value, sequence: 4 }, targetHash), null);
});

test("stages lifecycle requests until ready and holds strict FIFO through completion", () => {
  let number = 0;
  const requests = new OrderedOpenRequests({ randomToken: () => `token-${++number}` });
  const first = requests.enqueue({ target: "/first.scpefe", source: "command-line" });
  const second = requests.enqueue({ target: "/second.scpefe",
    acknowledgement: { id: "ack-2", secret: "secret-2" },
    source: "second-instance" });
  const third = requests.enqueue({ target: "/third.scpefe",
    acknowledgement: { id: "ack-3", secret: "secret-3" }, source: "open-file" });
  assert.equal(second.ack.id, "ack-2");
  assert.equal(requests.take(), null);
  requests.setReady();
  assert.equal(requests.take(), first);
  assert.equal(requests.take(), null);
  assert.equal(requests.current(second.token), null);
  assert.equal(requests.complete(first.token), first);
  assert.equal(requests.take(), second);
  assert.throws(() => requests.complete(third.token), /not active/);
  requests.complete(second.token);
  assert.equal(requests.take(), third);
  requests.complete(third.token);
  assert.equal(requests.size, 0);
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

test("unreadable recovery journals require the trusted document-scoped path", async () => {
  const service = { active: { dirty: false, recovery: null, manuallySealed: true,
    pendingPublication: false, pendingRecord: null, unresolvedJournal: true,
    unreadableJournal: true, editMode: false } };
  await assert.rejects(applySwitchDecision(service, "discard"),
    (error) => error.code === "DOCUMENT_SWITCH_UNREADABLE_JOURNAL");
  assert.equal(service.active.unresolvedJournal, true);
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

test("main registers file and URL lifecycle events before draining staged requests", async () => {
  const main = await fs.readFile(new URL("../src/main.mjs", import.meta.url), "utf8");
  assert.match(main, /app\.on\("open-file"/);
  assert.match(main, /app\.on\("open-url"/);
  assert.match(main, /externalRequests\.setReady\(\)/);
  assert.match(main, /acknowledgeRequest\(request, "queued", 1\)/);
  assert.match(main, /acknowledgeRequest\(request, "presented", 2\)/);
  assert.match(main,
    /acknowledgeRequest\(pending, opened \? "opened" : "canceled", 3\)/);
  assert.match(main, /validateAcknowledgement\(instanceAcknowledgement/);
});
