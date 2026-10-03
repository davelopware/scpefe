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

test("queued external opens wait behind a form and document attention, then retain FIFO authority", async () => {
  const attempted: string[] = [];
  const host = { openExternalDocument: async ({ token }: { token: string }) => {
    attempted.push(token);
    if (attempted.length === 1) throw new Error("private password failure");
    return { ...opened, content: token };
  }, cancelExternalOpen: async () => true,
  discardRecoveredWork: async () => opened } as unknown as DocumentSessionHost<DocumentOpened>;
  const session = new DocumentSession(host, { createJournalScope: () => "scope",
    updateWorkingCopy: async () => ({}), onJournalWarning: () => () => {},
  } as WorkingCopyJournalHost);
  session.adopt({ ...opened, recovery: { content: "private", state: "unsaved",
    updateTime: 1, cursor: { start: 0, end: 0 } } });
  const presentation = new SessionPresentation(session, () => "Safe failure.");
  session.queueExternalOpen({ token: "first" });
  session.queueExternalOpen({ token: "second" });
  assert.equal(presentation.activateQueuedExternalOpen({ formActive: true }), false);
  assert.equal(presentation.activateQueuedExternalOpen(), false);
  assert.equal(session.getSnapshot().externalOpen?.queued, 2);
  await presentation.act("discard-recovery");
  assert.equal(presentation.activateQueuedExternalOpen({ formActive: true }), false);
  assert.equal(presentation.activateQueuedExternalOpen(), true);
  assert.deepEqual(session.getSnapshot().externalOpen, { active: true, queued: 1 });
  assert.equal(presentation.activateQueuedExternalOpen(), false);
  assert.equal((await session.openExternal("wrong")).status, "failed");
  assert.equal(presentation.activateQueuedExternalOpen(), false);
  assert.deepEqual(session.getSnapshot().externalOpen, { active: true, queued: 1 });
  assert.deepEqual(await session.cancelExternalOpen(), { status: "external-canceled" });
  assert.equal(presentation.activateQueuedExternalOpen(), true);
  assert.equal((await session.openExternal("correct")).status, "opened");
  assert.deepEqual(attempted, ["first", "second"]);
  session.dispose();
});

test("lifecycle protection preempts a form, retries failure, and restores it on cancel", async () => {
  let attempts = 0;
  const host = { resolveProtection: async () => (++attempts === 1
    ? { completed: false, retryToken: "retry", errorCode: "LIFECYCLE_FAILED" }
    : { completed: true, proceed: false }) } as unknown as DocumentSessionHost<DocumentOpened>;
  const session = new DocumentSession(host, { createJournalScope: () => "scope",
    updateWorkingCopy: async () => ({}), onJournalWarning: () => () => {},
  } as WorkingCopyJournalHost);
  session.adopt(opened);
  const presentation = new SessionPresentation(session, () => "Safe lifecycle failure.");
  const protectedState = { dirty: true, provisional: false, pendingPublication: false,
    recovered: false, conflict: false, unresolvedJournal: false,
    activePublication: false };
  assert.equal(session.stageProtection({ token: "first", operation: "exit",
    state: protectedState }), true);
  assert.deepEqual(presentation.view({ formActive: true }).selectedDecision, {
    kind: "lifecycle-protection", operation: "exit", state: protectedState,
    resolving: false, failureMessage: null,
  });
  await presentation.act("protection-save");
  assert.equal(presentation.view({ formActive: true }).selectedDecision?.kind,
    "lifecycle-protection");
  assert.equal(presentation.view().safeMessage, null);
  assert.equal(presentation.view().focusIntent, "decision-action");
  await presentation.act("protection-cancel");
  assert.equal(presentation.view({ formActive: true }).selectedDecision, null);
  assert.equal(presentation.view().safeMessage,
    "Action canceled; the current document remains open and usable.");
  assert.equal(presentation.view().focusIntent, "return");
  session.dispose();
});

test("successful protection clears the prior presentation after document replacement", async () => {
  const host = { saveDocument: async (content: string) => ({ saved: true, content,
    publicationState: "target-published" as const }),
  resolveProtection: async () => ({ completed: true, proceed: true }) } as
    unknown as DocumentSessionHost<DocumentOpened>;
  const session = new DocumentSession(host, { createJournalScope: () => "scope",
    updateWorkingCopy: async () => ({}), onJournalWarning: () => () => {},
  } as WorkingCopyJournalHost);
  session.adopt({ ...opened, readOnly: false });
  session.edit("prior working copy");
  const presentation = new SessionPresentation(session, () => "Safe failure.");
  await presentation.save();
  assert.equal(presentation.view().safeMessage, "Manual save published and verified.");
  session.stageProtection({ token: "replacement", operation: "exit", state: {
    dirty: true, provisional: false, pendingPublication: false, recovered: false,
    conflict: false, unresolvedJournal: false, activePublication: false,
  } });
  assert.equal(presentation.view({ formActive: true }).selectedDecision?.kind,
    "lifecycle-protection");
  assert.equal(presentation.view({ formActive: true }).safeMessage, null);
  await presentation.act("protection-discard");
  session.adopt({ ...opened, content: "replacement" });
  const next = presentation.view({ formActive: false });
  assert.equal(next.selectedDecision, null);
  assert.equal(next.safeMessage, null);
  assert.equal(next.focusIntent, null);
  session.dispose();
});

test("lock invalidates a pending protection result and clears presentation synchronously", async () => {
  let finish!: (result: { completed: true; proceed: false }) => void;
  const host = { resolveProtection: () => new Promise((resolve) => { finish = resolve; }) } as
    unknown as DocumentSessionHost<DocumentOpened>;
  const session = new DocumentSession(host, { createJournalScope: () => "scope",
    updateWorkingCopy: async () => ({}), onJournalWarning: () => () => {},
  } as WorkingCopyJournalHost);
  session.adopt(opened);
  const presentation = new SessionPresentation(session, () => "Safe failure.");
  session.stageProtection({ token: "first", operation: "exit", state: {
    dirty: true, provisional: false, pendingPublication: false, recovered: false,
    conflict: false, unresolvedJournal: false, activePublication: false,
  } });
  const pending = presentation.act("protection-cancel");
  presentation.lockStarted();
  session.lockStarted();
  assert.equal(presentation.view().selectedDecision, null);
  assert.equal(presentation.view().safeMessage, null);
  finish({ completed: true, proceed: false });
  await pending;
  assert.equal(presentation.view().focusIntent, null);
  session.dispose();
});

test("unmount rejects a late save message and focus intent", async () => {
  let finish!: (result: { saved: true; content: string;
    publicationState: "target-published" }) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const host = { saveDocument: () => new Promise((resolve) => {
    finish = resolve; started();
  }) } as
    unknown as DocumentSessionHost<DocumentOpened>;
  const session = new DocumentSession(host, { createJournalScope: () => "scope",
    updateWorkingCopy: async () => ({}), onJournalWarning: () => () => {},
  } as WorkingCopyJournalHost);
  session.adopt({ ...opened, readOnly: false });
  session.edit("new working copy");
  const presentation = new SessionPresentation(session, () => "Safe failure.");
  const pending = presentation.save();
  await entered;
  presentation.dispose();
  finish({ saved: true, content: "new working copy",
    publicationState: "target-published" });
  await pending;
  assert.equal(presentation.view().safeMessage, null);
  assert.equal(presentation.view().focusIntent, null);
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

test("a staged invitation waits for the current form and stays actionable after it closes", () => {
  const { session, presentation } = setup();
  session.adopt({ readOnly: true, invitationRequired: true });
  const duringForm = presentation.view({ formActive: true });
  assert.equal(duringForm.selectedDecision, null);
  assert.equal(duringForm.blocked, false);
  const afterForm = presentation.view();
  assert.deepEqual(afterForm.selectedDecision, { kind: "invitation-claim" });
  assert.equal(afterForm.blocked, true);
  assert.equal(afterForm.focusIntent, "decision-action");
  session.dispose();
});

test("profile mismatch waits for the form and follows current document attention", () => {
  const { session, presentation } = setup();
  const profileMismatch = { editingBlocked: true as const, slotName: "Ada",
    slotEmail: "ada@example.test", profileName: "Bea",
    profileEmail: "bea@example.test" };
  session.adopt({ ...opened, profileMismatch,
    recovery: { content: "private", state: "unsaved", updateTime: 42,
      cursor: { start: 0, end: 0 } } });
  assert.equal(presentation.view({ formActive: true }).selectedDecision, null);
  assert.equal(presentation.view().selectedDecision?.kind, "recovery-decision");
  session.adopt({ ...opened, profileMismatch });
  assert.deepEqual(presentation.view().selectedDecision,
    { kind: "profile-mismatch" });
  assert.equal(presentation.view().blocked, true);
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

test("host-canceled compaction keeps the current decision available for retry", async () => {
  let attempts = 0;
  const host = { compactDocument: async () => {
    attempts += 1;
    return attempts === 1 ? null : { opened: { ...opened, readOnly: false,
      canAddPasswords: true, canRemovePasswords: true }, previousHead: "old", head: "new" };
  } } as unknown as DocumentSessionHost<DocumentOpened>;
  const session = new DocumentSession(host, { createJournalScope: () => "scope",
    updateWorkingCopy: async () => ({}), onJournalWarning: () => () => {},
  } as WorkingCopyJournalHost);
  session.adopt({ ...opened, readOnly: false, canAddPasswords: true,
    canRemovePasswords: true });
  const presentation = new SessionPresentation(session, () => "safe failure");
  session.requestCompaction();
  assert.equal(await presentation.act("compact"), undefined);
  assert.deepEqual(presentation.view().selectedDecision, {
    kind: "compaction-decision", failureMessage: null,
  });
  assert.equal(presentation.view().safeMessage,
    "Compaction canceled; document history is unchanged.");
  assert.equal(await presentation.act("compact"), "passwords");
  assert.equal(attempts, 2);
  assert.equal(presentation.view().selectedDecision, null);
  session.dispose();
});

test("confirmed lease enters edit mode through one-shot session authority", async () => {
  const used: string[] = [];
  const host = { enterEditMode: async ({ authorization }: { authorization?: string } = {}) => {
    if (!authorization) return { decisionRequired: "lease-takeover" as const,
      operation: "edit" as const, holderName: "Ada", authorization: "private authorization" };
    used.push(authorization);
    return { ...opened, readOnly: false };
  } } as unknown as DocumentSessionHost<DocumentOpened>;
  const session = new DocumentSession(host, { createJournalScope: () => "scope",
    updateWorkingCopy: async () => ({}), onJournalWarning: () => () => {},
  } as WorkingCopyJournalHost);
  session.adopt(opened);
  const presentation = new SessionPresentation(session, () => "safe failure");
  await session.enterEditMode();
  await presentation.act("confirm-lease");
  assert.deepEqual(used, ["private authorization"]);
  assert.equal(session.getSnapshot().kind, "edit");
  assert.equal(presentation.view().selectedDecision, null);
  assert.equal(presentation.view().safeMessage,
    "Edit mode entered after confirmed lease takeover.");
  assert.equal(presentation.view().focusIntent, "return");
  session.dispose();
});

test("migration and compaction success return to the current document presentation", async () => {
  const migrationHost = { migrateDocument: async () => ({
    opened: { ...opened, migrationRequired: undefined }, compatibilityCode: "MIGRATED",
  }) } as unknown as DocumentSessionHost<DocumentOpened>;
  const journal = { createJournalScope: () => "scope", updateWorkingCopy: async () => ({}),
    onJournalWarning: () => () => {},
  } as WorkingCopyJournalHost;
  const migrationSession = new DocumentSession(migrationHost, journal);
  migrationSession.adopt({ ...opened, migrationRequired: true, migrationCanEdit: true });
  const migration = new SessionPresentation(migrationSession, (code) =>
    code === "MIGRATED" ? "Migration complete." : "safe failure");
  assert.equal(await migration.act("migrate"), undefined);
  assert.equal(migration.view().selectedDecision, null);
  assert.equal(migration.view().safeMessage, "Migration complete.");
  assert.equal(migrationSession.getSnapshot().kind, "read-only");
  migrationSession.dispose();

  const compactHost = { compactDocument: async ({ confirmed }: { confirmed: true }) => {
    assert.equal(confirmed, true);
    return { opened: { ...opened, readOnly: false, canAddPasswords: true,
      canRemovePasswords: true }, previousHead: "old", head: "new" };
  } } as unknown as DocumentSessionHost<DocumentOpened>;
  const compactSession = new DocumentSession(compactHost, journal);
  compactSession.adopt({ ...opened, readOnly: false, canAddPasswords: true,
    canRemovePasswords: true });
  const compact = new SessionPresentation(compactSession, () => "safe failure");
  assert.equal(compactSession.requestCompaction().status, "attention");
  assert.equal(await compact.act("compact"), "passwords");
  assert.equal(compact.view().selectedDecision, null);
  assert.equal(compact.view().safeMessage,
    "Verified backup created and document history compacted.");
  compactSession.dispose();
});

test("a lock during compaction cancellation cannot reopen the password form", async () => {
  const host = { compactDocument: async () => null } as
    unknown as DocumentSessionHost<DocumentOpened>;
  const session = new DocumentSession(host, { createJournalScope: () => "scope",
    updateWorkingCopy: async () => ({}), onJournalWarning: () => () => {},
  } as WorkingCopyJournalHost);
  session.adopt({ ...opened, readOnly: false, canAddPasswords: true,
    canRemovePasswords: true });
  const presentation = new SessionPresentation(session, () => "safe failure");
  session.requestCompaction();
  const pending = presentation.act("compaction-canceled");
  session.lockStarted();
  assert.equal(await pending, undefined);
  assert.equal(presentation.view().selectedDecision, null);
  assert.equal(presentation.view().safeMessage, null);
  session.dispose();
});

test("manual save failure stays actionable and retry reports a published target", async () => {
  let attempt = 0;
  const host = { saveDocument: async (content: string) => {
    if (++attempt === 1) throw new Error("private target path");
    return { saved: true, content,
      publicationState: "target-published" as const };
  } } as unknown as DocumentSessionHost<DocumentOpened>;
  const session = new DocumentSession(host, { createJournalScope: () => "scope",
    updateWorkingCopy: async () => ({}), onJournalWarning: () => () => {},
  } as WorkingCopyJournalHost);
  session.adopt({ ...opened, readOnly: false });
  session.edit("new work");
  const presentation = new SessionPresentation(session, () => "safe failure");
  await presentation.save();
  assert.deepEqual(presentation.view().selectedDecision, {
    kind: "save-failed", message: "safe failure",
  });
  assert.equal(presentation.view({ formActive: true }).selectedDecision, null);
  assert.equal(presentation.view().focusIntent, "save-retry");
  assert.equal(JSON.stringify(presentation.view()).includes("private target path"), false);
  await presentation.act("retry-save");
  assert.equal(presentation.view().selectedDecision, null);
  assert.equal(presentation.view().safeMessage, "Manual save published and verified.");
  session.dispose();
});

test("discarding a pending candidate reports the verified target outcome", async () => {
  const host = { discardPendingPublication: async () => ({ ...opened,
    content: "verified target" }) } as unknown as DocumentSessionHost<DocumentOpened>;
  const session = new DocumentSession(host, { createJournalScope: () => "scope",
    updateWorkingCopy: async () => ({}), onJournalWarning: () => () => {},
  } as WorkingCopyJournalHost);
  session.adopt({ ...opened, content: "local candidate",
    publicationState: "pending-publication" });
  const presentation = new SessionPresentation(session, () => "safe failure");
  await presentation.act("discard-publication");
  assert.equal(presentation.view().selectedDecision, null);
  assert.equal(presentation.view().safeMessage,
    "Pending manual save explicitly discarded.");
  assert.equal(presentation.view().focusIntent, "return");
  const snapshot = session.getSnapshot();
  if (snapshot.kind !== "read-only") throw new Error("expected target");
  assert.equal(snapshot.working.text, "verified target");
  session.dispose();
});

test("pending publication distinguishes unavailable, conflict, and published outcomes", async () => {
  for (const state of ["pending-publication", "conflict", "target-published"] as const) {
    const host = { reconnectPendingPublication: async () => ({ content: "candidate",
      publicationState: state }) } as unknown as DocumentSessionHost<DocumentOpened>;
    const session = new DocumentSession(host, { createJournalScope: () => "scope",
      updateWorkingCopy: async () => ({}), onJournalWarning: () => () => {},
    } as WorkingCopyJournalHost);
    session.adopt({ ...opened, publicationState: "pending-publication" });
    const presentation = new SessionPresentation(session, () => "safe failure");
    assert.deepEqual(presentation.view().selectedDecision, {
      kind: "publication-decision", state: "pending-publication", failureMessage: null,
    });
    await presentation.act("reconnect-publication");
    assert.equal(presentation.view().safeMessage, state === "pending-publication"
      ? "The target is still unavailable; publication remains pending."
      : state === "conflict"
        ? "The target changed; divergence must be resolved without overwriting it."
        : "Pending manual save published and verified.");
    assert.equal(presentation.view().selectedDecision?.kind,
      state === "target-published" ? undefined : "publication-decision");
    session.dispose();
  }
});

test("discard failure keeps a locally saved candidate and retry focus", async () => {
  const host = { discardPendingPublication: async () => {
    throw new Error("private candidate contents");
  } } as unknown as DocumentSessionHost<DocumentOpened>;
  const session = new DocumentSession(host, { createJournalScope: () => "scope",
    updateWorkingCopy: async () => ({}), onJournalWarning: () => () => {},
  } as WorkingCopyJournalHost);
  session.adopt({ ...opened, publicationState: "pending-publication" });
  const presentation = new SessionPresentation(session, () => "safe failure");
  await presentation.act("discard-publication");
  assert.deepEqual(presentation.view().selectedDecision, {
    kind: "publication-decision", state: "pending-publication",
    failureMessage: "safe failure",
  });
  assert.equal(presentation.view().safeMessage,
    "Publication discard needs attention: safe failure");
  assert.equal(presentation.view().focusIntent, "decision-action");
  assert.equal(JSON.stringify(presentation.view()).includes("private"), false);
  session.dispose();
});

test("conflict with newer edits requires keep, export, or explicit discard before a merge draft", async () => {
  let finishSave!: (result: { saved: true; content: string;
    publicationState: "conflict" }) => void;
  let acquisitions = 0;
  const host = { saveDocument: () => new Promise((resolve) => { finishSave = resolve; }),
    beginDivergenceResolution: async () => {
      acquisitions += 1;
      return { content: "merge draft", hasConflicts: true, ancestorRevision: "a",
        localRevision: "l", currentRevision: "c" };
    } } as unknown as DocumentSessionHost<DocumentOpened>;
  const session = new DocumentSession(host, { createJournalScope: () => "scope",
    updateWorkingCopy: async () => ({}), onJournalWarning: () => () => {},
  } as WorkingCopyJournalHost);
  session.adopt({ ...opened, readOnly: false });
  session.edit("saved candidate");
  const saving = session.save();
  await Promise.resolve();
  session.edit("newer private edit");
  finishSave({ saved: true, content: "saved candidate", publicationState: "conflict" });
  await saving;
  const presentation = new SessionPresentation(session, () => "safe failure");
  await presentation.act("reconnect-publication");
  assert.deepEqual(presentation.view().selectedDecision,
    { kind: "newer-edits-confirmation" });
  assert.equal(acquisitions, 0);
  await presentation.act("keep-newer-edits");
  assert.equal(presentation.view().selectedDecision?.kind, "publication-decision");
  await presentation.act("reconnect-publication");
  assert.equal(await presentation.act("export-newer-edits"), "export");
  await presentation.act("reconnect-publication");
  await presentation.act("discard-newer-edits");
  assert.equal(acquisitions, 1);
  assert.equal(presentation.view().safeMessage,
    "Resolve every local/current marker, then save the merge.");
  assert.equal(presentation.view().selectedDecision, null);
  assert.equal(JSON.stringify(presentation.view()).includes("newer private edit"), false);
  session.dispose();
});

test("late publication result cannot present a message or focus in another document", async () => {
  let finish!: (result: { content: string; publicationState: "target-published" }) => void;
  const host = { reconnectPendingPublication: () => new Promise((resolve) => {
    finish = resolve;
  }) } as unknown as DocumentSessionHost<DocumentOpened>;
  const session = new DocumentSession(host, { createJournalScope: () => "scope",
    updateWorkingCopy: async () => ({}), onJournalWarning: () => () => {},
  } as WorkingCopyJournalHost);
  session.adopt({ ...opened, publicationState: "pending-publication" });
  const presentation = new SessionPresentation(session, () => "safe failure");
  const retry = presentation.act("reconnect-publication");
  await Promise.resolve();
  session.adopt({ ...opened, content: "new document" });
  finish({ content: "candidate", publicationState: "target-published" });
  await retry;
  assert.equal(presentation.view().safeMessage, null);
  assert.equal(presentation.view().focusIntent, null);
  session.dispose();
});
