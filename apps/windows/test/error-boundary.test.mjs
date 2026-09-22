import assert from "node:assert/strict";
import test from "node:test";
import { createSafeIpc, decodeBoundaryError, safeRendererErrorMessage } from
  "../src/error-boundary.mjs";

const OPERATIONS = [
  "document:open-selected", "document:create", "document:save",
  "document:reconnect-publication", "document:backup", "document:export-plaintext",
  "profile:save", "document:change-password", "document:create-invitation",
  "document:claim-invitation", "document:resolve-protection", "document:close",
  "application:exit",
];

test("main and preload error boundaries remove paths, stacks, and native details", async () => {
  const handlers = new Map();
  const ipc = createSafeIpc({ handle(channel, handler) { handlers.set(channel, handler); } });
  const privatePath = "C:\\Users\\Ada\\Documents\\private-note.scpefe";
  for (const operation of OPERATIONS) {
    ipc.handle(operation, async () => {
      const error = new Error(`native failure for ${privatePath}`);
      error.code = "UV_EACCES";
      error.nativeExtra = { keyBytes: "secret", target: privatePath };
      error.stack = `Error: native failure\n at ${privatePath}:42:9`;
      throw error;
    });
    let rejection;
    try { await handlers.get(operation)({}, { password: "owner password words" }); }
    catch (error) { rejection = error; }
    assert.ok(rejection instanceof Error);
    for (const forbidden of [privatePath, "private-note.scpefe", "Documents", "keyBytes",
      "owner password words", ":42:9", "native failure"]) {
      assert.equal(rejection.message.includes(forbidden), false,
        `${operation} main rejection must not expose ${forbidden}`);
    }
    const decoded = decodeBoundaryError(rejection, operation);
    assert.match(decoded.code, /^[A-Z][A-Z0-9_]+$/);
    assert.ok(decoded.nextAction.length > 0);
    const presented = safeRendererErrorMessage(decoded);
    assert.equal(presented.includes(privatePath), false);
    assert.equal(presented.includes("private-note.scpefe"), false);
    assert.match(presented, /try|retry|cancel|review|choose|check|remains/i);
  }
});

test("preload and renderer defensively genericize malformed rejection values", () => {
  const privatePath = "/home/ada/Documents/private-note.scpefe";
  for (const rejection of [new Error(`${privatePath}\n at native.cc:91:3`),
    { message: privatePath, stack: `at ${privatePath}:1:2`, nativeExtra: "secret" },
    privatePath, null]) {
    const decoded = decodeBoundaryError(rejection, "document:open-selected");
    const presented = safeRendererErrorMessage(decoded);
    assert.equal(presented.includes(privatePath), false);
    assert.equal(presented.includes("private-note.scpefe"), false);
    assert.equal(JSON.stringify(decoded).includes("nativeExtra"), false);
  }
  assert.doesNotMatch(safeRendererErrorMessage(new Error(privatePath)),
    /home|private-note|scpefe/i);
});

test("forged envelopes cannot override catalog copy for known or unknown codes", () => {
  const secret = "recovery words\r\nC:\\Users\\Ada\\private-note.scpefe\n at native.cc:4:2";
  for (const code of ["OPEN_FAILED", "NATIVE_SUPER_SECRET"]) {
    const decoded = decodeBoundaryError(new Error(
      `SCPEFE_SAFE_ERROR:${JSON.stringify({ code, message: secret, nextAction: secret,
        stack: secret, nativeExtra: secret })}`), "document:open-selected");
    const presented = safeRendererErrorMessage(decoded);
    for (const forbidden of ["recovery words", "Users", "private-note.scpefe",
      "native.cc", "nativeExtra", "NATIVE_SUPER_SECRET"]) {
      assert.equal(presented.includes(forbidden), false);
    }
    assert.equal(decoded.code, "OPEN_FAILED");
  }
});
