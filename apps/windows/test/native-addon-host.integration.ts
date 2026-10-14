import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const addonPath = process.argv[2];
const releasePath = process.argv[3];
assert.ok(addonPath, "native addon path is required");
assert.ok(releasePath, "release signal path is required");

const native = createRequire(import.meta.url)(addonPath) as Record<string, unknown>;
for (const method of ["createContainerContext", "passwordMeetsPolicy",
  "assessPasswordPolicy", "inspectDocument"]) {
  assert.equal(typeof native[method], "function", `${method} is exported`);
}
for (const retired of ["createDocument", "openDocument", "saveDocument"]) {
  assert.equal(native[retired], undefined, `${retired} stays retired`);
}
const context = (native.createContainerContext as () => Record<string, unknown>)();
for (const method of ["create", "open", "unlock", "read", "bytes", "close"]) {
  assert.equal(typeof context[method], "function", `context.${method} is available`);
}
console.log("SCPEFE_NATIVE_HOST_READY");

const deadline = Date.now() + 30_000;
while (!existsSync(releasePath)) {
  assert.ok(Date.now() < deadline, "host inspection did not release the probe");
  await new Promise((resolve) => setTimeout(resolve, 25));
}
