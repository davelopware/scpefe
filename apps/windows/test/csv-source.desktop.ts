// @ts-nocheck -- host service is a JavaScript module without a declaration file.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseCsvSource, requireValidCsvSource, writeCsvSource }
  from "../../../packages/frontend-core/src/csv-source.mjs";
import { validateCreateFormRequest } from "../src/contracts.mjs";
import { DocumentService } from "../src/document-service.mjs";

test("CSV source retains quoted punctuation, line breaks, blank headings and empty rows", () => {
  const rows = [["", "column,2", "quote\"", "tab\tvalue", ""],
    ["line\nbreak", "", "", "", ""], ["", "", "", "", ""]];
  const source = writeCsvSource(rows);
  assert.deepEqual(parseCsvSource(source), { valid: true, rows });
  assert.ok(source.includes("\n"));
  assert.equal(source.includes("\r"), false);
  assert.equal(writeCsvSource([[""]]), '""');
  assert.deepEqual(parseCsvSource('""'), { valid: true, rows: [[""]] });
});

test("CSV source rejects malformed quoting and nonrectangular rows with a location", () => {
  for (const source of ['a,"unterminated', 'a"b', '"a"b', 'a,b\nc', 'a\r\nb']) {
    const result = parseCsvSource(source);
    assert.equal(result.valid, false, source);
    if (!result.valid) {
      assert.ok(result.message.length > 0);
      assert.ok(result.line >= 1);
      assert.ok(result.column >= 1);
      assert.throws(() => requireValidCsvSource(source), /Invalid CSV/);
    }
  }
});

test("creation accepts the one blank CSV heading and preserves Plain Text default", () => {
  const base = { ownerPassword: "owner password words", ownerPasswordConfirmation: "owner password words",
    recoveryPassword: "", recoveryPasswordConfirmation: "", understandsIrrecoverable: true,
    storedRecoverySeparately: false };
  assert.equal(validateCreateFormRequest({ ...base, content: "" }).contentType, undefined);
  assert.equal(validateCreateFormRequest({ ...base, content: '""', contentType: "csv" }).contentType,
    "csv");
  assert.throws(() => validateCreateFormRequest({ ...base, content: "a,b\nc", contentType: "csv" }));
});

test("host blocks invalid CSV manual save, regular save, and export before publication", async () => {
  const service = new DocumentService({ native: {}, fs,
    profilePath: path.join(os.tmpdir(), "scpefe-csv-validation", "profile.json"),
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" } });
  service.loadProfile = async () => ({ name: "Ada", email: "ada@example.test",
    deviceName: "Desk" });
  service.clientSettings = { regularSaveEnabled: true, regularSaveIntervalMs: 120000 };
  service.active = { editMode: true, pendingPublication: false,
    opened: { canEdit: true, contentType: "csv", content: '""' },
    dirty: true, working: { content: "a,b\nc", cursor: { start: 0, end: 0 } } };
  await assert.rejects(service.saveDocument("a,b\nc"), /Invalid CSV at line 2/);
  assert.deepEqual(await service.regularSaveDocument(), { published: false });
  await assert.rejects(service.exportPlaintext("safe.csv",
    { content: "a,b\nc", lineEndings: "lf" }), /Invalid CSV at line 2/);
  assert.equal(service.publicationOperations, 0);
});
