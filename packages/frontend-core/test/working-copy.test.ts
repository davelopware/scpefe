import assert from "node:assert/strict";
import test from "node:test";
import { WorkingCopy, type WorkingCopyJournalHost,
  type WorkingCopyUpdate } from "../src/index.ts";

class ControlledJournal implements WorkingCopyJournalHost {
  readonly calls: Array<{ update: WorkingCopyUpdate;
    accept: () => void; fail: () => void }> = [];
  private readonly warnings = new Set<(code: string, journalScope: string | null) => void>();
  private nextScope = 0;

  createJournalScope(): string { return `test-scope-${++this.nextScope}`; }

  updateWorkingCopy(update: WorkingCopyUpdate): Promise<object> {
    return new Promise((resolve, reject) => {
      this.calls.push({ update,
        accept: () => resolve({ checkpointScheduled: true }),
        fail: () => reject(new Error("journal update failed")) });
    });
  }

  onJournalWarning(listener: (code: string, journalScope: string | null) => void): () => void {
    this.warnings.add(listener);
    return () => { this.warnings.delete(listener); };
  }

  warn(code: string, journalScope = this.calls.at(-1)?.update.journalScope ?? null): void {
    for (const listener of this.warnings) listener(code, journalScope);
  }
}

function ready(copy: WorkingCopy) {
  const snapshot = copy.getSnapshot();
  assert.equal(snapshot.kind, "ready");
  if (snapshot.kind !== "ready") throw new Error("working copy was not ready");
  return snapshot;
}

test("open adopts a clean working copy and local edits update history synchronously", () => {
  const journal = new ControlledJournal();
  const copy = new WorkingCopy(journal);
  assert.equal(copy.getSnapshot().kind, "empty");

  copy.adoptOpen("alpha");
  const opened = copy.getSnapshot();
  assert.equal(opened.kind, "ready");
  if (opened.kind !== "ready") return;
  assert.equal(opened.text, "alpha");
  assert.equal(opened.dirty, false);
  assert.equal(opened.canUndo, false);

  copy.edit("alpha!", { start: 6, end: 6 });
  const edited = copy.getSnapshot();
  assert.equal(edited.kind, "ready");
  if (edited.kind !== "ready") return;
  assert.equal(edited.text, "alpha!");
  assert.equal(edited.dirty, true);
  assert.equal(edited.canUndo, true);
  assert.equal(edited.selection.start, 6);
  assert.equal(journal.calls.length, 1);
  assert.equal(journal.calls[0].update.content, "alpha!");
});

test("undo and redo follow a bounded history and a new edit drops the redo branch", () => {
  const journal = new ControlledJournal();
  const copy = new WorkingCopy(journal, 3);
  copy.adoptOpen("A");
  copy.edit("AB");
  copy.edit("ABC");
  copy.edit("ABCD");
  assert.equal(ready(copy).historyLength, 3);
  copy.undo();
  assert.equal(ready(copy).text, "ABC");
  assert.equal(ready(copy).canRedo, true);
  copy.undo();
  assert.equal(ready(copy).text, "AB");
  assert.equal(ready(copy).canUndo, false);
  copy.redo();
  assert.equal(ready(copy).text, "ABC");
  copy.edit("ABC!");
  assert.equal(ready(copy).canRedo, false);
  assert.equal(ready(copy).text, "ABC!");
  assert.equal(journal.calls.at(-1)?.update.content, "ABC!");
});

test("publication establishes a manual baseline while provisional and recovered text stay dirty", () => {
  const copy = new WorkingCopy(new ControlledJournal());
  copy.adoptOpen("base");
  copy.edit("draft");
  copy.adoptPublication("draft\n");
  assert.equal(ready(copy).text, "draft\n");
  assert.equal(ready(copy).baseline, "valid");
  assert.equal(ready(copy).dirty, false);
  copy.undo();
  assert.equal(ready(copy).text, "base");
  assert.equal(ready(copy).dirty, true);

  copy.adoptOpen("provisional", true);
  assert.equal(ready(copy).dirty, true);
  assert.equal(ready(copy).baseline, "invalid");
  copy.adoptRecovery("restored", { start: 2, end: 5 });
  assert.equal(ready(copy).text, "restored");
  assert.equal(ready(copy).selection.start, 2);
  assert.equal(ready(copy).dirty, true);
  copy.adoptDivergence("merge draft");
  assert.equal(ready(copy).text, "merge draft");
  assert.equal(ready(copy).dirty, true);
  copy.lock();
  assert.equal(copy.getSnapshot().kind, "empty");
});

test("edits remain synchronous while reordered journal responses and failures are observable", async () => {
  const journal = new ControlledJournal();
  const copy = new WorkingCopy(journal);
  copy.adoptOpen("A");
  copy.edit("AB");
  copy.edit("ABC");
  assert.equal(ready(copy).text, "ABC");
  assert.equal(ready(copy).journal.pending, 2);
  const drained = copy.drainJournal();
  journal.calls[1].fail();
  await Promise.resolve();
  assert.equal(ready(copy).journal.pending, 1);
  journal.calls[0].accept();
  assert.equal((await drained).status, "failed");
  assert.equal(ready(copy).journal.failed, true);

  copy.edit("ABCD");
  assert.equal(ready(copy).journal.pending, 1);
  journal.calls[2].accept();
  assert.equal((await copy.drainJournal()).status, "drained");
  assert.equal(ready(copy).journal.failed, false);
});

test("lock and reset clear plaintext before delayed journal responses settle", async () => {
  const journal = new ControlledJournal();
  const copy = new WorkingCopy(journal);
  copy.adoptOpen("first");
  copy.edit("first secret");
  const draining = copy.drainJournal();
  copy.lock();
  assert.equal(copy.getSnapshot().kind, "empty");
  const afterLock = await Promise.race([draining,
    new Promise<{ status: "stuck" }>((resolve) => setTimeout(
      () => resolve({ status: "stuck" }), 20))]);
  assert.equal(afterLock.status, "cleared");
  journal.calls[0].fail();
  await Promise.resolve();
  assert.equal(copy.getSnapshot().kind, "empty");

  copy.adoptOpen("second");
  copy.edit("second secret");
  copy.reset();
  copy.adoptOpen("third");
  journal.calls[1].accept();
  await Promise.resolve();
  assert.equal(ready(copy).text, "third");
  assert.equal(ready(copy).journal.pending, 0);
  assert.equal(ready(copy).journal.failed, false);
});

test("find wraps from the selection and replace commands update text in one edit", () => {
  const journal = new ControlledJournal();
  const copy = new WorkingCopy(journal);
  copy.adoptOpen("one two one");
  assert.equal(copy.findNext("one").status, "selected");
  assert.equal(ready(copy).selection.start, 0);
  assert.equal(copy.findNext("one").status, "selected");
  assert.equal(ready(copy).selection.start, 8);
  assert.deepEqual(copy.findNext("one"), { status: "selected", wrapped: true,
    selection: { start: 0, end: 3 } });
  assert.equal(copy.replaceSelection("one", "ONE").status, "replaced");
  assert.equal(ready(copy).text, "ONE two one");
  assert.equal(ready(copy).selection.start, 3);
  assert.equal(copy.replaceAll("one", "1").replacements, 1);
  assert.equal(ready(copy).text, "ONE two 1");
  assert.equal(ready(copy).selection.start, 9);
  assert.equal(copy.findNext("missing").status, "not-found");
  assert.equal(copy.replaceAll("", "X").replacements, 0);
  assert.equal(journal.calls.length, 2);
});

test("provisional saves invalidate the baseline and selections stay within text", () => {
  const copy = new WorkingCopy(new ControlledJournal());
  copy.adoptOpen("same");
  copy.markProvisional();
  assert.equal(ready(copy).dirty, true);
  assert.equal(ready(copy).baseline, "invalid");
  copy.adoptRecovery("abc", { start: -5, end: 99 });
  assert.deepEqual(ready(copy).selection, { start: 0, end: 3 });
  copy.setSelection({ start: 20, end: 1 });
  assert.deepEqual(ready(copy).selection, { start: 1, end: 3 });
  copy.adoptPublication("abc");
  assert.equal(ready(copy).dirty, false);
  assert.deepEqual(ready(copy).selection, { start: 1, end: 3 });
});

test("a failed recovery checkpoint remains visible after an update acknowledgement", async () => {
  const journal = new ControlledJournal();
  const copy = new WorkingCopy(journal);
  copy.adoptOpen("base");
  copy.edit("unsaved");
  journal.calls[0].accept();
  await copy.drainJournal();
  assert.equal(ready(copy).journal.failed, false);
  journal.warn("RECOVERY_CHECKPOINT_FAILED");
  assert.equal(ready(copy).journal.failed, true);
  assert.equal(ready(copy).dirty, true);
  copy.adoptPublication("unsaved");
  assert.equal(ready(copy).journal.failed, false);
  copy.lock();
  journal.warn("RECOVERY_CHECKPOINT_FAILED");
  assert.equal(copy.getSnapshot().kind, "empty");
});

test("a delayed checkpoint warning from the previous adoption cannot fail a new document", () => {
  const journal = new ControlledJournal();
  const copy = new WorkingCopy(journal);
  copy.adoptOpen("first");
  copy.edit("first draft");
  const previousScope = journal.calls[0].update.journalScope;
  copy.lock();
  copy.adoptOpen("second");
  copy.edit("second draft");

  journal.warn("RECOVERY_CHECKPOINT_FAILED", previousScope);
  assert.equal(ready(copy).journal.failed, false);
  assert.equal(ready(copy).journal.pending, 1);
  assert.equal(ready(copy).text, "second draft");
});

test("a newer journal acknowledgement supersedes an older failure in either completion order", async () => {
  for (const order of ["newer-first", "older-first"]) {
    const journal = new ControlledJournal();
    const copy = new WorkingCopy(journal);
    copy.adoptOpen("A");
    copy.edit("AB");
    copy.edit("ABC");
    if (order === "newer-first") {
      journal.calls[1].accept();
      journal.calls[0].fail();
    } else {
      journal.calls[0].fail();
      journal.calls[1].accept();
    }
    assert.equal((await copy.drainJournal()).status, "drained", order);
    assert.equal(ready(copy).journal.failed, false, order);
  }
});
