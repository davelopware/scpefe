import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeDocumentText, validateCreateRequest, validateCreationResult,
  validateBackupResult,
  validateOpenedDocument, validatePlaintextExportRequest,
  validatePlaintextExportResult, validateProfile,
  validateWorkingCopy } from "../src/contracts.mjs";

test("requires the complete local profile", () => {
  assert.deepEqual(validateProfile({
    name: " Ada ", email: "ada@example.test", deviceName: "Desk PC",
  }), { name: "Ada", email: "ada@example.test", deviceName: "Desk PC" });
  assert.throws(() => validateProfile({ name: "Ada", email: "", deviceName: "PC" }));
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

test("accepts only validated read-only native results", () => {
  assert.deepEqual(validateOpenedDocument({ content: "secret", readOnly: true,
    canEdit: true }), { content: "secret", readOnly: true, canEdit: true,
    publicationState: "target-published" });
  assert.throws(() => validateOpenedDocument({ content: "secret", readOnly: false }));
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

test("creation results cannot expose host filesystem paths", () => {
  assert.deepEqual(validateCreationResult({ created: true }), { created: true });
  assert.throws(() => validateCreationResult({
    created: true, target: "C:\\Users\\Ada\\secret.scpefe",
  }));
});

test("backup results expose success without a host filesystem path", () => {
  assert.deepEqual(validateBackupResult({ backedUp: true }), { backedUp: true });
  assert.throws(() => validateBackupResult({
    backedUp: true, target: "C:\\Users\\Ada\\secret.scpefe",
  }), /invalid backup result/);
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
