import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
// @ts-expect-error The JavaScript host has no generated declaration file.
import { DocumentService } from "../src/document-service.mjs";

test("activity reads the latest committed image in a separate authenticated handle", () => {
  const actions: string[] = [];
  const native = { createContainerContext: () => ({
    open(bytes: Buffer) { actions.push(`open:${bytes.toString()}`); },
    unlock(password: string) { actions.push(`unlock:${password}`); },
    historyPage(offset: number, count: number) {
      actions.push(`page:${offset}:${count}`);
      return { items: [], nextOffset: offset, hasMore: false };
    },
    historyCompare(before: string, after: string) {
      actions.push(`compare:${before}:${after}`); return { available: false };
    },
    close() { actions.push("close"); },
  }) };
  const service = new DocumentService({ native, fs, profilePath: "/tmp/activity-profile.json",
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" } });
  service.active = { baseContainer: Buffer.from("latest committed"),
    password: "current password", migrationRequired: false };
  assert.deepEqual(service.revisionActivityPage(20, 10),
    { items: [], nextOffset: 20, hasMore: false });
  assert.deepEqual(service.revisionActivityComparison("before", "after"),
    { available: false });
  assert.deepEqual(actions, ["open:latest committed", "unlock:current password",
    "page:20:10", "close", "open:latest committed", "unlock:current password",
    "compare:before:after", "close"]);
  service.native.createContainerContext = () => ({
    open() {}, unlock() {}, close() { actions.push("unsupported-close"); },
    historyPage() {
      const error: Error & { code?: string } =
        new Error("SCPEFE operation failed with status 8");
      error.code = "SCPEFE_NATIVE";
      throw error;
    },
  });
  assert.deepEqual(service.revisionActivityPage(0, 20), { items: [],
    nextOffset: 0, hasMore: false, unavailable: true });
  assert.equal(actions.at(-1), "unsupported-close");
  service.lockOperation = Promise.resolve();
  assert.throws(() => service.revisionActivityPage(0, 20), /Unlock a document/);
  service.lockOperation = null;
  service.active = null;
  assert.throws(() => service.revisionActivityPage(0, 20), /Unlock a document/);
  assert.equal(actions.length, 9);
});
