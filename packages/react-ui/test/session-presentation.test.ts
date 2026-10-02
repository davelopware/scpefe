import assert from "node:assert/strict";
import test from "node:test";
import { DocumentSession, type DocumentSessionHost, type WorkingCopyJournalHost } from "@scpefe/frontend-core";
import { SessionPresentation } from "../src/session/session-presentation.ts";
import type { DocumentOpened } from "../src/session/types.ts";

const opened: DocumentOpened = { content: "draft", readOnly: true, canEdit: true,
  publicationState: "target-published", targetName: "notes.scpefe" };

function setup() {
  let edit: () => Promise<DocumentOpened> = async () => { throw new Error("private host path"); };
  const host = { enterEditMode: () => edit() } as unknown as DocumentSessionHost<DocumentOpened>;
  const journal = { createJournalScope: () => "scope", updateWorkingCopy: async () => ({}),
    onJournalWarning: () => () => {} } as WorkingCopyJournalHost;
  const session = new DocumentSession(host, journal);
  session.adopt(opened);
  const presentation = new SessionPresentation(session, () => "The operation could not be completed safely.");
  return { session, presentation, succeed: () => { edit = async () => ({ ...opened,
    readOnly: false }); } };
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
