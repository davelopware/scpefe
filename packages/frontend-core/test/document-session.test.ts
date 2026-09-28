import assert from "node:assert/strict";
import test from "node:test";
import { DocumentSession, type DocumentSessionHost,
  type SessionInvitation, type WorkingCopyJournalHost,
  type WorkingCopyUpdate } from "../src/index.ts";

interface OpenedDocument {
  content: string;
  readOnly: boolean;
  publicationState: "target-published" | "pending-publication" | "conflict";
  targetName: string;
  canEdit: boolean;
  provisional?: true;
  recovery?: { content: string; state: "unsaved"; updateTime: number;
    cursor: { start: number; end: number }; authorName?: string; deviceName?: string };
  headMismatch?: { kind: "rollback" | "divergence" | "replacement" | "witness-error";
    title: string; explanation: string; editingBlocked: true };
  unreadableJournal?: true;
}

const opened = (content = "private text", readOnly = true): OpenedDocument => ({
  content, readOnly, publicationState: "target-published", targetName: "notes.scpefe",
  canEdit: true,
});

class Journal implements WorkingCopyJournalHost {
  private scope = 0;
  readonly updates: WorkingCopyUpdate[] = [];
  createJournalScope(): string { return `scope-${++this.scope}`; }
  updateWorkingCopy(update: WorkingCopyUpdate): Promise<unknown> {
    this.updates.push(update);
    return Promise.resolve({ checkpointScheduled: true });
  }
  onJournalWarning(_listener: (code: string, scope: string | null) => void): () => void {
    return () => {};
  }
}

test("session owns synchronous editing, search, history, and journal projection", () => {
  const journal = new Journal();
  const session = new DocumentSession(new Host(), journal);
  const current = () => {
    const snapshot = session.getSnapshot();
    assert.ok(snapshot.kind === "edit" || snapshot.kind === "read-only");
    return snapshot;
  };
  session.adopt(opened("first line\nsecond line", false));
  assert.equal(session.getSnapshot().kind, "edit");
  assert.equal(current().working.text, "first line\nsecond line");
  assert.equal(current().commands.write, true);
  assert.equal(session.edit("first row\nsecond line", { start: 9, end: 9 }), true);
  assert.equal(current().working.dirty, true);
  assert.equal(current().working.canUndo, true);
  assert.equal(journal.updates.at(-1)?.content, "first row\nsecond line");
  assert.equal(session.undo(), true);
  assert.equal(current().working.text, "first line\nsecond line");
  assert.equal(session.redo(), true);
  assert.equal(current().working.text, "first row\nsecond line");
  assert.equal(session.setSelection({ start: 0, end: 0 }), true);
  assert.deepEqual(session.findNext("second"), {
    status: "selected", wrapped: false, selection: { start: 10, end: 16 },
  });
  assert.deepEqual(session.replaceSelection("second", "third"), { status: "replaced" });
  assert.equal(current().working.text, "first row\nthird line");
  session.lockStarted();
  assert.equal("working" in session.getSnapshot(), false);
  assert.equal(session.edit("late plaintext"), false);
  session.dispose();
});

test("session projects in-flight journal work and a safe failure before lock clears it", async () => {
  const journal = new Journal();
  let rejectUpdate!: (reason: Error) => void;
  journal.updateWorkingCopy = () => new Promise((_resolve, reject) => {
    rejectUpdate = reject;
  });
  const session = new DocumentSession(new Host(), journal);
  session.adopt(opened("original", false));
  assert.equal(session.edit("changed"), true);
  const pending = session.getSnapshot();
  if (pending.kind !== "edit") throw new Error("expected edit session");
  assert.deepEqual(pending.working.journal, { pending: 1, failed: false });
  rejectUpdate(new Error("private journal path"));
  await Promise.resolve();
  await Promise.resolve();
  const failed = session.getSnapshot();
  if (failed.kind !== "edit") throw new Error("expected edit session");
  assert.deepEqual(failed.working.journal, { pending: 0, failed: true });
  assert.equal(JSON.stringify(failed).includes("private journal path"), false);
  session.lockStarted();
  assert.equal("working" in session.getSnapshot(), false);
  session.dispose();
});

class Host implements DocumentSessionHost<OpenedDocument> {
  openResult: OpenedDocument | SessionInvitation = opened();
  editResult: OpenedDocument | { decisionRequired: "lease-takeover";
    operation: "edit"; holderName: string; authorization: string } = opened("private text", false);
  editRequests: Array<{ authorization?: string }> = [];
  saveRequests: string[] = [];
  async openSelectedDocument(_password: string): Promise<OpenedDocument | SessionInvitation> {
    return this.openResult;
  }
  async unlockDocument(_password: string): Promise<OpenedDocument | SessionInvitation> {
    return this.openResult;
  }
  async lock(): Promise<{ locked: true; journalSaved: boolean; warningCode: string | null }> {
    return { locked: true, journalSaved: true, warningCode: null };
  }
  async closeDocument(): Promise<boolean> { return true; }
  async enterEditMode(request: { authorization?: string } = {}): Promise<OpenedDocument
    | { decisionRequired: "lease-takeover"; operation: "edit";
      holderName: string; authorization: string }> {
    this.editRequests.push(request);
    return this.editResult;
  }
  async cancelLeaseTakeover(_authorization: string): Promise<boolean> { return true; }
  async restoreRecoveredWork(_request: { authorization?: string } = {}): Promise<OpenedDocument & {
    recoveredUnsaved: true; cursor: { start: number; end: number } } | {
      decisionRequired: "lease-takeover"; operation: "recovery";
      holderName: string; authorization: string }> {
    return { ...opened(), recoveredUnsaved: true, cursor: { start: 0, end: 0 } };
  }
  async beginDivergenceResolution(_request?: { authorization?: string }): Promise<{
    content: string; hasConflicts: boolean; ancestorRevision: string;
    localRevision: string; currentRevision: string }> {
    return { content: "merge", hasConflicts: false, ancestorRevision: "a",
      localRevision: "l", currentRevision: "c" };
  }
  async migrateDocument(_request: { authorization: string }): Promise<{
    opened: OpenedDocument; compatibilityCode: string }> {
    return { opened: opened(), compatibilityCode: "MIGRATED" };
  }
  async saveDocument(content: string): Promise<{ saved: true; content: string;
    publicationState: "target-published" | "pending-publication" | "conflict" }> {
    this.saveRequests.push(content);
    return { saved: true, content, publicationState: "target-published" };
  }
  async saveDivergenceResolution(content: string): Promise<{ saved: true; content: string;
    publicationState: "target-published" | "pending-publication" | "conflict" }> {
    return this.saveDocument(content);
  }
  async reconnectPendingPublication(): Promise<{ content: string;
    publicationState: "target-published" | "pending-publication" | "conflict" }> {
    return { content: "private text", publicationState: "target-published" };
  }
  async discardPendingPublication(): Promise<OpenedDocument> { return opened(); }
  async discardRecoveredWork(): Promise<OpenedDocument> { return opened(); }
  async acceptHeadMismatch(): Promise<OpenedDocument> { return opened(); }
  async discardUnreadableJournal(): Promise<OpenedDocument> { return opened(); }
  async backupDocument(): Promise<{ backedUp: true } | null> {
    return { backedUp: true };
  }
  async exportPlaintext(_request: { content: string; lineEndings: "lf" | "native" }):
    Promise<{ exported: true } | null> { return { exported: true }; }
}

test("recovery attention carries safe context and restore adopts unsaved work atomically", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  const recovered = { content: "protected recovered words", state: "unsaved" as const,
    updateTime: 1720000000000, cursor: { start: 4, end: 4 },
    authorName: "Ada", deviceName: "Desk" };
  session.adopt({ ...opened("verified target"), recovery: recovered });
  let snapshot = session.getSnapshot();
  if (snapshot.kind !== "read-only") throw new Error("expected read-only");
  assert.deepEqual(snapshot.attention, { kind: "recovery-decision",
    updateTime: 1720000000000, authorName: "Ada", deviceName: "Desk",
    canRestore: true });
  assert.equal(snapshot.commands.recoveryRestore, true);
  assert.equal(snapshot.commands.recoveryDiscard, true);
  assert.equal(snapshot.commands.enterEdit, false);
  assert.equal(JSON.stringify(snapshot.attention).includes(recovered.content), false);
  host.restoreRecoveredWork = async () => ({ ...opened(recovered.content, false),
    recoveredUnsaved: true, cursor: recovered.cursor });
  const seen: string[] = [];
  session.subscribe(() => {
    const current = session.getSnapshot();
    if (current.kind === "read-only" || current.kind === "edit") {
      seen.push(`${current.kind}:${current.working.text}:${current.attention?.kind ?? "none"}`);
    }
  });
  assert.deepEqual(await session.restoreRecovery(), { status: "recovery" });
  snapshot = session.getSnapshot();
  if (snapshot.kind !== "edit") throw new Error("expected edit");
  assert.equal(snapshot.working.text, recovered.content);
  assert.equal(snapshot.working.baseline, "invalid");
  assert.equal(snapshot.working.dirty, true);
  assert.equal(snapshot.document.targetName, "notes.scpefe");
  assert.equal(snapshot.attention, undefined);
  assert.equal(seen.some((value) => value.includes("read-only:protected recovered")), false,
    "subscribers cannot see recovery text under old read-only authority");
  assert.equal(JSON.stringify(await session.restoreRecovery()).includes(recovered.content), false);
  session.dispose();
});

test("head mismatch acceptance is serialized, safe, and invalidated by lock", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt({ ...opened("verified target"), headMismatch: {
    kind: "rollback", title: "host heading", explanation: "private path" } });
  const current = session.getSnapshot();
  if (current.kind !== "read-only") throw new Error("expected read-only");
  assert.deepEqual(current.attention, { kind: "head-mismatch", mismatchKind: "rollback" });
  assert.equal(current.commands.acceptHeadMismatch, true);
  assert.equal(JSON.stringify(current.attention).includes("private path"), false);
  let resolve!: (document: OpenedDocument) => void;
  host.acceptHeadMismatch = () => new Promise((done) => { resolve = done; });
  const accepting = session.acceptHeadMismatch();
  await Promise.resolve();
  assert.equal(session.getSnapshot().pending, "head-accept");
  session.lockStarted();
  resolve(opened("late document"));
  assert.deepEqual(await accepting, { status: "superseded" });
  assert.equal(session.getSnapshot().kind, "locked");
  session.dispose();
});

test("head and recovery evidence reveal one actionable decision at a time", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  const recovery = { content: "protected recovery", state: "unsaved" as const,
    updateTime: 1, cursor: { start: 0, end: 0 } };
  session.adopt({ ...opened("target"), recovery, headMismatch: {
    kind: "rollback", title: "host title", explanation: "host prose",
    editingBlocked: true } });
  let snapshot = session.getSnapshot();
  if (snapshot.kind !== "read-only") throw new Error("expected read-only");
  assert.equal(snapshot.attention?.kind, "head-mismatch");
  assert.equal(snapshot.commands.acceptHeadMismatch, true);
  assert.equal(snapshot.commands.recoveryRestore, false);
  assert.equal(snapshot.commands.recoveryDiscard, false);
  host.acceptHeadMismatch = async () => ({ ...opened("target"), recovery });
  assert.deepEqual(await session.acceptHeadMismatch(), { status: "head-accepted" });
  snapshot = session.getSnapshot();
  if (snapshot.kind !== "read-only") throw new Error("expected read-only");
  assert.equal(snapshot.attention?.kind, "recovery-decision");
  assert.equal(snapshot.commands.recoveryDiscard, true);
  session.dispose();
});

test("discarding recovery invalidates an outstanding one-shot lease challenge", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt({ ...opened("target"), recovery: { content: "protected",
    state: "unsaved", updateTime: 1, cursor: { start: 0, end: 0 } } });
  const snapshot = session.getSnapshot();
  if (snapshot.kind !== "read-only") throw new Error("expected read-only");
  assert.equal(session.stageLeaseDecision({ decisionRequired: "lease-takeover",
    operation: "recovery", holderName: "Remote", authorization: "old token" },
  snapshot.adoption), true);
  assert.deepEqual(await session.discardRecovery(), { status: "recovery-discarded" });
  assert.deepEqual(await session.confirmLeaseTakeover(), { status: "unavailable" });
  assert.equal(JSON.stringify(session.getSnapshot()).includes("old token"), false);
  session.dispose();
});

test("queued confirmation cannot replay a lease after recovery is discarded", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt({ ...opened("target"), recovery: { content: "protected",
    state: "unsaved", updateTime: 1, cursor: { start: 0, end: 0 } } });
  const snapshot = session.getSnapshot();
  if (snapshot.kind !== "read-only") throw new Error("expected read-only");
  session.stageLeaseDecision({ decisionRequired: "lease-takeover",
    operation: "recovery", holderName: "Remote", authorization: "old token" },
  snapshot.adoption);
  let finish!: (document: OpenedDocument) => void;
  let started!: () => void;
  const begun = new Promise<void>((resolve) => { started = resolve; });
  host.discardRecoveredWork = () => new Promise((resolve) => {
    finish = resolve; started();
  });
  const discarding = session.discardRecovery();
  await begun;
  const confirming = session.confirmLeaseTakeover();
  finish(opened("target"));
  assert.deepEqual(await discarding, { status: "recovery-discarded" });
  assert.deepEqual(await confirming, { status: "superseded" });
  session.dispose();
});

test("unreadable journal requires explicit discard and keeps protected state on failure", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt({ ...opened("verified target"), unreadableJournal: true });
  let current = session.getSnapshot();
  if (current.kind !== "read-only") throw new Error("expected read-only");
  assert.deepEqual(current.attention, { kind: "unreadable-journal" });
  assert.equal(current.commands.enterEdit, false);
  assert.equal(current.commands.unreadableDiscard, true);
  host.discardUnreadableJournal = async () => { throw new Error("private journal path"); };
  assert.deepEqual(await session.discardUnreadableJournal(),
    { status: "failed", code: "OPERATION_FAILED" });
  current = session.getSnapshot();
  if (current.kind !== "read-only") throw new Error("expected read-only");
  assert.equal(current.working.text, "verified target");
  assert.deepEqual(current.attention, { kind: "unreadable-journal",
    failureCode: "OPERATION_FAILED" });
  host.discardUnreadableJournal = async () => opened("verified target");
  assert.deepEqual(await session.discardUnreadableJournal(),
    { status: "unreadable-discarded" });
  current = session.getSnapshot();
  if (current.kind !== "read-only") throw new Error("expected read-only");
  assert.equal(current.attention, undefined);
  assert.equal(current.commands.enterEdit, true);
  session.dispose();
});

test("recovery discovery is safe semantic attention across locked and open states", () => {
  const session = new DocumentSession(new Host(), new Journal());
  session.observeRecoveryDiscovery({ total: 3, pendingPublications: 1 });
  let snapshot = session.getSnapshot();
  assert.deepEqual(snapshot.attention, { kind: "recovery-discovery",
    total: 3, pendingPublications: 1 });
  session.adopt(opened());
  snapshot = session.getSnapshot();
  assert.deepEqual(snapshot.attention, { kind: "recovery-discovery",
    total: 3, pendingPublications: 1 });
  session.lockStarted();
  snapshot = session.getSnapshot();
  assert.deepEqual(snapshot.attention, { kind: "recovery-discovery",
    total: 3, pendingPublications: 1 });
  session.observeRecoveryDiscovery({ total: 0, pendingPublications: 0 });
  assert.equal(session.getSnapshot().attention, undefined);
  session.dispose();
});

test("late recovery and merge completions cannot reintroduce protected text after lock", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt({ ...opened("verified"), recovery: { content: "secret recovery",
    state: "unsaved", updateTime: 1, cursor: { start: 0, end: 0 } } });
  let resolveRecovery!: (document: OpenedDocument & { recoveredUnsaved: true;
    cursor: { start: number; end: number } }) => void;
  let started!: () => void;
  host.restoreRecoveredWork = () => new Promise((resolve) => {
    resolveRecovery = resolve; started();
  });
  let begun = new Promise<void>((resolve) => { started = resolve; });
  const restoring = session.restoreRecovery();
  await begun;
  session.lockStarted();
  resolveRecovery({ ...opened("secret recovery", false), recoveredUnsaved: true,
    cursor: { start: 0, end: 0 } });
  assert.deepEqual(await restoring, { status: "superseded" });
  assert.equal(JSON.stringify(session.getSnapshot()).includes("secret recovery"), false);

  session.adopt({ ...opened("saved candidate"), publicationState: "conflict" });
  let resolveMerge!: (draft: { content: string; hasConflicts: boolean;
    ancestorRevision: string; localRevision: string; currentRevision: string }) => void;
  host.beginDivergenceResolution = () => new Promise((resolve) => {
    resolveMerge = resolve; started();
  });
  begun = new Promise<void>((resolve) => { started = resolve; });
  const merging = session.beginDivergenceResolution();
  await begun;
  session.lockStarted();
  resolveMerge({ content: "secret merge", hasConflicts: true,
    ancestorRevision: "a", localRevision: "b", currentRevision: "c" });
  assert.deepEqual(await merging, { status: "superseded" });
  assert.equal(JSON.stringify(session.getSnapshot()).includes("secret merge"), false);
  session.dispose();
});

test("manual save publishes active then sealed state through the session interface", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt(opened("base", false));
  session.edit("draft");
  let finish!: (result: { saved: true; content: string;
    publicationState: "target-published" }) => void;
  host.saveDocument = (content) => {
    host.saveRequests.push(content);
    return new Promise((resolve) => { finish = resolve; });
  };
  const saving = session.save();
  await Promise.resolve();
  const active = session.getSnapshot();
  if (active.kind !== "edit") throw new Error("expected edit session");
  assert.equal(active.publication.state, "target-published");
  assert.equal(active.pending, "save");
  assert.equal(active.commands.save, false);
  assert.equal(active.working.dirty, true);
  assert.deepEqual(host.saveRequests, ["draft"]);
  finish({ saved: true, content: "draft", publicationState: "target-published" });
  assert.deepEqual(await saving, { status: "saved", publicationState: "target-published" });
  const sealed = session.getSnapshot();
  if (sealed.kind !== "edit") throw new Error("expected edit session");
  assert.equal(sealed.pending, undefined);
  assert.equal(sealed.publication.state, "target-published");
  assert.equal(sealed.working.baseline, "valid");
  assert.equal(sealed.working.dirty, false);
  assert.equal(sealed.commands.backup, true);
  session.dispose();
});

test("a save acknowledgement cannot replace edits made while the host was busy", async () => {
  const host = new Host();
  const journal = new Journal();
  const session = new DocumentSession(host, journal);
  session.adopt(opened("base", false));
  session.edit("first draft");
  const submitted = journal.updates.at(-1)!;
  let finish!: (result: { saved: true; content: string;
    publicationState: "target-published" }) => void;
  host.saveDocument = () => new Promise((resolve) => { finish = resolve; });
  const saving = session.save();
  await Promise.resolve();
  assert.equal(session.edit("newer draft"), true,
    "local editing remains synchronous during host publication");
  finish({ saved: true, content: "first draft", publicationState: "target-published" });
  assert.deepEqual(await saving, { status: "saved", publicationState: "target-published" });
  const snapshot = session.getSnapshot();
  if (snapshot.kind !== "edit") throw new Error("expected edit session");
  assert.equal(snapshot.document.content, "first draft");
  assert.equal(snapshot.working.text, "newer draft");
  assert.equal(snapshot.working.dirty, true);
  assert.equal(snapshot.commands.save, true);
  assert.equal(session.regularSavePublished({ published: true, provisional: true,
    content: "first draft", journalScope: submitted.journalScope,
    revision: submitted.revision }), false,
  "a late notice for the sealed revision cannot demote the manual save");
  const newer = journal.updates.at(-1)!;
  assert.equal(session.regularSavePublished({ published: true, provisional: true,
    content: "newer draft", journalScope: newer.journalScope,
    revision: newer.revision }), true,
  "a later regular publication remains honestly provisional");
  session.dispose();
});

test("pending manual save becomes semantic attention with retry and discard commands", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt(opened("base", false));
  session.edit("locally sealed");
  host.saveDocument = async (content) => ({ saved: true, content,
    publicationState: "pending-publication" });
  assert.deepEqual(await session.save(),
    { status: "saved", publicationState: "pending-publication" });
  const pending = session.getSnapshot();
  if (pending.kind !== "read-only") throw new Error("expected read-only");
  assert.equal(pending.publication.state, "pending-publication");
  assert.equal(pending.working.dirty, false);
  assert.deepEqual(pending.attention,
    { kind: "publication-decision", state: "pending-publication" });
  assert.equal(pending.commands.save, false);
  assert.equal(pending.commands.backup, false);
  assert.equal(pending.commands.publicationRetry, true);
  assert.equal(pending.commands.publicationDiscard, true);
  host.reconnectPendingPublication = async () => ({ content: "locally sealed",
    publicationState: "target-published" });
  assert.deepEqual(await session.retryPublication(),
    { status: "publication", publicationState: "target-published" });
  const published = session.getSnapshot();
  if (published.kind !== "read-only") throw new Error("expected read-only");
  assert.equal(published.attention, undefined);
  assert.equal(published.publication.state, "target-published");
  assert.equal(published.commands.backup, true);
  session.dispose();
});

test("backup and plaintext export preserve eligibility, cancellation, and current text", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  const exported: Array<{ content: string; lineEndings: "lf" | "native" }> = [];
  let backupCalls = 0;
  host.backupDocument = async () => { backupCalls += 1; return null; };
  host.exportPlaintext = async (request) => {
    exported.push(request);
    return null;
  };
  session.adopt(opened("sealed", false));
  assert.deepEqual(await session.backup(), { status: "backup", created: false });
  assert.equal(backupCalls, 1);
  session.edit("unsaved text");
  assert.deepEqual(await session.backup(), { status: "unavailable" });
  assert.equal(backupCalls, 1);
  assert.deepEqual(await session.exportPlaintext("native"),
    { status: "export", exported: false });
  assert.deepEqual(exported, [{ content: "unsaved text", lineEndings: "native" }]);
  host.exportPlaintext = async () => { throw new Error("private target path"); };
  assert.deepEqual(await session.exportPlaintext("lf"),
    { status: "failed", code: "OPERATION_FAILED" });
  assert.equal(JSON.stringify(session.getSnapshot()).includes("private target path"), false);
  session.lockStarted();
  assert.deepEqual(await session.exportPlaintext("lf"), { status: "unavailable" });
  session.dispose();
});

test("regular publication stays provisional and cannot overwrite a newer local edit", () => {
  const journal = new Journal();
  const session = new DocumentSession(new Host(), journal);
  session.adopt(opened("base", false));
  session.edit("first draft");
  const first = journal.updates.at(-1)!;
  session.edit("newer draft");
  assert.equal(session.regularSavePublished({ published: true, provisional: true,
    content: "first draft", journalScope: first.journalScope,
    revision: first.revision }), true);
  const snapshot = session.getSnapshot();
  if (snapshot.kind !== "edit") throw new Error("expected edit session");
  assert.equal(snapshot.publication.state, "provisional");
  assert.equal(snapshot.document.content, "first draft");
  assert.equal(snapshot.working.text, "newer draft");
  assert.equal(snapshot.working.baseline, "invalid");
  assert.equal(snapshot.working.dirty, true);
  assert.equal(snapshot.commands.backup, false);
  session.lockStarted();
  assert.equal(session.regularSavePublished({ published: true, provisional: true,
    content: "late old document", journalScope: first.journalScope,
    revision: first.revision }), false);
  session.dispose();
});

test("regular notices require the originating adoption and reject older save revisions", async () => {
  const journal = new Journal();
  const session = new DocumentSession(new Host(), journal);
  session.adopt(opened("A", false));
  session.edit("A draft");
  const old = journal.updates.at(-1)!;
  session.adopt(opened("B", false));
  session.edit("B draft");
  assert.equal(session.regularSavePublished({ published: true, provisional: true,
    content: "A draft", journalScope: old.journalScope, revision: old.revision }), false);
  let snapshot = session.getSnapshot();
  if (snapshot.kind !== "edit") throw new Error("expected edit session");
  assert.equal(snapshot.working.text, "B draft");
  assert.equal(snapshot.document.content, "B");
  assert.equal(snapshot.publication.state, "target-published");

  const savedRevision = journal.updates.at(-1)!;
  assert.deepEqual(await session.save(),
    { status: "saved", publicationState: "target-published" });
  session.edit("B after save");
  assert.equal(session.regularSavePublished({ published: true, provisional: true,
    content: "B draft", journalScope: savedRevision.journalScope,
    revision: savedRevision.revision }), false);
  snapshot = session.getSnapshot();
  if (snapshot.kind !== "edit") throw new Error("expected edit session");
  assert.equal(snapshot.working.text, "B after save");
  assert.equal(snapshot.publication.state, "target-published");
  session.dispose();
});

test("a delayed valid regular notice remains provisional after undo to clean", () => {
  const journal = new Journal();
  const session = new DocumentSession(new Host(), journal);
  session.adopt(opened("base", false));
  session.edit("draft");
  const source = journal.updates.at(-1)!;
  assert.equal(session.undo(), true);
  const before = session.getSnapshot();
  if (before.kind !== "edit") throw new Error("expected edit session");
  assert.equal(before.working.dirty, false);
  assert.equal(session.regularSavePublished({ published: true, provisional: true,
    content: "draft", journalScope: source.journalScope,
    revision: source.revision }), true);
  const after = session.getSnapshot();
  if (after.kind !== "edit") throw new Error("expected edit session");
  assert.equal(after.publication.state, "provisional");
  assert.equal(after.working.text, "base");
  assert.equal(after.working.dirty, true);
  assert.equal(after.document.content, "draft");
  session.dispose();
});

test("adopted dirty work gets host correlation before its first new edit", () => {
  const journal = new Journal();
  const session = new DocumentSession(new Host(), journal);
  session.adopt({ ...opened("provisional target"), provisional: true });
  assert.equal(journal.updates.length, 0, "read-only open cannot send an edit update");
  session.refreshDocument({ ...opened("provisional target", false), provisional: true });
  const provisionalSource = journal.updates.at(-1)!;
  assert.equal(provisionalSource.content, "provisional target");
  assert.equal(provisionalSource.revision, 1);
  session.adoptRecovery("recovered draft", { start: 4, end: 4 });
  const recoveredSource = journal.updates.at(-1)!;
  assert.equal(recoveredSource.content, "recovered draft");
  assert.equal(recoveredSource.revision, 1);
  assert.notEqual(recoveredSource.journalScope, provisionalSource.journalScope);
  session.dispose();
});

test("failed manual save retains dirty work and offers a safe retry", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt(opened("base", false));
  session.edit("draft");
  host.saveDocument = async () => { throw new Error("private target path"); };
  assert.deepEqual(await session.save(),
    { status: "failed", code: "OPERATION_FAILED" });
  const failed = session.getSnapshot();
  if (failed.kind !== "edit") throw new Error("expected edit session");
  assert.equal(failed.working.text, "draft");
  assert.equal(failed.working.dirty, true);
  assert.deepEqual(failed.attention,
    { kind: "save-failed", code: "OPERATION_FAILED" });
  assert.equal(JSON.stringify(failed).includes("private target path"), false);
  host.saveDocument = async (content) => ({ saved: true, content,
    publicationState: "target-published" });
  assert.equal((await session.save()).status, "saved");
  const succeeded = session.getSnapshot();
  if (succeeded.kind !== "edit") throw new Error("expected edit session");
  assert.equal(succeeded.attention, undefined);
  assert.equal(succeeded.working.dirty, false);
  session.dispose();
});

test("discard uses the host-returned target and late save cannot replace a new adoption", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt({ ...opened("candidate", true), publicationState: "pending-publication" });
  host.discardPendingPublication = async () => opened("verified target");
  assert.deepEqual(await session.discardPublication(),
    { status: "publication-discarded" });
  const restored = session.getSnapshot();
  if (restored.kind !== "read-only") throw new Error("expected read-only");
  assert.equal(restored.working.text, "verified target");
  assert.equal(restored.publication.state, "target-published");
  session.adopt(opened("A", false));
  session.edit("A draft");
  let finish!: (result: { saved: true; content: string;
    publicationState: "target-published" }) => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  host.saveDocument = () => new Promise((resolve) => {
    finish = resolve;
    signalStarted();
  });
  const saving = session.save();
  await started;
  session.lockStarted();
  session.adopt(opened("B"));
  finish({ saved: true, content: "A draft", publicationState: "target-published" });
  assert.deepEqual(await saving, { status: "superseded" });
  const replacement = session.getSnapshot();
  if (replacement.kind !== "read-only") throw new Error("expected read-only");
  assert.equal(replacement.working.text, "B");
  assert.equal(replacement.publication.state, "target-published");
  session.dispose();
});

test("serialized duplicate saves publish only one backend candidate", async () => {
  const host = new Host();
  const journal = new Journal();
  const session = new DocumentSession(host, journal);
  session.adopt(opened("base", false));
  session.edit("draft");
  const source = journal.updates.at(-1)!;
  let finish!: (result: { saved: true; content: string;
    publicationState: "target-published" }) => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  host.saveDocument = (content) => {
    host.saveRequests.push(content);
    return new Promise((resolve) => { finish = resolve; signalStarted(); });
  };
  const first = session.save();
  const second = session.save();
  await started;
  finish({ saved: true, content: "draft", publicationState: "target-published" });
  assert.deepEqual(await first, { status: "saved", publicationState: "target-published" });
  assert.deepEqual(await second, { status: "unavailable" });
  assert.deepEqual(host.saveRequests, ["draft"]);
  assert.equal(session.regularSavePublished({ published: true, provisional: true,
    content: "draft", journalScope: source.journalScope,
    revision: source.revision }), false, "a stale regular event cannot demote a sealed result");
  const snapshot = session.getSnapshot();
  if (snapshot.kind !== "edit") throw new Error("expected edit session");
  assert.equal(snapshot.publication.state, "target-published");
  assert.equal(snapshot.working.dirty, false);
  session.dispose();
});

test("failed publication retry and discard keep the candidate and safe decision", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt({ ...opened("candidate", true), publicationState: "pending-publication" });
  host.reconnectPendingPublication = async () => { throw new Error("private sync path"); };
  assert.deepEqual(await session.retryPublication(),
    { status: "failed", code: "OPERATION_FAILED" });
  let snapshot = session.getSnapshot();
  if (snapshot.kind !== "read-only") throw new Error("expected read-only");
  assert.deepEqual(snapshot.attention, { kind: "publication-decision",
    state: "pending-publication", failureCode: "OPERATION_FAILED" });
  assert.equal(snapshot.working.text, "candidate");
  host.discardPendingPublication = async () => { throw new Error("private delete path"); };
  assert.deepEqual(await session.discardPublication(),
    { status: "failed", code: "OPERATION_FAILED" });
  snapshot = session.getSnapshot();
  if (snapshot.kind !== "read-only") throw new Error("expected read-only");
  assert.equal(snapshot.publication.state, "pending-publication");
  assert.equal(snapshot.working.text, "candidate");
  assert.equal(JSON.stringify(snapshot).includes("private"), false);
  session.dispose();
});

test("conflict retry routes divergence acquisition through the session queue", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt({ ...opened("candidate", true), publicationState: "conflict" });
  assert.deepEqual(await session.retryPublication(), { status: "divergence-required" });
  let finish!: (draft: { content: string; hasConflicts: boolean;
    ancestorRevision: string; localRevision: string;
    currentRevision: string }) => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  host.beginDivergenceResolution = () => new Promise((resolve) => {
    finish = resolve; signalStarted();
  });
  const acquiring = session.beginDivergenceResolution();
  await started;
  const pending = session.getSnapshot();
  if (pending.kind !== "read-only") throw new Error("expected read-only");
  assert.equal(pending.pending, "divergence");
  assert.equal(pending.commands.publicationRetry, false);
  finish({ content: "merge draft", hasConflicts: false, ancestorRevision: "a",
    localRevision: "l", currentRevision: "c" });
  const outcome = await acquiring;
  if (outcome.status !== "divergence") throw new Error("expected merge draft");
  assert.deepEqual(outcome, { status: "divergence", hasConflicts: false });
  assert.equal(JSON.stringify(outcome).includes("merge draft"), false);
  const merged = session.getSnapshot();
  if (merged.kind !== "edit") throw new Error("expected atomic edit adoption");
  assert.equal(merged.working.text, "merge draft");
  assert.equal(merged.working.dirty, true);
  assert.equal(merged.publication.resolving, true);
  assert.deepEqual(await session.beginDivergenceResolution(),
    { status: "unavailable" }, "an acquired draft cannot be reacquired before adoption");
  session.dispose();
});

test("conflict acquisition requires explicit discard of edits newer than the saved candidate", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt(opened("base", false));
  session.edit("saved candidate");
  let finish!: (result: { saved: true; content: string;
    publicationState: "conflict" }) => void;
  host.saveDocument = () => new Promise((resolve) => { finish = resolve; });
  const saving = session.save();
  await Promise.resolve();
  session.edit("newer unsaved edit");
  finish({ saved: true, content: "saved candidate", publicationState: "conflict" });
  assert.equal((await saving).status, "saved");
  let acquisitions = 0;
  host.beginDivergenceResolution = async () => {
    acquisitions += 1;
    return { content: "merge draft", hasConflicts: false, ancestorRevision: "a",
      localRevision: "l", currentRevision: "c" };
  };
  assert.deepEqual(await session.retryPublication(), { status: "divergence-required" });
  assert.deepEqual(await session.beginDivergenceResolution(),
    { status: "unsaved-work" });
  assert.equal(acquisitions, 0);
  const preserved = session.getSnapshot();
  if (preserved.kind !== "read-only" && preserved.kind !== "edit") {
    throw new Error("expected unlocked session");
  }
  assert.equal(preserved.working.text, "newer unsaved edit");
  assert.equal(preserved.working.dirty, true);
  assert.deepEqual(await session.beginDivergenceResolution({ discardUnsaved: true }),
    { status: "divergence", hasConflicts: false });
  assert.equal(acquisitions, 1);
  session.dispose();
});

test("failed divergence acquisition preserves even consented unsaved work for retry", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt({ ...opened("saved candidate", false), publicationState: "conflict" });
  session.edit("newer protected edit");
  host.beginDivergenceResolution = async () => { throw new Error("private merge path"); };
  assert.deepEqual(await session.beginDivergenceResolution({ discardUnsaved: true }),
    { status: "failed", code: "OPERATION_FAILED" });
  const snapshot = session.getSnapshot();
  if (snapshot.kind !== "edit") throw new Error("expected editable session");
  assert.equal(snapshot.working.text, "newer protected edit");
  assert.equal(snapshot.working.dirty, true);
  assert.deepEqual(snapshot.attention, { kind: "publication-decision", state: "conflict",
    failureCode: "OPERATION_FAILED" });
  session.dispose();
});

test("discarding a pending candidate restores a provisional target as still unsaved", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt({ ...opened("pending candidate", true),
    publicationState: "pending-publication" });
  host.discardPendingPublication = async () => ({ ...opened("prior provisional"),
    provisional: true });
  assert.deepEqual(await session.discardPublication(),
    { status: "publication-discarded" });
  const snapshot = session.getSnapshot();
  if (snapshot.kind !== "read-only") throw new Error("expected read-only");
  assert.equal(snapshot.publication.state, "provisional");
  assert.equal(snapshot.working.text, "prior provisional");
  assert.equal(snapshot.working.baseline, "invalid");
  assert.equal(snapshot.working.dirty, true);
  assert.equal(snapshot.commands.backup, false);
  session.dispose();
});

test("host-authorized document refresh updates publication attention", () => {
  const session = new DocumentSession(new Host(), new Journal());
  session.adopt(opened("candidate"));
  assert.equal(session.refreshDocument({ ...opened("candidate"),
    publicationState: "pending-publication" }), true);
  const snapshot = session.getSnapshot();
  if (snapshot.kind !== "read-only") throw new Error("expected read-only");
  assert.equal(snapshot.publication.state, "pending-publication");
  assert.deepEqual(snapshot.attention,
    { kind: "publication-decision", state: "pending-publication" });
  session.dispose();
});

test("a merge draft hides the publication decision until save or discard", () => {
  const session = new DocumentSession(new Host(), new Journal());
  session.adopt({ ...opened("candidate", true), publicationState: "conflict" });
  assert.equal(session.adoptDivergence("merge draft"), true);
  session.refreshDocument({ ...opened("candidate", false),
    publicationState: "conflict" });
  const merging = session.getSnapshot();
  if (merging.kind !== "edit") throw new Error("expected edit merge session");
  assert.equal(merging.publication.state, "conflict");
  assert.equal(merging.publication.resolving, true);
  assert.equal(merging.attention, undefined);
  assert.equal(merging.working.text, "merge draft");
  assert.equal(merging.commands.save, true);
  session.lockStarted();
  const locked = session.getSnapshot();
  if (locked.kind !== "locked") throw new Error("expected locked");
  assert.equal(locked.publication.resolving, false);
  session.dispose();
});

test("edit lease attention is secret-free and one-shot confirmation enters edit mode", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt(opened());
  host.editResult = { decisionRequired: "lease-takeover", operation: "edit",
    holderName: "Ada", authorization: "secret authorization" };
  assert.deepEqual(await session.enterEditMode(), { status: "attention" });
  const attention = session.getSnapshot();
  assert.equal(attention.kind, "read-only");
  if (attention.kind !== "read-only") throw new Error("expected read-only");
  assert.deepEqual(attention.attention,
    { kind: "lease-takeover", operation: "edit", holderName: "Ada" });
  assert.equal(JSON.stringify(attention).includes("secret authorization"), false);
  host.editResult = opened("private text", false);
  assert.deepEqual(await session.confirmLeaseTakeover(), { status: "edit-mode" });
  assert.equal(session.getSnapshot().kind, "edit");
  assert.deepEqual(host.editRequests, [{}, { authorization: "secret authorization" }]);
  assert.deepEqual(await session.confirmLeaseTakeover(), { status: "unavailable" });
  session.dispose();
});

test("lock start supersedes a late edit lease and removes one-shot authority", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt(opened());
  let resolveEdit!: (result: OpenedDocument) => void;
  host.enterEditMode = () => new Promise((resolve) => { resolveEdit = resolve; });
  const pending = session.enterEditMode();
  await Promise.resolve();
  session.lockStarted();
  resolveEdit(opened("late text", false));
  assert.deepEqual(await pending, { status: "superseded" });
  assert.equal(session.getSnapshot().kind, "locked");
  assert.equal(JSON.stringify(session.getSnapshot()).includes("late text"), false);
  session.dispose();
});

test("failed edit acquisition exposes safe retry attention until the next command", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt(opened());
  host.enterEditMode = async () => { throw new Error("private lease path"); };
  assert.deepEqual(await session.enterEditMode(),
    { status: "failed", code: "OPERATION_FAILED" });
  const failed = session.getSnapshot();
  if (failed.kind !== "read-only") throw new Error("expected read-only");
  assert.deepEqual(failed.attention,
    { kind: "edit-unavailable", code: "OPERATION_FAILED" });
  assert.equal(JSON.stringify(failed).includes("private lease path"), false);
  host.enterEditMode = async () => opened("private text", false);
  assert.deepEqual(await session.enterEditMode(), { status: "edit-mode" });
  const editing = session.getSnapshot();
  if (editing.kind !== "edit") throw new Error("expected edit");
  assert.equal(editing.attention, undefined);
  session.dispose();
});

test("other lease decisions consume each authority once across changed evidence and faults", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt(opened());
  const first = { decisionRequired: "lease-takeover" as const,
    operation: "recovery" as const, holderName: "Ada", authorization: "one-use token" };
  const initial = session.getSnapshot();
  if (initial.kind !== "read-only") throw new Error("expected read-only");
  assert.equal(session.stageLeaseDecision(first, initial.adoption), true);
  const requests: string[] = [];
  host.restoreRecoveredWork = async (request) => {
    const authorization = request?.authorization;
    requests.push(authorization ?? "");
    return { ...first, authorization: "changed-evidence token" };
  };
  assert.deepEqual(await session.confirmLeaseTakeover(), { status: "attention" });
  assert.deepEqual(requests, ["one-use token"]);
  const changed = session.getSnapshot();
  if (changed.kind === "read-only" && changed.attention?.kind === "lease-takeover") {
    assert.equal(changed.attention.holderName, "Ada");
  }
  host.cancelLeaseTakeover = async (authorization) => {
    requests.push(authorization);
    throw new Error("private revocation failure");
  };
  assert.deepEqual(await session.cancelLeaseTakeover(),
    { status: "failed", code: "OPERATION_FAILED" });
  assert.deepEqual(requests, ["one-use token", "changed-evidence token"]);
  assert.deepEqual(await session.cancelLeaseTakeover(), { status: "unavailable" });
  assert.equal(JSON.stringify(session.getSnapshot()).includes("token"), false);
  session.dispose();
});

test("a late initial challenge cannot attach to a replacement adoption", async () => {
  const session = new DocumentSession(new Host(), new Journal());
  session.adopt(opened("document A"));
  const first = session.getSnapshot();
  if (first.kind !== "read-only") throw new Error("expected read-only");
  session.lockStarted();
  session.adopt(opened("document B"));
  const challenge = { decisionRequired: "lease-takeover" as const,
    operation: "recovery" as const, holderName: "old holder",
    authorization: "old token" };
  assert.equal(session.stageLeaseDecision(challenge, first.adoption), false);
  const current = session.getSnapshot();
  if (current.kind !== "read-only") throw new Error("expected read-only");
  assert.equal(current.document.content, "document B");
  assert.equal(current.attention, undefined);
  assert.deepEqual(await session.confirmLeaseTakeover(), { status: "unavailable" });
  session.dispose();
});

test("queued confirmation consumes visible takeover before the host command starts", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt(opened());
  host.editResult = { decisionRequired: "lease-takeover", operation: "edit",
    holderName: "Ada", authorization: "one-use token" };
  assert.deepEqual(await session.enterEditMode(), { status: "attention" });
  let completeClose!: (completed: boolean) => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  host.closeDocument = () => new Promise((resolve) => {
    completeClose = resolve;
    signalStarted();
  });
  const closing = session.close();
  await started;
  const confirming = session.confirmLeaseTakeover();
  const queued = session.getSnapshot();
  if (queued.kind !== "read-only") throw new Error("expected read-only");
  assert.equal(queued.pending, "close");
  assert.equal(queued.queued, "lease-confirm");
  assert.equal(queued.attention, undefined);
  assert.deepEqual(await session.confirmLeaseTakeover(), { status: "unavailable" });
  completeClose(false);
  assert.deepEqual(await closing, { status: "pending" });
  host.editResult = opened("private text", false);
  assert.deepEqual(await confirming, { status: "edit-mode" });
  session.dispose();
});

test("queued cancellation consumes visible takeover before host revocation starts", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  session.adopt(opened());
  host.editResult = { decisionRequired: "lease-takeover", operation: "edit",
    holderName: "Ada", authorization: "one-use token" };
  assert.deepEqual(await session.enterEditMode(), { status: "attention" });
  let completeClose!: (completed: boolean) => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  host.closeDocument = () => new Promise((resolve) => {
    completeClose = resolve;
    signalStarted();
  });
  const closing = session.close();
  await started;
  const canceling = session.cancelLeaseTakeover();
  const queued = session.getSnapshot();
  if (queued.kind !== "read-only") throw new Error("expected read-only");
  assert.equal(queued.pending, "close");
  assert.equal(queued.queued, "lease-cancel");
  assert.equal(queued.attention, undefined);
  assert.deepEqual(await session.cancelLeaseTakeover(), { status: "unavailable" });
  completeClose(false);
  assert.deepEqual(await closing, { status: "pending" });
  assert.deepEqual(await canceling, { status: "canceled", revoked: true });
  session.dispose();
});

test("successful adoption publishes one immutable read-only lifecycle snapshot", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  const closed = session.getSnapshot();
  assert.equal(closed.kind, "closed");
  assert.equal(Object.isFrozen(closed), true);
  assert.equal(session.getSnapshot(), closed, "snapshot identity is stable between changes");

  let changes = 0;
  const stop = session.subscribe(() => { changes += 1; });
  const result = await session.openSelected("one-time password");
  assert.equal(result.status, "opened");
  const current = session.getSnapshot();
  assert.equal(current.kind, "read-only");
  if (current.kind !== "read-only") throw new Error("expected read-only session");
  assert.equal(current.document.content, "private text");
  assert.equal(current.document.readOnly, true);
  assert.equal(current.adoption, 1);
  assert.equal(Object.isFrozen(current), true);
  assert.equal(Object.isFrozen(current.document), true);
  assert.equal(changes, 2, "pending open and adopted document each publish once");
  stop();
  session.dispose();
});

test("lock start immediately drops working text and retains only target identity for unlock", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  await session.openSelected("secret password");
  session.lockStarted();
  const locked = session.getSnapshot();
  assert.equal(locked.kind, "locked");
  if (locked.kind !== "locked") throw new Error("expected locked session");
  assert.equal(locked.targetName, "notes.scpefe");
  assert.equal("document" in locked, false);
  assert.equal("working" in locked, false);
  assert.equal(JSON.stringify(locked).includes("private text"), false);
  host.openResult = opened("reopened text");
  assert.equal((await session.unlock("another password")).status, "opened");
  const reopened = session.getSnapshot();
  assert.equal(reopened.kind, "read-only");
  if (reopened.kind === "read-only") assert.equal(reopened.document.content, "reopened text");
  assert.equal(session.refreshDocument(opened("reopened text", false)), true);
  const editing = session.getSnapshot();
  assert.equal(editing.kind, "edit");
  if (editing.kind === "edit") {
    assert.equal(editing.document.readOnly, false);
    assert.equal(editing.adoption, 2, "metadata changes preserve adoption identity");
  }
  assert.equal(session.refreshDocument({ ...opened("reopened text", false),
    targetName: undefined }), true);
  session.lockStarted();
  const relocked = session.getSnapshot();
  if (relocked.kind === "locked") assert.equal(relocked.targetName, "notes.scpefe",
    "a metadata result without a display name keeps the adopted target identity");
  assert.equal(session.refreshDocument(opened("late edit", false)), false);
  assert.equal(session.getSnapshot().kind, "locked");
  session.dispose();
});

test("invitation staging retains the current document until claim succeeds", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  await session.openSelected("current password");
  const current = session.getSnapshot();
  host.openResult = { readOnly: true, invitationRequired: true,
    targetName: "invitation.scpefe" };
  const outcome = await session.openSelected("invitation password");
  assert.equal(outcome.status, "invitation");
  const retained = session.getSnapshot();
  assert.equal(retained.kind, "read-only");
  if (retained.kind === "read-only" && current.kind === "read-only") {
    assert.equal(retained.document, current.document,
      "the old session remains authoritative while invitation claim is pending");
    assert.equal(retained.pending, undefined);
  }
  session.dispose();
});

test("lock start invalidates active and queued adoption commands", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  await session.openSelected("initial password");
  let resolveOpen!: (result: OpenedDocument) => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  host.openSelectedDocument = () => new Promise<OpenedDocument>((resolve) => {
    resolveOpen = resolve;
    signalStarted();
  });
  let unlockCalls = 0;
  host.unlockDocument = async () => { unlockCalls += 1; return opened("stale unlock"); };
  const active = session.openSelected("in-flight password");
  const queued = session.unlock("queued password");
  await started;
  assert.equal(session.getSnapshot().pending, "open",
    "the active host command is visible without its password");
  let queuedStatus: string | undefined;
  void queued.then((result) => { queuedStatus = result.status; });
  session.lockStarted();
  assert.equal(session.getSnapshot().pending, undefined);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(queuedStatus, "superseded",
    "lock start releases queued commands without waiting for an active host call");
  resolveOpen(opened("stale open"));
  assert.equal((await active).status, "superseded");
  assert.equal((await queued).status, "superseded");
  assert.equal(unlockCalls, 0, "the queued password is never sent after lock start");
  assert.equal(session.getSnapshot().kind, "locked");
  session.dispose();
});

test("a host rejection after lock start cannot report a failure to the cleared view", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  await session.openSelected("initial password");
  let rejectOpen!: (reason: Error) => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  host.openSelectedDocument = () => new Promise<OpenedDocument>((_resolve, reject) => {
    rejectOpen = reject;
    signalStarted();
  });
  const pending = session.openSelected("in-flight password");
  await started;
  session.lockStarted();
  rejectOpen(new Error("private host failure"));
  assert.deepEqual(await pending, { status: "superseded" });
  assert.equal(session.getSnapshot().kind, "locked");
  session.dispose();
});

test("failed open and unlock keep the current state and expose stable safe codes", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  host.openSelectedDocument = async () => { throw new Error("private /home/path detail"); };
  assert.deepEqual(await session.openSelected("bad password"),
    { status: "failed", code: "OPERATION_FAILED" });
  assert.equal(session.getSnapshot().kind, "closed");
  host.openSelectedDocument = async () => {
    throw Object.assign(new Error("private detail"),
      { name: "SafeBoundaryError", code: "OPEN_FAILED" });
  };
  assert.deepEqual(await session.openSelected("another bad password"),
    { status: "failed", code: "OPEN_FAILED" });
  session.adopt(opened());
  session.lockStarted();
  host.unlockDocument = async () => { throw new Error("sensitive internal detail"); };
  assert.deepEqual(await session.unlock("bad password"),
    { status: "failed", code: "OPERATION_FAILED" });
  assert.equal(session.getSnapshot().kind, "locked");
  session.dispose();
});

test("lock outcome limits host warning context to stable catalogue codes", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  await session.openSelected("password");
  host.lock = async () => ({ locked: true, journalSaved: false,
    warningCode: "private /home/path detail" });
  assert.deepEqual(await session.lock(),
    { status: "locked", warningCode: "OPERATION_FAILED" });
  assert.equal(session.getSnapshot().kind, "locked");
  session.dispose();
});

test("close leaves the session intact while host protection is pending, then clears identity", async () => {
  const host = new Host();
  const session = new DocumentSession(host, new Journal());
  await session.openSelected("password");
  host.closeDocument = async () => false;
  assert.equal((await session.close()).status, "pending");
  assert.equal(session.getSnapshot().kind, "read-only");
  host.closeDocument = async () => true;
  assert.equal((await session.close()).status, "closed");
  assert.equal(session.getSnapshot().kind, "closed");
  assert.equal("targetName" in session.getSnapshot(), false);
  session.dispose();
});
