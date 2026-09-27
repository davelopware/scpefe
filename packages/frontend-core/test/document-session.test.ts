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
}

const opened = (content = "private text", readOnly = true): OpenedDocument => ({
  content, readOnly, publicationState: "target-published", targetName: "notes.scpefe",
  canEdit: true,
});

class Journal implements WorkingCopyJournalHost {
  private scope = 0;
  createJournalScope(): string { return `scope-${++this.scope}`; }
  updateWorkingCopy(_update: WorkingCopyUpdate): Promise<unknown> {
    return Promise.resolve({ checkpointScheduled: true });
  }
  onJournalWarning(_listener: (code: string, scope: string | null) => void): () => void {
    return () => {};
  }
}

class Host implements DocumentSessionHost<OpenedDocument> {
  openResult: OpenedDocument | SessionInvitation = opened();
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
}

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
