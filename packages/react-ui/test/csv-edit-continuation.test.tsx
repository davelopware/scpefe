// @ts-nocheck -- mounted DOM fixture checks keyboard focus and editing.
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { CsvTable } from "../src/editor/csv-table.tsx";

test("Enter and Tab from an editor open the destination editor", async (t) => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const prior = new Map(["window", "document", "HTMLElement", "Node",
    "IS_REACT_ACT_ENVIRONMENT"].map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true });
  dom.window.HTMLElement.prototype.attachEvent = () => {};
  dom.window.HTMLElement.prototype.detachEvent = () => {};
  const root = createRoot(dom.window.document.getElementById("root"));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });

  let saved = [["heading", "other"], ["first", "right"], ["below", "next"]];
  function Harness() {
    const [rows, setRows] = useState(saved);
    return <CsvTable rows={rows} readOnly={false} onFind={() => {}}
      onEdit={(next) => { saved = next; setRows(next); }} />;
  }
  const cell = (row, column) => dom.window.document.querySelector(
    `[data-row="${row}"][data-column="${column}"]`);
  const key = async (target, name, options = {}) => act(async () => target.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true,
      cancelable: true, ...options })));
  const userEvent = (await import("@testing-library/user-event")).default;
  const user = userEvent.setup({ document: dom.window.document });
  await act(async () => root.render(<Harness />));
  await act(async () => cell(1, 0).click());
  await key(cell(1, 0), "Enter");
  let editor = dom.window.document.querySelector(".csv-cell-editor");
  assert.equal(dom.window.document.activeElement === editor, true);
  await act(async () => user.clear(editor));
  await act(async () => user.type(editor, "changed"));
  await key(editor, "Enter");
  editor = dom.window.document.querySelector(".csv-cell-editor");
  assert.equal(editor?.closest("[data-row][data-column]") === cell(2, 0), true,
    "Enter opens the destination editor");
  assert.equal(dom.window.document.activeElement === editor, true);
  assert.equal(editor?.value, "below");
  assert.equal(saved[1][0], "changed", "Enter commits the source value");
  await act(async () => user.clear(editor));
  await act(async () => user.type(editor, "down"));
  await key(editor, "Tab");
  editor = dom.window.document.querySelector(".csv-cell-editor");
  assert.equal(editor?.closest("[data-row][data-column]") === cell(2, 1), true,
    "Tab opens the destination editor");
  assert.equal(dom.window.document.activeElement === editor, true);
  assert.equal(editor?.value, "next");
  assert.equal(saved[2][0], "down", "Tab commits the source value");
  await key(editor, "Tab", { shiftKey: true });
  editor = dom.window.document.querySelector(".csv-cell-editor");
  assert.equal(editor?.closest("[data-row][data-column]") === cell(2, 0), true,
    "Shift+Tab opens the previous editor");
  assert.equal(dom.window.document.activeElement === editor, true);
  assert.equal(editor?.value, "down");

  await act(async () => cell(0, 0).click());
  await key(cell(0, 0), "Enter");
  editor = dom.window.document.querySelector(".csv-cell-editor");
  await key(editor, "Tab", { shiftKey: true });
  editor = dom.window.document.querySelector(".csv-cell-editor");
  assert.equal(editor?.closest("[data-row][data-column]") === cell(0, 0), true,
    "reverse traversal remains editing at the first cell");
  assert.equal(dom.window.document.activeElement === editor, true);

  await act(async () => cell(3, 1).click());
  await key(cell(3, 1), "Enter");
  editor = dom.window.document.querySelector(".csv-cell-editor");
  await act(async () => user.type(editor, "inserted"));
  await key(editor, "Tab");
  assert.equal(saved[3][1], "inserted", "Tab saves an insertion row");
  editor = dom.window.document.querySelector(".csv-cell-editor");
  assert.equal(editor?.closest("[data-row][data-column]") === cell(4, 0), true,
    "Tab opens the fresh insertion row after wrapping");
  await key(editor, "Tab");
  editor = dom.window.document.querySelector(".csv-cell-editor");
  assert.equal(editor?.closest("[data-row][data-column]") === cell(4, 1), true);
  await key(editor, "Tab");
  editor = dom.window.document.querySelector(".csv-cell-editor");
  assert.equal(editor?.closest("[data-row][data-column]") === cell(4, 1), true,
    "forward traversal remains editing at the last placeholder cell");
  assert.equal(dom.window.document.activeElement === editor, true);
  await key(editor, "Enter");
  editor = dom.window.document.querySelector(".csv-cell-editor");
  assert.equal(editor?.closest("[data-row][data-column]") === cell(4, 1), true,
    "Enter remains editing at the last empty placeholder cell");

  const manyRows = Array.from({ length: 30 }, (_, row) => [`row ${row}`, `other ${row}`]);
  await act(async () => root.render(<CsvTable rows={manyRows} readOnly={false}
    onFind={() => {}} onEdit={() => {}} />));
  assert.equal(cell(25, 0) === null, true,
    "destination starts beyond the rendered window");
  await act(async () => cell(24, 0).click());
  await key(cell(24, 0), "Enter");
  editor = dom.window.document.querySelector(".csv-cell-editor");
  await key(editor, "Enter");
  editor = dom.window.document.querySelector(".csv-cell-editor");
  assert.equal(editor?.closest("[data-row][data-column]") === cell(25, 0), true,
    "Enter reveals and opens an editor beyond the old viewport");
  assert.equal(dom.window.document.activeElement === editor, true);
});
