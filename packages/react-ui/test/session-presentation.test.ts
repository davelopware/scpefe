import assert from "node:assert/strict";
import test from "node:test";
import { DocumentSession, type DocumentSessionHost, type WorkingCopyJournalHost } from "@scpefe/frontend-core";
import { SessionPresentation } from "../src/session/session-presentation.ts";
import type { DocumentOpened } from "../src/session/types.ts";

const opened: DocumentOpened = { content: "draft", readOnly: true, canEdit: true,
  publicationState: "target-published", targetName: "notes.scpefe" };

function setup() {
  type EditResult = DocumentOpened | { decisionRequired: "lease-takeover";
    operation: "edit"; holderName: string; authorization: string };
  let edit: () => Promise<EditResult> = async () => { throw new Error("private host path"); };
  const host = { enterEditMode: () => edit() } as unknown as DocumentSessionHost<DocumentOpened>;
  const journal = { createJournalScope: () => "scope", updateWorkingCopy: async () => ({}),
    onJournalWarning: () => () => {} } as WorkingCopyJournalHost;
  const session = new DocumentSession(host, journal);
  session.adopt(opened);
  const presentation = new SessionPresentation(session, () => "The operation could not be completed safely.");
  return { session, presentation, succeed: () => { edit = async () => ({ ...opened,
    readOnly: false }); }, challenge: () => { edit = async () => ({
      decisionRequired: "lease-takeover", operation: "edit", holderName: "Ada",
      authorization: "private authorization",
    }); }, defer: () => {
      let resolve!: (value: EditResult) => void;
      const result = new Promise<EditResult>((complete) => { resolve = complete; });
      edit = () => result;
      return () => resolve({ ...opened, readOnly: false });
    } };
}

test("edit failure is one selected decision with safe text and retry focus", async () => {
  const { session, presentation } = setup();
  assert.deepEqual(await session.enterEditMode(), { status: "failed", code: "OPERATION_FAILED" });
  const view = presentation.view();
  assert.deepEqual(view.selectedDecision, { kind: "edit-unavailable",
    message: "The operation could not be completed safely." });
  assert.equal(view.blocked, true);
  assert.equal(view.focusIntent, "edit-retry");
  assert.equal(JSON.stringify(view).includes("private host path"), false);
  await presentation.act("continue-read-only");
  assert.equal(presentation.view().selectedDecision, null);
  assert.equal(presentation.view().blocked, false);
  assert.equal(presentation.view().focusIntent, "return");
  session.dispose();
});

test("retry exposes the takeover message without leaking its authorization", async () => {
  const { session, presentation, challenge } = setup();
  await session.enterEditMode();
  challenge();
  await presentation.act("retry-edit");
  const view = presentation.view();
  assert.equal(view.selectedDecision, null);
  assert.equal(view.safeMessage, "Editing requires a confirmed lease takeover.");
  assert.equal(view.focusIntent, "return");
  assert.equal(JSON.stringify(view).includes("private authorization"), false);
  assert.equal(session.getSnapshot().attention?.kind, "lease-takeover");
  session.dispose();
});

test("a late retry cannot present an outcome from a replaced document", async () => {
  const { session, presentation, defer } = setup();
  await session.enterEditMode();
  const finish = defer();
  const pending = presentation.act("retry-edit");
  await Promise.resolve();
  session.adopt({ ...opened, content: "replacement" });
  finish();
  await pending;
  assert.equal(presentation.view().safeMessage, null);
  assert.equal(presentation.view().focusIntent, null);
  assert.equal(session.getSnapshot().kind, "read-only");
  session.dispose();
});

test("retry runs through the document session and exposes its safe outcome", async () => {
  const { session, presentation, succeed } = setup();
  await session.enterEditMode();
  succeed();
  await presentation.act("retry-edit");
  assert.equal(session.getSnapshot().kind, "edit");
  assert.equal(presentation.view().safeMessage, "Edit mode entered.");
  assert.equal(presentation.view().focusIntent, "return");
  assert.equal(presentation.view().blocked, false);
  session.dispose();
});

test("recovery waits behind a form, then restores unsaved work with a safe outcome", async () => {
  const privateText = "private recovered content";
  const recovered = { ...opened, recovery: { content: privateText, state: "unsaved" as const,
    updateTime: 42, cursor: { start: 0, end: 0 } } };
  const host = { restoreRecoveredWork: async () => ({ ...opened, readOnly: false,
    content: privateText }) } as unknown as DocumentSessionHost<DocumentOpened>;
  const journal = { createJournalScope: () => "scope", updateWorkingCopy: async () => ({}),
    onJournalWarning: () => () => {} } as WorkingCopyJournalHost;
  const session = new DocumentSession(host, journal);
  session.adopt(recovered);
  const presentation = new SessionPresentation(session, () => "The operation could not be completed safely.");
  assert.equal(presentation.view({ formActive: true }).selectedDecision, null);
  assert.deepEqual(presentation.view().selectedDecision, { kind: "recovery-decision",
    updateTime: 42, failureMessage: null });
  await presentation.act("restore-recovery");
  assert.equal(presentation.view().safeMessage, "Recovered work restored as unsaved changes.");
  assert.equal(presentation.view().focusIntent, "return");
  assert.equal(JSON.stringify(presentation.view()).includes(privateText), false);
  session.dispose();
});

test("head and unreadable-journal decisions keep read-only authority and safe failure text", async () => {
  for (const decision of ["head", "unreadable"] as const) {
    let calls = 0;
    const host = {
      acceptHeadMismatch: async () => {
        calls += 1;
        if (calls === 1) throw new Error("private witness location");
        return { ...opened, headMismatch: undefined };
      },
      discardUnreadableJournal: async () => {
        calls += 1;
        if (calls === 1) throw new Error("private journal location");
        return { ...opened, unreadableJournal: undefined };
      },
    } as unknown as DocumentSessionHost<DocumentOpened>;
    const journal = { createJournalScope: () => "scope", updateWorkingCopy: async () => ({}),
      onJournalWarning: () => () => {} } as WorkingCopyJournalHost;
    const session = new DocumentSession(host, journal);
    session.adopt(decision === "head" ? { ...opened, headMismatch: {
      kind: "rollback", title: "private title", explanation: "private explanation",
      editingBlocked: true } } : { ...opened, unreadableJournal: true });
    const presentation = new SessionPresentation(session,
      () => "The operation could not be completed safely.");
    const action = decision === "head" ? "accept-head" : "discard-unreadable";
    assert.equal(presentation.view({ formActive: true }).selectedDecision, null);
    assert.equal(presentation.view().selectedDecision?.kind,
      decision === "head" ? "head-mismatch" : "unreadable-journal");
    await presentation.act(action);
    assert.equal(session.getSnapshot().kind, "read-only");
    assert.equal(presentation.view().focusIntent, "decision-action");
    assert.equal(presentation.view().selectedDecision?.kind,
      decision === "head" ? "head-mismatch" : "unreadable-journal");
    assert.equal(JSON.stringify(presentation.view()).includes("private"), false);
    await presentation.act(action);
    assert.equal(presentation.view().selectedDecision, null);
    assert.match(presentation.view().safeMessage ?? "", /Editing may now be enabled/);
    assert.equal(calls, 2);
    session.dispose();
  }
});

test("a replaced document drops a pending recovery outcome", async () => {
  let finish!: (value: DocumentOpened) => void;
  const host = { discardRecoveredWork: () => new Promise<DocumentOpened>((resolve) => {
    finish = resolve;
  }) } as unknown as DocumentSessionHost<DocumentOpened>;
  const journal = { createJournalScope: () => "scope", updateWorkingCopy: async () => ({}),
    onJournalWarning: () => () => {} } as WorkingCopyJournalHost;
  const session = new DocumentSession(host, journal);
  session.adopt({ ...opened, recovery: { content: "private", state: "unsaved",
    updateTime: 42, cursor: { start: 0, end: 0 } } });
  const presentation = new SessionPresentation(session, () => "safe failure");
  const pending = presentation.act("discard-recovery");
  await Promise.resolve();
  session.adopt({ ...opened, content: "new document" });
  finish(opened);
  await pending;
  assert.equal(presentation.view().safeMessage, null);
  assert.equal(presentation.view().focusIntent, null);
  session.dispose();
});
