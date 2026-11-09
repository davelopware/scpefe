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
    closeDocument: async () => ({ closed: true }),
    getUnresolvedJournalSummary: async () => ({ total: 0, pendingPublications: 0 }),
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
