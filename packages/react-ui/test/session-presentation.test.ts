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
  assert.deepEqual(view.selectedDecision, { kind: "lease-takeover", operation: "edit",
    holderName: "Ada", errorMessage: null });
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

test("lease takeover uses one decision and cancellation consumes its authorization", async () => {
  let canceled = "";
  const host = {
    enterEditMode: async () => ({ decisionRequired: "lease-takeover", operation: "edit",
      holderName: "Ada", authorization: "private authorization" }),
    cancelLeaseTakeover: async (authorization: string) => { canceled = authorization; return true; },
  } as unknown as DocumentSessionHost<DocumentOpened>;
  const session = new DocumentSession(host, {
    createJournalScope: () => "scope", updateWorkingCopy: async () => ({}),
    onJournalWarning: () => () => {},
  } as WorkingCopyJournalHost);
  session.adopt(opened);
  const presentation = new SessionPresentation(session, () => "safe failure");
  await session.enterEditMode();
  assert.deepEqual(presentation.view().selectedDecision, {
    kind: "lease-takeover", holderName: "Ada", operation: "edit", errorMessage: null,
  });
  assert.equal(presentation.view({ formActive: true }).selectedDecision, null);
  await presentation.act("cancel-lease");
  assert.equal(canceled, "private authorization");
  assert.equal(presentation.view().selectedDecision, null);
  assert.equal(presentation.view().safeMessage,
    "Lease takeover canceled; the document session is unchanged.");
  assert.equal(JSON.stringify(presentation.view()).includes("private authorization"), false);
  session.dispose();
});

test("migration failure stays actionable with a safe message and retry focus", async () => {
  const host = { migrateDocument: async () => { throw new Error("private path"); } } as
    unknown as DocumentSessionHost<DocumentOpened>;
  const session = new DocumentSession(host, {
    createJournalScope: () => "scope", updateWorkingCopy: async () => ({}),
    onJournalWarning: () => () => {},
  } as WorkingCopyJournalHost);
  session.adopt({ ...opened, migrationRequired: true, migrationCanEdit: true });
  const presentation = new SessionPresentation(session, () => "safe failure");
  assert.equal(presentation.view().selectedDecision?.kind, "migration-decision");
  await presentation.act("migrate");
  assert.equal(presentation.view().safeMessage, "safe failure");
  assert.equal(presentation.view().focusIntent, "migration-retry");
  assert.equal(JSON.stringify(presentation.view()).includes("private path"), false);
  session.dispose();
});

test("changed takeover evidence presents the current holder and cannot replay authorization", async () => {
  const used: string[] = [];
  const host = { enterEditMode: async ({ authorization }: { authorization?: string } = {}) => {
    if (authorization) used.push(authorization);
    return { decisionRequired: "lease-takeover" as const, operation: "edit" as const,
      holderName: authorization ? "Bea" : "Ada",
      authorization: authorization ? "second secret" : "first secret" };
  } } as unknown as DocumentSessionHost<DocumentOpened>;
  const session = new DocumentSession(host, { createJournalScope: () => "scope",
    updateWorkingCopy: async () => ({}), onJournalWarning: () => () => {},
  } as WorkingCopyJournalHost);
  session.adopt(opened);
  const presentation = new SessionPresentation(session, () => "safe failure");
  await session.enterEditMode();
  await presentation.act("confirm-lease");
  assert.deepEqual(presentation.view().selectedDecision, { kind: "lease-takeover",
    holderName: "Bea", operation: "edit",
    errorMessage: "The lease changed. Review the current holder before trying again." });
  assert.deepEqual(used, ["first secret"]);
  assert.equal(presentation.view().focusIntent, "decision-action");
  await presentation.act("confirm-lease");
  assert.deepEqual(used, ["first secret", "second secret"]);
  session.dispose();
});

test("compaction cancellation and safe failure return to the staged decision", async () => {
  const host = { compactDocument: async () => { throw new Error("private backup path"); } } as
    unknown as DocumentSessionHost<DocumentOpened>;
  const session = new DocumentSession(host, { createJournalScope: () => "scope",
    updateWorkingCopy: async () => ({}), onJournalWarning: () => () => {},
  } as WorkingCopyJournalHost);
  session.adopt({ ...opened, readOnly: false, canAddPasswords: true,
    canRemovePasswords: true });
  const presentation = new SessionPresentation(session, () => "safe failure");
  assert.equal(session.requestCompaction().status, "attention");
  assert.equal(presentation.view().selectedDecision?.kind, "compaction-decision");
  await presentation.act("compact");
  assert.deepEqual(presentation.view().selectedDecision, {
    kind: "compaction-decision", failureMessage: "safe failure",
  });
  assert.equal(presentation.view().safeMessage, "safe failure");
  await presentation.act("compaction-canceled");
  assert.equal(presentation.view().selectedDecision, null);
  assert.equal(presentation.view().safeMessage,
    "Compaction canceled; document history is unchanged.");
  assert.equal(JSON.stringify(presentation.view()).includes("private backup path"), false);
  session.dispose();
});
