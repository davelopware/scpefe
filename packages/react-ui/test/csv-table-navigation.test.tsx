// @ts-nocheck -- mounted DOM fixture checks keyboard and clipboard behavior.
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { CsvTable } from "../src/editor/csv-table.tsx";
import { EditorView } from "../src/editor/editor-view.tsx";

function mounted(t) {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>",
    { url: "https://scpefe.invalid/" });
  const keys = ["window", "document", "HTMLElement", "Node", "MutationObserver",
    "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
  const prior = new Map(keys.map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  dom.window.HTMLElement.prototype.attachEvent = () => {};
  dom.window.HTMLElement.prototype.detachEvent = () => {};
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: (callback) => { queueMicrotask(() => callback(0)); return 1; },
    cancelAnimationFrame: () => {}, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root"));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { dom, root };
}

function cell(dom, row, column) {
  return dom.window.document.querySelector(`[data-row="${row}"][data-column="${column}"]`);
}

async function key(dom, target, name, options = {}) {
  await act(async () => target.dispatchEvent(new dom.window.KeyboardEvent("keydown",
    { key: name, bubbles: true, cancelable: true, ...options })));
}

test("CSV cells navigate, copy complete values, and Find searches headings and rows", async (t) => {
  const { dom, root } = mounted(t);
  const value = "long\nvalue";
  const text = 'heading,target\na,"long\nvalue"\nb,other\nc,final';
  let snapshot = { kind: "read-only", document: { content: text, contentType: "csv" },
    working: { text, selection: { start: 0, end: 0 } }, commands: { write: false } };
  const session = { subscribe: () => () => {}, getSnapshot: () => snapshot,
    edit: () => true, setSelection: () => true, undo: () => true, redo: () => true,
    findNext: () => null, replaceSelection: () => null, replaceAll: () => null };
  const view = createRef();
  await act(async () => root.render(<EditorView ref={view} session={session} active
    locked={false} blocked={false} csvView="table" onMessage={() => {}}
    onReturnFocus={() => {}} />));
  const scroll = dom.window.document.querySelector(".csv-table-scroll");
  Object.defineProperty(scroll, "clientHeight", { value: 144 });
  await act(async () => cell(dom, 1, 1).click());
  assert.equal(dom.window.document.activeElement === cell(dom, 1, 1), true, "click focus");
  assert.equal(dom.window.document.querySelector(".csv-focused-value pre").textContent, value);
  const clipboard = new Map();
  const copy = new dom.window.Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(copy, "clipboardData", { value: {
    setData: (type, data) => clipboard.set(type, data) } });
  await act(async () => cell(dom, 1, 1).dispatchEvent(copy));
  assert.equal(clipboard.get("text/plain"), value);
  assert.equal(copy.defaultPrevented, true);
  await key(dom, cell(dom, 1, 1), "ArrowDown");
  assert.equal(dom.window.document.activeElement === cell(dom, 2, 1), true, "down focus");
  await key(dom, cell(dom, 2, 1), "Tab");
  assert.equal(dom.window.document.activeElement === cell(dom, 3, 0), true, "Tab focus");
  await key(dom, cell(dom, 3, 0), "Tab", { shiftKey: true });
  assert.equal(dom.window.document.activeElement === cell(dom, 2, 1), true, "Shift Tab focus");
  await key(dom, cell(dom, 2, 1), "PageUp");
  assert.equal(dom.window.document.activeElement === cell(dom, 0, 1), true, "PageUp focus");
  await key(dom, cell(dom, 0, 1), "PageDown");
  assert.equal(dom.window.document.activeElement?.getAttribute("data-row"), "3", "PageDown row");
  assert.equal(dom.window.document.activeElement?.getAttribute("data-column"), "1", "PageDown column");
  await key(dom, cell(dom, 3, 1), "ArrowDown");
  assert.equal(dom.window.document.activeElement === cell(dom, 3, 1), true, "boundary focus");
  await act(async () => view.current.openFind("find", cell(dom, 3, 1)));
  const input = dom.window.document.querySelector('input');
  const userEvent = (await import("@testing-library/user-event")).default;
  const user = userEvent.setup({ document: dom.window.document });
  await act(async () => user.type(input, "target"));
  assert.equal(dom.window.document.querySelector(".dialog-actions button").disabled, false,
    "typing enables Find next");
  await act(async () => dom.window.document.querySelector(".dialog-actions button").click());
  assert.equal(dom.window.document.querySelector(".modeless-status").textContent,
    "Match focused after wrapping to the start.");
  assert.equal(dom.window.document.activeElement === cell(dom, 0, 1), true,
    "Find wraps to a heading cell");
  await act(async () => user.clear(input));
  await act(async () => user.type(input, "value"));
  await act(async () => dom.window.document.querySelector(".dialog-actions button").click());
  assert.equal(dom.window.document.activeElement === cell(dom, 1, 1), true,
    "Find searches the complete multiline data value");
  assert.equal(dom.window.document.querySelectorAll(".dialog-actions button:disabled").length,
    2, "Replace actions stay disabled in table view");
  snapshot = { ...snapshot, kind: "edit", commands: { write: true } };
  await act(async () => root.render(<EditorView ref={view} session={session} active
    locked={false} blocked={false} csvView="table" onMessage={() => {}}
    onReturnFocus={() => {}} />));
  assert.equal(dom.window.document.querySelectorAll(".dialog-actions button:disabled").length, 2);
  await act(async () => dom.window.document.querySelector(".dialog-actions button:last-child").click());
  assert.equal(dom.window.document.activeElement === cell(dom, 1, 1), true,
    "closing Find leaves the match focused");
  await act(async () => cell(dom, 1, 1).click());
  const editCopy = new dom.window.Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(editCopy, "clipboardData", { value: {
    setData: (type, data) => clipboard.set(type, data) } });
  await act(async () => cell(dom, 1, 1).dispatchEvent(editCopy));
  assert.equal(clipboard.get("text/plain"), value);
});

test("a 1,000 by 30 table renders and navigates to its last value", async (t) => {
  const { dom, root } = mounted(t);
  const rows = Array.from({ length: 1000 }, (_, row) =>
    Array.from({ length: 30 }, (_, column) => `r${row}c${column}`));
  const table = createRef();
  await act(async () => root.render(<CsvTable ref={table} rows={rows} onFind={() => {}} />));
  assert.equal(dom.window.document.querySelector(".csv-table").getAttribute("aria-rowcount"),
    "1001");
  assert.ok(dom.window.document.querySelectorAll(".csv-table td[data-row]").length <= 30 * 30,
    "only viewport rows are mounted");
  const scroll = dom.window.document.querySelector(".csv-table-scroll");
  await act(async () => {
    scroll.scrollTop = 500 * 36;
    scroll.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
  });
  assert.equal(cell(dom, 500, 29)?.textContent, "r500c29",
    "vertical scroll renders a distant row");
  let result;
  await act(async () => { result = table.current.findNext("r999c29"); });
  assert.equal(result, "found");
  assert.equal(dom.window.document.activeElement === cell(dom, 999, 29), true);
  await key(dom, cell(dom, 999, 29), "Tab");
  assert.equal(dom.window.document.activeElement === cell(dom, 999, 29), true,
    "navigation clamps at the last value");
});
