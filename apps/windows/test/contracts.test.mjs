import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeDocumentText, validateCreateFormRequest, validateCreateRequest,
  validateCreationResult, validateCreationTargetResult,
  validateOpenTargetResult,
  validateBackupResult, validateCompactionResult,
  validateOpenedDocument, validatePlaintextExportRequest,
  validatePlaintextExportResult, validateProfile,
  validateWorkingCopy, validateMergeDraft, validateExternalOpenRequest,
  validateUnresolvedJournalSummary, validatePasswordChangeRequest,
  validateInvitationCreateRequest, validateInvitationResult,
  validateInvitationClaimRequest,
  validateSlotPermissionsRequest, validateSlotId, validateRegularSaveResult,
  validateSlotRemovalResult } from "../src/contracts.mjs";

test("requires the complete local profile", () => {
  assert.deepEqual(validateProfile({
    name: " Ada ", email: "ada@example.test", deviceName: "Desk PC",
  }), { name: "Ada", email: "ada@example.test", deviceName: "Desk PC" });
  assert.throws(() => validateProfile({ name: "Ada", email: "", deviceName: "PC" }));
});

test("password administration requests are narrow and enforce confirmations", () => {
  assert.deepEqual(validatePasswordChangeRequest({ currentPassword: "old password words",
    newPassword: "new password words", newPasswordConfirmation: "new password words",
    ignored: "not forwarded" }), { currentPassword: "old password words",
    newPassword: "new password words" });
  assert.throws(() => validatePasswordChangeRequest({ currentPassword: "old password words",
    newPassword: "new password words", newPasswordConfirmation: "typo password words" }),
  /do not match/);
  assert.deepEqual(validateInvitationCreateRequest({ temporaryLabel: "Colleague",
    temporaryPassword: "", canEdit: true, canAddPasswords: true,
    canRemovePasswords: false, ignored: "not forwarded" }), {
    temporaryLabel: "Colleague", canEdit: true, canAddPasswords: true,
    canRemovePasswords: false,
  });
  assert.throws(() => validateInvitationCreateRequest({ temporaryLabel: "Colleague",
    canEdit: false, canAddPasswords: true, canRemovePasswords: false }),
  /implies edit/);
  assert.deepEqual(validateInvitationResult({ created: true,
    temporaryPassword: "one time secret" }), { created: true,
    temporaryPassword: "one time secret" });
  assert.throws(() => validateInvitationResult({ created: true,
    temporaryPassword: "" }), /invalid invitation result/);
  assert.deepEqual(validateInvitationClaimRequest({
    newPassword: "replacement password words",
    newPasswordConfirmation: "replacement password words", ignored: "private",
  }), { newPassword: "replacement password words" });
  assert.deepEqual(validateInvitationClaimRequest({
    newPassword: "short", newPasswordConfirmation: "short",
  }), { newPassword: "short" });
  assert.throws(() => validateInvitationClaimRequest({
    newPassword: "replacement password words",
    newPasswordConfirmation: "mismatched password words",
  }), /do not match/);
  const slotId = "ab".repeat(16);
  assert.equal(validateSlotId(slotId), slotId);
  assert.deepEqual(validateSlotPermissionsRequest({ slotId, canEdit: true,
    canAddPasswords: false, canRemovePasswords: true }), { slotId, canEdit: true,
    canAddPasswords: false, canRemovePasswords: true });
});

test("requires irrecoverability and independent recovery acknowledgements", () => {
  const request = {
    ownerPassword: "owner password words",
    recoveryPassword: "different recovery words",
    content: "hello",
    understandsIrrecoverable: true,
    storedRecoverySeparately: true,
  };
  assert.deepEqual(validateCreateRequest(request), {
    ownerPassword: request.ownerPassword,
    recoveryPassword: request.recoveryPassword,
    content: "hello",
    understandsIrrecoverable: true,
    storedRecoverySeparately: true,
  });
  assert.throws(() => validateCreateRequest({ ...request,
    understandsIrrecoverable: false }));
  assert.throws(() => validateCreateRequest({ ...request,
    recoveryPassword: request.ownerPassword }));
  assert.throws(() => validateCreateRequest({ ...request,
    storedRecoverySeparately: false }));
  assert.deepEqual(validateCreateRequest({ ...request,
    recoveryPassword: "", storedRecoverySeparately: false }), {
    ownerPassword: request.ownerPassword,
    recoveryPassword: null,
    content: "hello",
    understandsIrrecoverable: true,
    storedRecoverySeparately: false,
  });
});

test("creation form confirms owner and optional recovery passwords", () => {
  const request = {
    ownerPassword: "owner password words",
    ownerPasswordConfirmation: "owner password words",
    recoveryPassword: "different recovery words",
    recoveryPasswordConfirmation: "different recovery words",
    content: "", understandsIrrecoverable: true,
    storedRecoverySeparately: true,
  };
  assert.deepEqual(validateCreateFormRequest(request), request);
  assert.throws(() => validateCreateFormRequest({ ...request,
    ownerPasswordConfirmation: "mistyped owner words" }),
  /owner passwords do not match/);
  assert.throws(() => validateCreateFormRequest({ ...request,
    recoveryPasswordConfirmation: "mistyped recovery words" }),
  /recovery passwords do not match/);
  assert.deepEqual(validateCreateFormRequest({ ...request,
    recoveryPassword: "", recoveryPasswordConfirmation: "",
    storedRecoverySeparately: false }), {
    ...request, recoveryPassword: "", recoveryPasswordConfirmation: "",
    storedRecoverySeparately: false,
  });
  assert.throws(() => validateCreateFormRequest({ ...request,
    recoveryPassword: "", recoveryPasswordConfirmation: "recovery only" }),
  /recovery passwords do not match/);
  assert.throws(() => validateCreateFormRequest({ ...request,
    content: "pre-populated plaintext" }), /content must be blank/);
});

test("accepts only validated read-only native results", () => {
  assert.deepEqual(validateOpenedDocument({ content: "secret", readOnly: true,
    canEdit: true, targetName: "notes.scpefe" }), {
    content: "secret", readOnly: true, canEdit: true, targetName: "notes.scpefe",
    publicationState: "target-published" });
  assert.throws(() => validateOpenedDocument({ content: "secret", readOnly: false }));
  for (const targetName of ["C:\\Users\\Ada\\secret.scpefe", "../secret.scpefe",
    "folder/secret.scpefe", "bad\nname.scpefe"]) {
    assert.throws(() => validateOpenedDocument({ content: "secret", readOnly: true,
      canEdit: true, targetName }), /invalid target filename/);
  }
  const narrowed = validateOpenedDocument({ content: "secret\r\n", readOnly: true,
    canEdit: true, targetName: "notes.scpefe", nativePassword: "must not cross",
    lease: { active: true, holderName: "Remote", holderEmail: "remote@example.test",
      deviceName: "Laptop", sessionId: "ab".repeat(16), heartbeatCounter: 2,
      holderUtcMs: 10, durationMs: 600000, nativeLeaseToken: "must not cross" },
    headMismatch: { kind: "rollback", title: "Rollback", explanation: "Review it.",
      editingBlocked: true, observedDocumentId: "cd".repeat(16),
      observedHead: "ef".repeat(32), nativeProof: "must not cross" } });
  assert.equal(narrowed.content, "secret\n");
  assert.deepEqual(Object.keys(narrowed.lease).sort(), ["active", "deviceName", "durationMs",
    "holderEmail", "holderName", "holderUtcMs"]);
  assert.deepEqual(narrowed.headMismatch, { kind: "rollback",
    title: "Authenticated rollback detected",
    explanation: "The authenticated head is an ancestor of the last head seen by this client. This may be a stale replica; inspect it read-only and explicitly accept it only if the rollback is intended.",
    editingBlocked: true });
  assert.equal(JSON.stringify(narrowed).includes("must not cross"), false);
  assert.deepEqual(validateOpenedDocument(narrowed), narrowed,
    "canonical boundary results remain safe to revalidate inside the service");
});

test("push and administration results are canonical and narrowly projected", () => {
  assert.deepEqual(validateRegularSaveResult({ published: true, provisional: true,
    content: "exact\r\ntext", targetPath: "C:\\private\\notes.scpefe",
    password: "must not cross" }), {
    published: true, provisional: true, content: "exact\ntext",
  });
  assert.deepEqual(validateSlotRemovalResult({ removed: true,
    warningCode: "SLOT_REMOVED" }), {
    removed: true, warningCode: "SLOT_REMOVED",
  });
  assert.throws(() => validateSlotRemovalResult({ removed: true,
    warningCode: "SLOT_REMOVED", targetPath: "C:\\private\\notes.scpefe" }),
  /invalid slot-removal result/);
});

test("permits only the invitation claim surface before password replacement", () => {
  const opened = validateOpenedDocument({ content: "", readOnly: true,
    canEdit: false, canAddPasswords: false, mustBeChanged: true,
    slotIdentityName: "New colleague", slotIdentityEmail: "invite@example.test",
    profileName: "Document author", profileEmail: "author@example.test",
    deviceName: "Author device", lease: { active: true,
      holderName: "Lease holder", holderEmail: "holder@example.test",
      deviceName: "Lease device", sessionId: "ab".repeat(16),
      heartbeatCounter: 4, holderUtcMs: 1, durationMs: 600000 },
  });
  assert.deepEqual(opened, { readOnly: true, invitationRequired: true });
  assert.deepEqual(Object.keys(opened).sort(), ["invitationRequired", "readOnly"]);
  assert.deepEqual(validateOpenedDocument({ readOnly: true, invitationRequired: true,
    targetName: "invitation.scpefe" }), { readOnly: true, invitationRequired: true,
    targetName: "invitation.scpefe" });
  assert.throws(() => validateOpenedDocument({ readOnly: true, invitationRequired: true,
    content: "smuggled secret" }), /invalid staged invitation/);
  assert.throws(() => validateOpenedDocument({ content: "secret", readOnly: true,
    canEdit: false, mustBeChanged: true }), /exposed before claim/);
});

test("canonicalizes a BOM and common line endings without trimming", () => {
  assert.equal(canonicalizeDocumentText("\ufeff first \r\nsecond\r\n"),
    " first \nsecond\n");
  assert.equal(canonicalizeDocumentText("no final newline\r"), "no final newline\n");
  assert.equal(canonicalizeDocumentText("  whitespace  "), "  whitespace  ");
  assert.throws(() => canonicalizeDocumentText("bad\ud800text"), /valid UTF-8/);
});

test("canonicalizes working-copy cursor offsets with pasted text", () => {
  assert.deepEqual(validateWorkingCopy({ content: "\ufeffa\r\nb",
    cursor: { start: 4, end: 5 } }),
  { content: "a\nb", cursor: { start: 2, end: 3 } });
});

test("creation results expose only a safe name and validated blank edit session", () => {
  const opened = { content: "", readOnly: false, canEdit: true,
    publicationState: "target-published" };
  assert.deepEqual(validateCreationResult({ created: true, opened,
    name: "new.scpefe" }), { created: true, opened, name: "new.scpefe" });
  assert.throws(() => validateCreationResult({
    created: true, opened, name: "C:\\Users\\Ada\\secret.scpefe",
  }));
});

test("creation target selection exposes no host filesystem path", () => {
  assert.deepEqual(validateCreationTargetResult({ selected: true }), { selected: true });
  assert.throws(() => validateCreationTargetResult({ selected: true,
    target: "C:\\Users\\Ada\\secret.scpefe" }), /invalid creation target result/);
});

test("open target selection exposes only a safe display name", () => {
  assert.deepEqual(validateOpenTargetResult({ selected: true,
    name: "notes.scpefe" }), { selected: true, name: "notes.scpefe" });
  assert.throws(() => validateOpenTargetResult({ selected: true,
    name: "C:\\private\\notes.scpefe" }), /invalid open target result/);
});

test("backup results expose success without a host filesystem path", () => {
  assert.deepEqual(validateBackupResult({ backedUp: true }), { backedUp: true });
  assert.throws(() => validateBackupResult({
    backedUp: true, target: "C:\\Users\\Ada\\secret.scpefe",
  }), /invalid backup result/);
});

test("compaction results bind the verified backup and continuity heads", () => {
  assert.deepEqual(validateCompactionResult({ compacted: true, backupCreated: true,
    previousHead: "12".repeat(32), head: "34".repeat(32) }), {
    compacted: true, backupCreated: true,
    previousHead: "12".repeat(32), head: "34".repeat(32),
  });
  assert.throws(() => validateCompactionResult({ compacted: true,
    backupCreated: false, previousHead: "12".repeat(32), head: "34".repeat(32) }),
  /invalid compaction result/);
});

test("plaintext export contracts expose only canonical text and line-ending choice", () => {
  assert.deepEqual(validatePlaintextExportRequest({
    content: " first \r\nsecond", lineEndings: "native",
  }), { content: " first \nsecond", lineEndings: "native" });
  assert.deepEqual(validatePlaintextExportResult({ exported: true }), {
    exported: true,
  });
  assert.throws(() => validatePlaintextExportRequest({
    content: "secret", lineEndings: "crlf", metadata: { identity: "Ada" },
  }), /invalid/);
  assert.throws(() => validatePlaintextExportResult({
    exported: true, target: "/secret.txt",
  }), /invalid/);
});

test("merge drafts expose only bounded revision identities and canonical text", () => {
  const revision = "ab".repeat(32);
  assert.deepEqual(validateMergeDraft({ content: "local\r\n", hasConflicts: true,
    ancestorRevision: revision, localRevision: revision,
    currentRevision: revision }), { content: "local\n", hasConflicts: true,
    ancestorRevision: revision, localRevision: revision,
    currentRevision: revision });
  assert.throws(() => validateMergeDraft({ content: "draft", hasConflicts: false,
    ancestorRevision: "bad", localRevision: revision,
    currentRevision: revision }), /invalid merge draft/);
});

test("single-instance contracts expose no target paths or journal contents", () => {
  assert.deepEqual(validateUnresolvedJournalSummary({ total: 3,
    pendingPublications: 1, ignored: "private" }),
  { total: 3, pendingPublications: 1 });
  assert.throws(() => validateUnresolvedJournalSummary({ total: 1,
    pendingPublications: 2 }));
  const token = "123e4567-e89b-42d3-a456-426614174000";
  assert.deepEqual(validateExternalOpenRequest({ token,
    target: "C:\\private\\document.scpefe" }), { token });
  assert.deepEqual(validateExternalOpenRequest({ token, smokeCompleteAfterMs: 5000 }),
    { token, smokeCompleteAfterMs: 5000 });
  assert.throws(() => validateExternalOpenRequest({ token,
    smokeCompleteAfterMs: 30_001 }));
  assert.throws(() => validateExternalOpenRequest({ token: "../unsafe" }));
});
