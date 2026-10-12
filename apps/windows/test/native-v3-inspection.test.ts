import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

interface NativeAddon {
  createContainerContext(): {
    create(input: object): Buffer;
    close(): true;
  };
  inspectDocument(bytes: Buffer, password: string): {
    containerFormatVersion: number;
    content: string;
    documentId: string;
    journalKey: Buffer;
  };
}

const addonPath = process.env.SCPEFE_NATIVE_ADDON_PATH;
const native = addonPath
  ? createRequire(import.meta.url)(addonPath) as NativeAddon : null;

test("inspection authenticates only the revised v3 container", {
  skip: !native && "native addon path was not supplied",
}, () => {
  assert.ok(native);
  const password = "owner passphrase with independent words";
  const context = native.createContainerContext();
  const bytes = context.create({ name: "Ada", email: "ada@example.test",
    deviceName: "Ada PC", content: "private words", ownerPassword: password,
    timestampMs: 1 });
  context.close();

  const opened = native.inspectDocument(bytes, password);
  assert.equal(opened.containerFormatVersion, 3);
  assert.equal(opened.content, "private words");
  assert.match(opened.documentId, /^[0-9a-f]{32}$/);
  opened.journalKey.fill(0);
  assert.throws(() => native.inspectDocument(bytes, "incorrect password"),
    /status 10/);
  const obsolete = Buffer.from(bytes);
  obsolete[7] = 2;
  assert.throws(() => native.inspectDocument(obsolete, password),
    /status 8/);
});
