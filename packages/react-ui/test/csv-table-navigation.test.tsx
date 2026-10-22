// @ts-nocheck -- mounted DOM fixture checks keyboard and clipboard behavior.
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { CsvTable } from "../src/editor/csv-table.tsx";
import { EditorView } from "../src/editor/editor-view.tsx";
import { MenuBar } from "../src/shell/menu-bar.tsx";
import { createShellCommands } from "../src/shell/shell-commands.ts";
import { parseCsvSource, writeCsvSource } from "@scpefe/frontend-core";

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
  let edited = null;
  session.edit = (source) => { edited = source; return true; };
  await key(dom, cell(dom, 1, 1), "Enter");
  const cellInput = dom.window.document.querySelector(".csv-cell-editor");
  await act(async () => user.clear(cellInput));
  await act(async () => user.type(cellInput, "changed"));
  await key(dom, cellInput, "Enter");
  assert.equal(parseCsvSource(edited).rows[1][1], "changed",
    "table edits reach the session as CSV working-copy text");
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

test("CSV table cell drafts commit, navigate, cancel, and serialize as one value", async (t) => {
  const { dom, root } = mounted(t);
  let saved = writeCsvSource([["name", "name"], ["old", "right"], ["last", "end"]]);
  function Harness({ readOnly = false }) {
    const [rows, setRows] = useState(parseCsvSource(saved).rows);
    return <CsvTable rows={rows} readOnly={readOnly} onFind={() => {}}
      onEdit={(next) => { saved = writeCsvSource(next); setRows(next); }} />;
  }
  await act(async () => root.render(<Harness />));
  const userEvent = (await import("@testing-library/user-event")).default;
  const user = userEvent.setup({ document: dom.window.document });
  await act(async () => cell(dom, 0, 0).click());
  await key(dom, cell(dom, 0, 0), "Enter");
  let input = dom.window.document.querySelector(".csv-cell-editor");
  assert.equal(dom.window.document.activeElement, input);
  await act(async () => user.clear(input));
  await key(dom, input, "Enter");
  assert.equal(cell(dom, 0, 0).textContent, "", "blank heading commits");
  assert.equal(dom.window.document.activeElement, cell(dom, 1, 0), "Enter moves down");
  assert.deepEqual(parseCsvSource(saved).rows[0], ["", "name"]);

  await key(dom, cell(dom, 1, 0), "Enter");
  input = dom.window.document.querySelector(".csv-cell-editor");
  await act(async () => user.clear(input));
  await act(async () => user.paste('comma,\tline\nbreak"quoted'));
  assert.equal(dom.window.document.querySelectorAll(".csv-cell-editor").length, 1,
    "multiline paste stays in one cell");
  await key(dom, input, "Tab");
  assert.equal(dom.window.document.activeElement, cell(dom, 1, 1), "Tab moves right");
  assert.equal(parseCsvSource(saved).rows[1][0], 'comma,\tline\nbreak"quoted');
  await key(dom, cell(dom, 1, 1), "Enter");
  input = dom.window.document.querySelector(".csv-cell-editor");
  await act(async () => user.clear(input));
  await act(async () => user.type(input, "next{Shift>}{Enter}{/Shift}line"));
  await key(dom, input, "Tab");
  assert.equal(parseCsvSource(saved).rows[1][1], "next\nline");
  assert.equal(dom.window.document.activeElement, cell(dom, 2, 0), "Tab wraps");

  await act(async () => cell(dom, 2, 0).dispatchEvent(new dom.window.MouseEvent("dblclick",
    { bubbles: true, cancelable: true })));
  input = dom.window.document.querySelector(".csv-cell-editor");
  await act(async () => user.clear(input));
  await act(async () => user.type(input, "discard"));
  await key(dom, input, "Escape");
  assert.equal(cell(dom, 2, 0).textContent, "last", "Escape cancels");
  await key(dom, cell(dom, 2, 0), "Enter");
  input = dom.window.document.querySelector(".csv-cell-editor");
  await act(async () => user.clear(input));
  await act(async () => user.type(input, "name"));
  await act(async () => cell(dom, 2, 1).click());
  assert.equal(parseCsvSource(saved).rows[2][0], "name", "click away commits");
  await key(dom, cell(dom, 2, 1), "Delete");
  assert.equal(parseCsvSource(saved).rows[2][1], "", "Delete clears");
  await act(async () => user.type(cell(dom, 2, 1), "ignored"));
  assert.equal(parseCsvSource(saved).rows[2][1], "", "typing outside edit does nothing");

  await key(dom, cell(dom, 2, 1), "Enter");
  input = dom.window.document.querySelector(".csv-cell-editor");
  await act(async () => user.type(input, "unsaved draft"));
  await act(async () => root.render(<Harness readOnly />));
  assert.equal(dom.window.document.querySelector(".csv-cell-editor"), null,
    "losing edit mode removes the open cell editor");
  assert.equal(parseCsvSource(saved).rows[2][1], "", "read-only transition cancels draft");

  const reopened = parseCsvSource(saved);
  assert.equal(reopened.valid, true);
  await act(async () => root.render(<CsvTable rows={reopened.rows} readOnly onFind={() => {}} />));
  await key(dom, cell(dom, 0, 1), "Enter");
  await key(dom, cell(dom, 0, 1), "Delete");
  assert.equal(dom.window.document.querySelector(".csv-cell-editor"), null);
  assert.equal(cell(dom, 0, 1).textContent, "name", "read-only cells stay unchanged");
});

test("new CSV heading is ready to type and an untouched insertion row stays out of source", async (t) => {
  const { dom, root } = mounted(t);
  let saved = '""';
  let edits = 0;
  const table = createRef();
  function Harness() {
    const [rows, setRows] = useState(parseCsvSource(saved).rows);
    return <CsvTable ref={table} rows={rows} readOnly={false} onFind={() => {}}
      onEdit={(next) => { edits += 1; saved = writeCsvSource(next); setRows(next); }} />;
  }
  await act(async () => root.render(<Harness />));
  const userEvent = (await import("@testing-library/user-event")).default;
  const user = userEvent.setup({ document: dom.window.document });
  let input = dom.window.document.querySelector(".csv-cell-editor");
  assert.equal(dom.window.document.activeElement, input, "blank first heading is editing");
  assert.equal(input.getAttribute("aria-label"), "Edit heading, column 1");
  await act(async () => table.current.focus());
  assert.equal(dom.window.document.activeElement, input,
    "creation flow focus restoration preserves the open heading editor");
  await act(async () => user.type(input, "name"));
  await key(dom, input, "Enter");
  assert.deepEqual(parseCsvSource(saved).rows, [["name"]]);
  assert.equal(dom.window.document.activeElement, cell(dom, 1, 0),
    "Enter reaches the insertion row from the heading");
  await key(dom, cell(dom, 1, 0), "Enter");
  input = dom.window.document.querySelector(".csv-cell-editor");
  assert.equal(dom.window.document.activeElement, input);
  await key(dom, input, "Enter");
  assert.equal(edits, 1, "leaving an empty insertion draft makes no edit");
  assert.equal(dom.window.document.querySelectorAll(".csv-insertion-placeholder").length, 1);
  await key(dom, cell(dom, 1, 0), "Enter");
  input = dom.window.document.querySelector(".csv-cell-editor");
  await act(async () => user.type(input, "Ada"));
  await key(dom, input, "Enter");
  assert.deepEqual(parseCsvSource(saved).rows, [["name"], ["Ada"]]);
  assert.equal(dom.window.document.activeElement, cell(dom, 2, 0),
    "Enter advances to the fresh insertion row");
  assert.equal(dom.window.document.querySelectorAll(".csv-insertion-placeholder").length, 1);
  assert.equal(dom.window.document.querySelectorAll(".csv-table tbody tr").length, 2,
    "one real row and one placeholder are rendered");
});

test("Tab reaches insertion cells while saved empty rows remain distinct", async (t) => {
  const { dom, root } = mounted(t);
  let saved = writeCsvSource([["a", "b"], ["", ""]]);
  let edits = 0;
  function Harness({ readOnly = false }) {
    const [rows, setRows] = useState(parseCsvSource(saved).rows);
    return <CsvTable rows={rows} readOnly={readOnly} onFind={() => {}}
      onEdit={(next) => { edits += 1; saved = writeCsvSource(next); setRows(next); }} />;
  }
  await act(async () => root.render(<Harness />));
  assert.equal(cell(dom, 1, 0)?.closest("tr")?.classList.contains("csv-insertion-placeholder"),
    false, "saved empty data row remains a real row");
  await act(async () => cell(dom, 1, 1).click());
  await key(dom, cell(dom, 1, 1), "Tab");
  assert.equal(dom.window.document.activeElement, cell(dom, 2, 0));
  await key(dom, cell(dom, 2, 0), "Tab");
  assert.equal(dom.window.document.activeElement, cell(dom, 2, 1));
  assert.equal(edits, 0, "traversal creates no data");
  await key(dom, cell(dom, 2, 1), "Enter");
  let input = dom.window.document.querySelector(".csv-cell-editor");
  const userEvent = (await import("@testing-library/user-event")).default;
  const user = userEvent.setup({ document: dom.window.document });
  await act(async () => user.type(input, "new"));
  await key(dom, input, "Tab");
  assert.deepEqual(parseCsvSource(saved).rows, [["a", "b"], ["", ""], ["", "new"]]);
  assert.equal(dom.window.document.activeElement, cell(dom, 3, 0),
    "Tab advances to a fresh placeholder after inserting");
  await act(async () => cell(dom, 2, 1).click());
  await key(dom, cell(dom, 2, 1), "Delete");
  assert.deepEqual(parseCsvSource(saved).rows, [["a", "b"], ["", ""], ["", ""]],
    "clearing an existing row retains it");
  const reopened = parseCsvSource(saved);
  await act(async () => root.render(<CsvTable rows={reopened.rows} readOnly
    onFind={() => {}} />));
  assert.equal(cell(dom, 2, 0)?.closest("tr")?.classList.contains("csv-insertion-placeholder"),
    false, "reopened empty data remains distinct");
  assert.equal(dom.window.document.querySelectorAll(".csv-insertion-placeholder").length, 1);
  const clipboard = new Map();
  const copy = new dom.window.Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(copy, "clipboardData", { value: {
    setData: (type, data) => clipboard.set(type, data) } });
  await act(async () => cell(dom, 0, 0).click());
  await act(async () => cell(dom, 0, 0).dispatchEvent(copy));
  assert.equal(clipboard.get("text/plain"), "a");
  assert.equal(dom.window.document.activeElement, cell(dom, 0, 0));
  assert.equal(edits, 2, "read-only focus and copy create no rows");
});

test("cell editing keeps Find and Save shortcuts available and saves the current draft", async (t) => {
  const { dom, root } = mounted(t);
  const initial = writeCsvSource([["heading"], ["before"]]);
  let snapshot = { kind: "edit", adoption: 1,
    document: { content: initial, contentType: "csv" },
    working: { text: initial, selection: { start: 0, end: 0 } },
    commands: { write: true, save: true } };
  const listeners = new Set();
  const saved = [];
  const session = { subscribe: (listener) => { listeners.add(listener);
      return () => listeners.delete(listener); }, getSnapshot: () => snapshot,
    edit: (text) => { snapshot = { ...snapshot, working: { ...snapshot.working, text } };
      for (const listener of listeners) listener(); return true; },
    setSelection: () => true, undo: () => true, redo: () => true,
    findNext: () => null, replaceSelection: () => null, replaceAll: () => null };
  const commands = createShellCommands({ session,
    facts: () => ({ activeAdoption: 1, profileReady: true, modalBusy: false,
      csvView: "table" }),
    run: (command) => { if (command === "save") saved.push(session.getSnapshot().working.text); },
    track: async (operation) => { await operation(); } });
  function Harness() {
    const current = useSyncExternalStore(session.subscribe, session.getSnapshot,
      session.getSnapshot);
    return <><MenuBar snapshot={current} commands={commands} />
      <EditorView session={session} active locked={false} blocked={false}
        csvView="table" onMessage={() => {}} onReturnFocus={() => {}}
        onSave={() => { void commands.invoke("save"); }} /></>;
  }
  await act(async () => root.render(<Harness />));
  const userEvent = (await import("@testing-library/user-event")).default;
  const user = userEvent.setup({ document: dom.window.document });
  await act(async () => cell(dom, 1, 0).click());
  await key(dom, cell(dom, 1, 0), "Enter");
  let input = dom.window.document.querySelector(".csv-cell-editor");
  await act(async () => user.clear(input));
  await act(async () => user.type(input, "find me"));
  await key(dom, input, "f", { ctrlKey: true });
  assert.ok(dom.window.document.querySelector('[role="dialog"]'),
    "Ctrl+F opens Find while a cell draft is focused");
  assert.equal(parseCsvSource(snapshot.working.text).rows[1][0], "find me",
    "moving focus to Find commits the cell draft");
  await act(async () => dom.window.document.querySelector('.dialog-actions button:last-child').click());

  await key(dom, cell(dom, 1, 0), "Enter");
  input = dom.window.document.querySelector(".csv-cell-editor");
  await act(async () => user.clear(input));
  await act(async () => user.type(input, "save this draft"));
  await key(dom, input, "s", { ctrlKey: true });
  assert.equal(saved.length, 1, "Ctrl+S invokes Save exactly once");
  assert.equal(parseCsvSource(saved[0]).rows[1][0], "save this draft",
    "Save receives the committed draft");
  assert.equal(dom.window.document.querySelector(".csv-cell-editor"), null);
});
