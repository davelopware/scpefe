import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("main process removes Electron's native menu before creating the window", async () => {
  const main = await fs.readFile(new URL("../src/main.mjs", import.meta.url), "utf8");
  const menuRemoval = main.indexOf("Menu.setApplicationMenu(null)");
  const windowCreation = main.indexOf("new BrowserWindow(");

  assert.notEqual(menuRemoval, -1, "the default native application menu must be removed");
  assert.notEqual(windowCreation, -1, "the main process must create its BrowserWindow");
  assert.equal(menuRemoval < windowCreation, true,
    "the native menu must be removed before the BrowserWindow can become visible");
  assert.doesNotMatch(main, /autoHideMenuBar\s*:\s*true/,
    "auto-hide would leave Electron's menu and shortcuts reachable with Alt");
});

test("development and packaged launches use the menu-free main process", async () => {
  const packageManifest = JSON.parse(await fs.readFile(
    new URL("../package.json", import.meta.url), "utf8"));
  const packaging = await fs.readFile(
    new URL("../../../scripts/build-windows-preview.ps1", import.meta.url), "utf8");

  assert.equal(packageManifest.main, "src/main.mjs");
  assert.equal(packageManifest.scripts.start, "electron .");
  assert.match(packaging,
    /Copy-Item \(Join-Path \$WindowsRoot "package\.json"\) \$AppRoot/);
  assert.match(packaging,
    /Copy-Item \(Join-Path \$WindowsRoot "src"\), \(Join-Path \$WindowsRoot "dist"\), \$NativeRoot/);
});
