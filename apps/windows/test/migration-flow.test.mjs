import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DocumentService } from "../src/document-service.mjs";

const publicationCapabilities = Object.freeze({ sameFilesystemTransaction: true,
  replacementGuarantee: "atomic-replace" });

for (const [name, image] of [
  ["v1", Buffer.concat([Buffer.from("SCPEFE"), Buffer.from([0, 1]),
    Buffer.from("retired-envelope")])],
  ["v2", Buffer.concat([Buffer.from("SCPEFE"), Buffer.from([0, 2]),
    Buffer.from("retired-envelope")])],
]) {
  test(`opening a retired ${name} envelope preserves the target and closes admission`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-obsolete-format-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const target = path.join(directory, "document.scpefe");
    const profilePath = path.join(directory, "profile.json");
    await fs.writeFile(target, image);
    await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
      email: "ada@example.test", deviceName: "Desk" }));
    let opens = 0;
    const native = {
      createContainerContext: () => ({ open() { opens += 1; }, close() {} }),
      inspectDocument(bytes) {
        assert.deepEqual(bytes, image);
        const error = new Error("native status 8");
        error.status = 8;
        throw error;
      },
    };
    const service = new DocumentService({ native, fs, profilePath,
      journalDirectory: path.join(directory, "journals"),
      witnessDirectory: path.join(directory, "witnesses"),
      publicationCapabilities });
    await assert.rejects(service.openDocument(target, "owner password words"),
      (error) => error.status === 8);
    assert.equal(opens, 0);
    assert.equal(service.active, null);
    assert.deepEqual(await fs.readFile(target), image);
    assert.equal(typeof service.migrateDocument, "undefined");
  });
}
