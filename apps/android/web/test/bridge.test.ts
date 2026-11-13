import assert from "node:assert/strict";
import { test } from "node:test";
import { createHost, type AndroidPluginContract } from "../src/bridge.ts";

const opened = { content: "alpha\n", readOnly: true, canEdit: false,
  contentType: "plain-text", publicationState: "target-published" } as const;

function fake(overrides: Partial<AndroidPluginContract> = {}): AndroidPluginContract {
  return {
    getProfile: async () => ({ profile: null }),
    saveProfile: async ({ profile }) => ({ profile }),
    getClientSettings: async () => ({ settings: { regularSaveEnabled: false,
      regularSaveIntervalMs: 120_000 } }),
    saveClientSettings: async ({ settings }) => ({ settings }),
    assessPasswordPolicy: async () => ({ assessment: "accepted" }),
    chooseCreateTarget: async () => ({ selected: true }),
    cancelCreateTarget: async () => {},
    createDocument: async () => ({ created: true, opened: { ...opened },
      name: "Untitled.scpefe" }),
    chooseOpenTarget: async () => ({ selected: true, name: "Selected document" }),
    cancelOpenTarget: async () => {},
    openSelectedDocument: async () => ({ opened: { ...opened } }),
    unlockDocument: async () => ({ opened: { ...opened } }),
    lock: async () => ({ locked: true, journalSaved: true, warningCode: null }),
    activity: async () => {},
    closeDocument: async () => ({ closed: true }),
    getUnresolvedJournalSummary: async () => ({ total: 0, pendingPublications: 0 }),
    enterEditMode: async () => ({ opened: { ...opened, readOnly: false, canEdit: true } }),
    restoreRecoveredWork: async () => ({ opened: { ...opened, readOnly: false,
      canEdit: true, recoveredUnsaved: true, cursor: { start: 0, end: 0 } } }),
    updateWorkingCopy: async () => ({ accepted: true }),
    saveDocument: async ({ request }) => ({ result: { saved: true,
      content: request.content, publicationState: "target-published",
      ...(request.revision ? { journalScope: request.journalScope,
        revision: request.revision } : {}) } }),
    reconnectPendingPublication: async () => ({ result: { content: "alpha\n",
      publicationState: "target-published" } }),
    ...overrides,
  };
}

test("profile and open/unlock use the typed plugin without exposing a target", async () => {
  let password = "";
  const host = createHost(fake({
    getProfile: async () => ({ profile: { name: "Ada", email: "ada@example.org",
      deviceName: "Android" } }),
    openSelectedDocument: async ({ password: value }) => {
      password = value; return { opened: { ...opened } }; },
  }));
  assert.deepEqual(await host.getProfile(), { name: "Ada", email: "ada@example.org",
    deviceName: "Android" });
  assert.deepEqual(await host.chooseOpenTarget(), { selected: true,
    name: "Selected document" });
  const result = await host.openSelectedDocument("correct horse battery staple");
  assert.notEqual(result.invitationRequired, true);
  if (result.invitationRequired) throw new Error("Unexpected invitation");
  assert.equal(result.content, "alpha\n");
  assert.equal(password, "correct horse battery staple");
  assert.equal("target" in (await host.unlockDocument(password)), false);
});

test("manual save keeps the submitted working revision and exact content", async () => {
  const host = createHost(fake());
  const version = { journalScope: "renderer-1", revision: 2 };
  assert.deepEqual(await host.saveDocument("alpha\nsecond\n", version), {
    saved: true, content: "alpha\nsecond\n", publicationState: "target-published",
    ...version,
  });
  await assert.rejects(host.saveDocument("x".repeat(1024 * 1024 + 1), version));
});

test("native lock events clear the shared session and retain checkpoint warnings", async () => {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const host = createHost(fake({ addListener: async (name, listener) => {
    listeners.set(name, listener);
    return { remove: async () => { listeners.delete(name); } };
  } }));
  const started: unknown[] = [], locked: unknown[] = [];
  const stopStarted = host.onLockStarted?.((value) => started.push(value));
  const stopLocked = host.onLocked((value) => locked.push(value));
  await Promise.resolve();
  listeners.get("lockStarted")?.({ causeCode: null });
  listeners.get("locked")?.({ locked: true, journalSaved: false,
    warningCode: "LOCK_CHECKPOINT_FAILED" });
  assert.deepEqual(started, [{ causeCode: null }]);
  assert.deepEqual(locked, [{ locked: true, journalSaved: false,
    warningCode: "LOCK_CHECKPOINT_FAILED" }]);
  stopStarted?.(); stopLocked();
  await Promise.resolve();
  assert.equal(listeners.size, 0);
});

test("provider divergence is passed through as a conflict", async () => {
  const host = createHost(fake({ saveDocument: async ({ request }) => ({ result: {
    saved: true, content: request.content, publicationState: "conflict",
  } }) }));
  assert.deepEqual(await host.saveDocument("local changes"), {
    saved: true, content: "local changes", publicationState: "conflict",
  });
});

test("invalid input is rejected before calling native plugin", async () => {
  let calls = 0;
  const host = createHost(fake({
    createDocument: async () => { calls++; throw new Error("unexpected call"); },
    openSelectedDocument: async () => { calls++; throw new Error("unexpected call"); },
  }));
  await assert.rejects(host.openSelectedDocument("x".repeat(4097)));
  await assert.rejects(host.createDocument({ ownerPassword: "missing fields" }));
  assert.equal(calls, 0);
});

test("malformed or oversized native content is rejected before React receives it", async () => {
  const host = createHost(fake({
    openSelectedDocument: async () => ({ opened: { ...opened,
      content: "x".repeat(1024 * 1024 + 1) } }),
  }));
  await assert.rejects(host.openSelectedDocument("correct horse battery staple"),
    /Invalid native document/);
});

test("native authentication failure remains a structured error", async () => {
  const failure = Object.assign(new Error("Password did not unlock this document."),
    { code: "AUTHENTICATION_FAILED" });
  const host = createHost(fake({ openSelectedDocument: async () => { throw failure; } }));
  await assert.rejects(host.openSelectedDocument("wrong password"),
    (error: unknown) => (error as { code?: string }).code === "AUTHENTICATION_FAILED");
});

test("edit lease, checkpoint, and recovery use the shared working-copy shape", async () => {
  let submitted: unknown;
  const host = createHost(fake({
    updateWorkingCopy: async ({ update }) => {
      submitted = update; return { accepted: true }; },
  }));
  const editable = await host.enterEditMode();
  if ("decisionRequired" in editable) throw new Error("Unexpected lease decision");
  assert.equal(editable.readOnly, false);
  assert.equal(editable.canEdit, true);
  const scope = host.createJournalScope();
  await host.updateWorkingCopy({ content: "draft\n", cursor: { start: 6, end: 6 },
    journalScope: scope, revision: 1 });
  assert.deepEqual(submitted, { content: "draft\n",
    cursor: { start: 6, end: 6 }, journalScope: scope, revision: 1 });
  const recovered = await host.restoreRecoveredWork();
  if ("decisionRequired" in recovered) throw new Error("Unexpected lease decision");
  assert.equal(recovered.recoveredUnsaved, true);
  assert.equal(recovered.readOnly, false);
  await assert.rejects(host.updateWorkingCopy({ content: "draft",
    cursor: { start: -1, end: 0 }, journalScope: scope, revision: 2 }));
});

test("malformed native recovery is rejected before adoption", async () => {
  const host = createHost(fake({ restoreRecoveredWork: async () => ({ opened: {
    ...opened, readOnly: false, canEdit: true, recoveredUnsaved: true,
    cursor: { start: 9, end: 10 },
  } }) }));
  await assert.rejects(host.restoreRecoveredWork(), /Invalid recovery/);
});
