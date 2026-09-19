import assert from "node:assert/strict";
import test from "node:test";
import { validateCreateRequest, validateCreationResult, validateOpenedDocument,
  validateProfile } from "../src/contracts.mjs";

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
  });
  assert.throws(() => validateCreateRequest({ ...request,
    understandsIrrecoverable: false }));
  assert.throws(() => validateCreateRequest({ ...request,
    recoveryPassword: request.ownerPassword }));
  assert.throws(() => validateCreateRequest({ ...request,
    storedRecoverySeparately: false }));
});

test("accepts only validated read-only native results", () => {
  assert.deepEqual(validateOpenedDocument({ content: "secret", readOnly: true }),
    { content: "secret", readOnly: true });
  assert.throws(() => validateOpenedDocument({ content: "secret", readOnly: false }));
});

test("creation results cannot expose host filesystem paths", () => {
  assert.deepEqual(validateCreationResult({ created: true }), { created: true });
  assert.throws(() => validateCreationResult({
    created: true, target: "C:\\Users\\Ada\\secret.scpefe",
  }));
});
