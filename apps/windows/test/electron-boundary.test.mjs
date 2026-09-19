import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("sandboxed Electron loads a bundled CommonJS preload", async () => {
  const main = await fs.readFile(new URL("../src/main.mjs", import.meta.url), "utf8");
  const config = await fs.readFile(
    new URL("../vite.preload.config.ts", import.meta.url), "utf8");
  const preload = await fs.readFile(
    new URL("../dist/preload.cjs", import.meta.url), "utf8");
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /dist["'],\s*["']preload\.cjs/);
  assert.doesNotMatch(main, /preload\.mjs/);
  assert.match(config, /formats:\s*\[["']cjs["']\]/);
  assert.match(config, /external:\s*\[["']electron["']\]/);
  assert.doesNotMatch(preload, /(^|\n)\s*import\s/m);
  assert.match(preload, /require\(["']electron["']\)/);
  assert.match(main, /The exported copy will not be password protected/);
  assert.match(main, /may persist in backups or storage history/);

  let exposed;
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
    ipcRenderer: { invoke: async (channel) => {
      if (channel === "document:create") {
        return { created: true, target: "C:\\Users\\Ada\\secret.scpefe" };
      }
      if (channel === "document:export-plaintext") {
        return { exported: true, target: "C:\\Users\\Ada\\secret.txt" };
      }
      return null;
    } },
  };
  vm.runInNewContext(preload, {
    Buffer,
    require: (identifier) => {
      assert.equal(identifier, "electron");
      return electron;
    },
  });
  assert.deepEqual(Object.keys(exposed), [
    "getProfile", "saveProfile", "createDocument", "openDocument",
    "enterEditMode", "saveDocument", "exportPlaintext",
  ]);
  await assert.rejects(exposed.createDocument({
    ownerPassword: "owner password words",
    recoveryPassword: "",
    content: "hello",
    understandsIrrecoverable: true,
    storedRecoverySeparately: false,
  }), /invalid creation result/);
  await assert.rejects(exposed.exportPlaintext({
    content: "current text only", lineEndings: "lf",
  }), /invalid plaintext export result/);
});
