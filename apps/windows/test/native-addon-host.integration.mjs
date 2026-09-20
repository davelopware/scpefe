import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const addonPath = process.argv[2];
const releasePath = process.argv[3];
assert.ok(addonPath, "native addon path is required");
assert.ok(releasePath, "release signal path is required");

const native = createRequire(import.meta.url)(addonPath);
assert.equal(typeof native.createDocument, "function");
console.log("SCPEFE_NATIVE_HOST_READY");

const deadline = Date.now() + 30_000;
while (!existsSync(releasePath)) {
  assert.ok(Date.now() < deadline, "host inspection did not release the probe");
  await new Promise((resolve) => setTimeout(resolve, 25));
}
