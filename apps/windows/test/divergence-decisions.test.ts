import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// @ts-expect-error The JavaScript host has no generated declaration file.
import { DocumentService } from "../src/document-service.mjs";
// @ts-expect-error The JavaScript boundary has no generated declaration file.
import { validateDivergenceRequest } from "../src/contracts.mjs";

test("divergence IPC accepts only a bounded takeover token and target credential", () => {
  const authorization = "12345678-1234-4123-8123-123456789abc";
  assert.deepEqual(validateDivergenceRequest({ authorization,
    targetPassword: "current password" }),
  { authorization, targetPassword: "current password" });
  assert.throws(() => validateDivergenceRequest({ targetPassword: "current password",
    localPassword: "should not cross IPC" }), TypeError);
  assert.throws(() => validateDivergenceRequest({ targetPassword: 17 }), TypeError);
});

const documentId = "71".repeat(16);
const journalKey = Buffer.alloc(32, 41);
const ancestor = "72".repeat(32);
const local = "73".repeat(32);
const targetHead = "74".repeat(32);
const node = (revisionId: string, parentRevisionIds: string[] = []) =>
  ({ revisionId, parentRevisionIds });
const container = (content: string, head: string, graph: object[]) =>
  Buffer.from(JSON.stringify({ content, head, graph }));
const base = container("base", ancestor, [node(ancestor)]);
const candidate = container("saved local text", local,
  [node(ancestor), node(local, [ancestor])]);
const targetBytes = container("remote text", targetHead,
  [node(ancestor), node(targetHead, [ancestor])]);

for (const [status, expected] of [
  [10, "MERGE_TARGET_REAUTHENTICATION"],
  [20, "MERGE_UNRELATED_TARGET"],
  [21, "MERGE_TARGET_ROLLBACK"],
  [22, "MERGE_BASE_UNAVAILABLE"],
  [23, "MERGE_ACCESS_REVOKED"],
  [24, "MERGE_PERMISSION_DENIED"],
] as const) {
  test(`merge status ${status} preserves journalled work as ${expected}`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-merge-decision-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const target = path.join(directory, "document.scpefe");
    const profilePath = path.join(directory, "profile.json");
    await fs.writeFile(target, targetBytes);
    await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
      email: "ada@example.test", deviceName: "Desk" }));
    const native = {
      openDocument(bytes: Buffer) {
        const parsed = JSON.parse(bytes.toString()) as { content: string;
          head: string; graph: object[] };
        return { content: parsed.content, readOnly: true, canEdit: true,
          documentId, baseRevision: parsed.head, revisionGraph: parsed.graph,
          journalKey: Buffer.from(journalKey) };
      },
      mergeDocument() {
        throw Object.assign(new Error(`native status ${status}`), { status });
      },
    };
    const service = new DocumentService({ native, fs, profilePath,
      journalDirectory: path.join(directory, "journals"),
      witnessDirectory: path.join(directory, "witnesses"),
      publicationCapabilities: { sameFilesystemTransaction: true,
        replacementGuarantee: "atomic-replace" } });
    let record = await service.publications.prepare({ documentId, journalKey,
      target, base, candidate, text: "saved local text",
      cursor: { start: 4, end: 4 }, baseRevision: ancestor });
    record = await service.publications.markDiverged(documentId, journalKey, record);
    await service.openDocument(target, "password words");
    await assert.rejects(service.beginDivergenceResolution(),
      (error: any) => error.code === expected);
    const retained = await service.journals.read(documentId, journalKey);
    assert.equal(retained?.state, "conflict");
    assert.equal(retained?.text, "saved local text");
    assert.deepEqual(retained?.cursor, { start: 4, end: 4 });
    assert.deepEqual(await fs.readFile(target), targetBytes);
    assert.equal(service.active.editMode, false);
  });
}
