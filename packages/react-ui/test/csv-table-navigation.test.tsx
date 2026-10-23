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
  const frames = new Map();
  let nextFrame = 0;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: (callback) => {
      const token = ++nextFrame;
      frames.set(token, callback);
      queueMicrotask(() => {
        const pending = frames.get(token);
        if (pending) { frames.delete(token); pending(0); }
      });
      return token;
    },
    cancelAnimationFrame: (token) => frames.delete(token), IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root"));
  t.after(async () => {
    await act(async () => root.unmount());
    frames.clear();
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
  assert.equal(dom.window.document.querySelector('.find-match-count')?.textContent, '0 / 1');
  assert.equal(dom.window.document.querySelector(".dialog-actions button").disabled, false,
    "typing enables Find next");
  await act(async () => dom.window.document.querySelector(".dialog-actions button").click());
  assert.equal(dom.window.document.querySelector(".modeless-status").textContent,
    "Match selected in heading, column 2 after wrapping to the start.");
  assert.equal(dom.window.document.activeElement === input, true,
    "Find keeps keyboard focus in its field");
  assert.equal(cell(dom, 0, 1).getAttribute('data-current-cell'), 'true');
  assert.equal(dom.window.document.querySelector('.find-match-count')?.textContent, '1 / 1');
  await act(async () => user.clear(input));
  await act(async () => user.type(input, "value"));
  assert.equal(dom.window.document.querySelector('.find-match-count')?.textContent, '0 / 1');
  await key(dom, input, 'Enter');
  assert.equal(dom.window.document.activeElement === input, true);
  assert.equal(cell(dom, 1, 1).getAttribute('data-current-cell'), 'true',
    "Find searches the complete multiline data value");
  assert.equal(dom.window.document.querySelector('.csv-focused-value pre')?.textContent, value);
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
  assert.deepEqual(result, { status: "found", current: 1, row: 999, column: 29 });
  assert.equal(cell(dom, 999, 29)?.getAttribute('data-current-cell'), 'true');
  assert.ok(scroll.scrollTop > 0, 'distant match scrolls into the viewport');
  await act(async () => table.current.focus());
  assert.equal(dom.window.document.activeElement === cell(dom, 999, 29), true);
  await key(dom, cell(dom, 999, 29), "Tab");
  assert.equal(dom.window.document.activeElement === cell(dom, 999, 29), true,
    "navigation clamps at the last value");
});

test("table Find counts cells, wraps in table order, and resets after manual selection", async (t) => {
  const { dom, root } = mounted(t);
  const text = 'match,other\nMATCH match,x\nno,match';
  const snapshot = { kind: 'read-only', document: { content: text, contentType: 'csv' },
    working: { text, selection: { start: 0, end: 0 } }, commands: { write: false } };
  const session = { subscribe: () => () => {}, getSnapshot: () => snapshot,
    edit: () => false, setSelection: () => false, undo: () => false, redo: () => false,
    findNext: () => null, replaceSelection: () => null, replaceAll: () => null };
  const view = createRef();
  await act(async () => root.render(<EditorView ref={view} session={session} active
    locked={false} blocked={false} csvView="table" onMessage={() => {}}
    onReturnFocus={() => {}} />));
  await act(async () => view.current.openFind('find', cell(dom, 0, 0)));
  const input = dom.window.document.querySelector('input');
  const userEvent = (await import('@testing-library/user-event')).default;
  const user = userEvent.setup({ document: dom.window.document });
  await act(async () => user.type(input, 'MaTcH'));
  const count = () => dom.window.document.querySelector('.find-match-count')?.textContent;
  assert.equal(count(), '0 / 3');
  await key(dom, input, 'Enter');
  assert.equal(count(), '2 / 3');
  assert.equal(cell(dom, 1, 0).getAttribute('data-current-cell'), 'true');
  assert.equal(dom.window.document.querySelector('.csv-focused-value pre')?.textContent,
    'MATCH match');
  await key(dom, input, 'Enter');
  assert.equal(count(), '3 / 3');
  assert.equal(cell(dom, 2, 1).getAttribute('data-current-cell'), 'true');
  await key(dom, input, 'Enter');
  assert.equal(count(), '1 / 3');
  assert.equal(cell(dom, 0, 0).getAttribute('data-current-cell'), 'true');
  await act(async () => cell(dom, 2, 0).click());
  assert.equal(count(), '0 / 3');
  await act(async () => input.focus());
  await key(dom, input, 'Enter');
  assert.equal(count(), '3 / 3');
  await act(async () => user.clear(input));
  await act(async () => user.type(input, 'missing'));
  assert.equal(count(), '0 / 0');
  await key(dom, input, 'Enter');
  assert.equal(count(), '0 / 0');
  await act(async () => user.type(input, '{Control>}a{/Control}{Backspace}'));
  assert.equal(input.value, '');
  assert.equal(count(), undefined);
});

test("table Find reveals matches below the sticky heading and clear of the dialog", async (t) => {
  const { dom, root } = mounted(t);
  const rows = Array.from({ length: 16 }, (_, row) =>
    Array.from({ length: 8 }, (_, column) => row === 2 && column === 1
      ? 'STICKY-TARGET' : row === 12 && column === 7
        ? 'DIALOG-TARGET' : `row ${row}, column ${column + 1}`));
  rows[0] = ['Name', 'Note', 'Extra', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Far right'];
  const text = writeCsvSource(rows);
  const snapshot = { kind: 'read-only', document: { content: text, contentType: 'csv' },
    working: { text, selection: { start: 0, end: 0 } }, commands: { write: false } };
  const session = { subscribe: () => () => {}, getSnapshot: () => snapshot,
    edit: () => false, setSelection: () => false, undo: () => false, redo: () => false,
    findNext: () => null, replaceSelection: () => null, replaceAll: () => null };
  const view = createRef();
  await act(async () => root.render(<EditorView ref={view} session={session} active
    locked={false} blocked={false} csvView="table" onMessage={() => {}}
    onReturnFocus={() => {}} />));
  await act(async () => view.current.openFind('find', cell(dom, 0, 0)));
  const document = dom.window.document;
  const scroll = document.querySelector('.csv-table-scroll');
  const headingSection = document.querySelector('.csv-table thead');
  const heading = document.querySelector('.csv-table th');
  const dialog = document.querySelector('.modeless-dialog');
  const bounds = (left, top, right, bottom) => ({ left, top, right, bottom,
    width: right - left, height: bottom - top });
  scroll.getBoundingClientRect = () => bounds(0, 31, 920, 616);
  headingSection.getBoundingClientRect = () => bounds(14, -8, 890, 28);
  heading.getBoundingClientRect = () => bounds(14, 43, 233, 79);
  dialog.getBoundingClientRect = () => bounds(434, 470, 910, 650);
  const nearHeading = cell(dom, 2, 1);
  nearHeading.getBoundingClientRect = () =>
    bounds(452 - scroll.scrollLeft, 115 - scroll.scrollTop,
      891 - scroll.scrollLeft, 151 - scroll.scrollTop);
  const underDialog = cell(dom, 12, 7);
  underDialog.getBoundingClientRect = () =>
    bounds(1350 - scroll.scrollLeft, 500 - scroll.scrollTop,
      1542 - scroll.scrollLeft, 536 - scroll.scrollTop);
  const userEvent = (await import('@testing-library/user-event')).default;
  const user = userEvent.setup({ document });
  const input = document.querySelector('input');
  await act(async () => user.type(input, 'STICKY-TARGET'));
  await act(async () => {
    scroll.scrollTop = 51;
    scroll.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
  });
  await key(dom, input, 'Enter');
  assert.equal(document.activeElement === input, true);
  assert.equal(nearHeading.getAttribute('data-current-cell'), 'true');
  assert.ok(nearHeading.getBoundingClientRect().top >= heading.getBoundingClientRect().bottom,
    'the current cell is fully below the sticky heading');

  await act(async () => user.clear(input));
  await act(async () => user.type(input, 'DIALOG-TARGET'));
  await act(async () => {
    scroll.scrollTop = 0; scroll.scrollLeft = 0;
    scroll.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
  });
  await key(dom, input, 'Enter');
  assert.equal(underDialog.getAttribute('data-current-cell'), 'true');
  assert.ok(scroll.scrollLeft > 0, 'the far-right match is scrolled horizontally into view');
  assert.ok(underDialog.getBoundingClientRect().right <= scroll.getBoundingClientRect().right,
    'the entire far-right match is inside the visible scroller');
  assert.ok(underDialog.getBoundingClientRect().bottom <= dialog.getBoundingClientRect().top,
    'the match remains clear of the dialog after horizontal scrolling');
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
  assert.equal(dom.window.document.activeElement === input, true);
  await act(async () => user.clear(input));
  // A key edit makes the mounted React change tracker observe the empty value.
  await act(async () => user.type(input, "!"));
  await act(async () => user.keyboard("{Backspace}"));
  assert.equal(dom.window.document.activeElement === input, true,
    "clearing leaves the editor focused");
  await key(dom, input, "Enter");
  assert.equal(cell(dom, 0, 0).textContent, "", "blank heading commits");
  input = dom.window.document.querySelector(".csv-cell-editor");
  assert.equal(input?.closest("[data-row][data-column]") === cell(dom, 1, 0), true,
    "Enter opens the cell below");
  assert.equal(dom.window.document.activeElement === input, true);
  assert.deepEqual(parseCsvSource(saved).rows[0], ["", "name"]);

  await act(async () => user.clear(input));
  await act(async () => user.paste('comma,\tline\nbreak"quoted'));
  // Flush the pasted value through a key edit in this JSDOM fixture.
  await act(async () => user.type(input, "!"));
  await act(async () => user.keyboard("{Backspace}"));
  assert.equal(dom.window.document.querySelectorAll(".csv-cell-editor").length, 1,
    "multiline paste stays in one cell");
  await key(dom, input, "Tab");
  input = dom.window.document.querySelector(".csv-cell-editor");
  assert.equal(input?.closest("[data-row][data-column]") === cell(dom, 1, 1), true,
    "Tab opens the cell to the right");
  assert.equal(dom.window.document.activeElement === input, true);
  assert.equal(parseCsvSource(saved).rows[1][0], 'comma,\tline\nbreak"quoted');
  await act(async () => user.clear(input));
  await act(async () => user.type(input, "next{Shift>}{Enter}{/Shift}line"));
  await key(dom, input, "Tab");
  assert.equal(parseCsvSource(saved).rows[1][1], "next\nline");
  input = dom.window.document.querySelector(".csv-cell-editor");
  assert.equal(input?.closest("[data-row][data-column]") === cell(dom, 2, 0), true,
    "Tab wraps and opens the next editor");
  assert.equal(dom.window.document.activeElement === input, true);

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
  assert.equal(dom.window.document.activeElement === input, true,
    "blank first heading is editing");
  assert.equal(input.getAttribute("aria-label"), "Edit heading, column 1");
  await act(async () => table.current.focus());
  assert.equal(dom.window.document.activeElement === input, true,
    "creation flow focus restoration preserves the open heading editor");
  await act(async () => user.type(input, "name"));
  await key(dom, input, "Enter");
  assert.deepEqual(parseCsvSource(saved).rows, [["name"]]);
  input = dom.window.document.querySelector(".csv-cell-editor");
  assert.equal(input?.closest("[data-row][data-column]") === cell(dom, 1, 0), true,
    "Enter opens the insertion row from the heading");
  assert.equal(dom.window.document.activeElement === input, true);
  await key(dom, input, "Enter");
  assert.equal(edits, 1, "leaving an empty insertion draft makes no edit");
  assert.equal(dom.window.document.querySelectorAll(".csv-insertion-placeholder").length, 1);
  input = dom.window.document.querySelector(".csv-cell-editor");
  await act(async () => user.type(input, "Ada"));
  await key(dom, input, "Enter");
  assert.deepEqual(parseCsvSource(saved).rows, [["name"], ["Ada"]]);
  input = dom.window.document.querySelector(".csv-cell-editor");
  assert.equal(input?.closest("[data-row][data-column]") === cell(dom, 2, 0), true,
    "Enter opens the fresh insertion row");
  assert.equal(dom.window.document.activeElement === input, true);
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
  assert.equal(dom.window.document.activeElement === cell(dom, 2, 0), true);
  await key(dom, cell(dom, 2, 0), "Tab");
  assert.equal(dom.window.document.activeElement === cell(dom, 2, 1), true);
  assert.equal(edits, 0, "traversal creates no data");
  await key(dom, cell(dom, 2, 1), "Enter");
  let input = dom.window.document.querySelector(".csv-cell-editor");
  const userEvent = (await import("@testing-library/user-event")).default;
  const user = userEvent.setup({ document: dom.window.document });
  await act(async () => user.type(input, "new"));
  await key(dom, input, "Tab");
  assert.deepEqual(parseCsvSource(saved).rows, [["a", "b"], ["", ""], ["", "new"]]);
  input = dom.window.document.querySelector(".csv-cell-editor");
  assert.equal(input?.closest("[data-row][data-column]") === cell(dom, 3, 0), true,
    "Tab opens a fresh placeholder after inserting");
  assert.equal(dom.window.document.activeElement === input, true);
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
  assert.equal(dom.window.document.activeElement === cell(dom, 0, 0), true);
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

test("Table structure commands preserve rectangular saved rows and focus their result", async (t) => {
  const { dom, root } = mounted(t);
  let saved = writeCsvSource([["name", "age"], ["Ada", "36"], ["Bob", "41"]]);
  const table = createRef();
  const confirmations = [];
  dom.window.confirm = (message) => { confirmations.push(message); return false; };
  function Harness({ readOnly = false }) {
    const [rows, setRows] = useState(parseCsvSource(saved).rows);
    return <CsvTable ref={table} rows={rows} readOnly={readOnly} onFind={() => {}}
      onEdit={(next) => { saved = writeCsvSource(next); setRows(next); }} />;
  }
  await act(async () => root.render(<Harness />));
  const run = async (command) => act(async () => table.current.runCommand(command));
  const focus = async (row, column) => act(async () => cell(dom, row, column).click());
  const assertFocus = (row, column) => assert.equal(dom.window.document.activeElement ===
    cell(dom, row, column), true, `${row}:${column} focused`);
  const assertShape = () => {
    const parsed = parseCsvSource(saved);
    assert.equal(parsed.valid, true);
    assert.equal(new Set(parsed.rows.map((values) => values.length)).size, 1);
    assert.equal(dom.window.document.querySelectorAll(".csv-insertion-placeholder").length, 1);
  };

  await focus(0, 0);
  await run("add-row-above");
  await run("delete-row");
  assert.deepEqual(parseCsvSource(saved).rows, [["name", "age"], ["Ada", "36"],
    ["Bob", "41"]], "heading cannot be inserted above or deleted");
  await run("add-row-below");
  assert.deepEqual(parseCsvSource(saved).rows[1], ["", ""]);
  assertFocus(1, 0);
  assertShape();
  assert.equal(cell(dom, 1, 0).closest("tr").classList.contains("csv-insertion-placeholder"),
    false, "explicit empty row is saved");

  await run("add-row-below");
  assertFocus(2, 0);
  await run("add-row-above");
  assertFocus(2, 0);
  await run("delete-row");
  assertFocus(2, 0, "deleting a row focuses the row below");
  await focus(4, 1);
  await run("delete-row");
  assert.equal(confirmations.length, 1, "nonempty row asks for confirmation");
  assertFocus(4, 1);
  dom.window.confirm = (message) => { confirmations.push(message); return true; };
  await run("delete-row");
  assertFocus(3, 1, "deleting last row focuses above");
  assertShape();

  await focus(0, 0);
  await run("add-column-left");
  assertFocus(0, 0);
  assert.deepEqual(parseCsvSource(saved).rows[0], ["", "name", "age"]);
  await focus(0, 2);
  await run("add-column-right");
  assertFocus(0, 3);
  assertShape();
  await run("delete-column");
  assertFocus(0, 2, "deleting last column focuses left");
  await focus(1, 1);
  dom.window.confirm = (message) => { confirmations.push(message); return false; };
  await run("delete-column");
  assert.equal(parseCsvSource(saved).rows[0][1], "name", "cancel keeps column");
  dom.window.confirm = (message) => { confirmations.push(message); return true; };
  await run("delete-column");
  assertFocus(1, 1, "deleting middle column focuses right");
  assert.deepEqual(parseCsvSource(saved).rows[0], ["", "age"]);
  await focus(parseCsvSource(saved).rows.length, 0);
  const before = saved;
  await run("add-row-below");
  await run("delete-row");
  assert.equal(saved, before, "insertion placeholder cannot receive row commands");
  await run("delete-column");
  assert.equal(parseCsvSource(saved).rows[0].length, 1,
    "column command works from insertion placeholder");
  await run("delete-column");
  assert.equal(parseCsvSource(saved).rows[0].length, 1, "last column cannot be deleted");
  assertShape();
  const reopened = parseCsvSource(saved);
  await act(async () => root.render(<CsvTable rows={reopened.rows} readOnly
    onFind={() => {}} />));
  assert.equal(cell(dom, 1, 0).closest("tr").classList.contains("csv-insertion-placeholder"),
    false, "added empty data row survives reopening");
});

test("Table menu enables focused structure actions and dispatches them to the table", async (t) => {
  const { dom, root } = mounted(t);
  const table = createRef();
  let saved = writeCsvSource([["name", "age"], ["Ada", "36"]]);
  function Harness({ readOnly = false }) {
    const [rows, setRows] = useState(parseCsvSource(saved).rows);
    const [focus, setFocus] = useState(null);
    const snapshot = { kind: readOnly ? "read-only" : "edit", adoption: 1,
      document: { contentType: "csv" }, working: { text: saved },
      commands: { write: !readOnly } };
    const commands = createShellCommands({ session: { getSnapshot: () => snapshot,
      subscribe: () => () => {} }, facts: () => ({ activeAdoption: 1,
      profileReady: true, modalBusy: false, csvView: "table", tableFocus: focus }),
    run: (command) => table.current.runCommand(command),
    track: async (operation) => { await operation(); } });
    return <><MenuBar snapshot={snapshot} commands={commands} />
      <CsvTable ref={table} rows={rows} readOnly={readOnly} onFind={() => {}}
        onFocusChange={(next) => setFocus((current) => current?.row === next.row
          && current.column === next.column ? current : next)}
        onEdit={(next) => { saved = writeCsvSource(next); setRows(next); }} /></>;
  }
  await act(async () => root.render(<Harness />));
  const menu = async () => act(async () =>
    dom.window.document.querySelector('button[aria-label="Table"]').click());
  const action = (label) => [...dom.window.document.querySelectorAll(
    '[role="menu"][aria-label="Table"] button')].find((button) =>
    button.textContent === label);
  await menu();
  assert.equal(action("Add Row Below").disabled, true, "no focused cell");
  await act(async () => cell(dom, 0, 1).click());
  await menu();
  assert.equal(action("Add Row Above").disabled, true, "heading guard");
  assert.equal(action("Add Row Below").disabled, false);
  assert.equal(action("Sort Asc").disabled, true, "one data row cannot be sorted");
  await act(async () => action("Add Row Below").click());
  assert.deepEqual(parseCsvSource(saved).rows[1], ["", ""]);
  assert.equal(dom.window.document.activeElement === cell(dom, 1, 1), true);
  await menu();
  assert.equal(action("Delete Row").disabled, false, "new data row can be deleted");
  await act(async () => cell(dom, 0, 1).click());
  await menu();
  assert.equal(action("Sort Asc").disabled, false, "two data rows can be sorted");
  await act(async () => dom.window.document.querySelector('button[aria-label="Table"]').click());
  await act(async () => root.render(<Harness readOnly />));
  await menu();
  assert.equal(action("Sort Asc").disabled, true, "read-only mode");
  assert.equal(action("Sort Desc").disabled, true, "read-only mode");
});

test("Table menu sorts complete CSV data rows by the focused heading", async (t) => {
  const { dom, root } = mounted(t);
  const table = createRef();
  let saved = writeCsvSource([["name", "rank"], ["Zoe", "2"],
    ["Ada", "10"], ["Bea", "1"]]);
  function Harness() {
    const [rows, setRows] = useState(parseCsvSource(saved).rows);
    const [focus, setFocus] = useState(null);
    const snapshot = { kind: "edit", adoption: 1,
      document: { contentType: "csv" }, working: { text: saved },
      commands: { write: true } };
    const commands = createShellCommands({ session: { getSnapshot: () => snapshot,
      subscribe: () => () => {} }, facts: () => ({ activeAdoption: 1,
      profileReady: true, modalBusy: false, csvView: "table", tableFocus: focus }),
    run: (command) => table.current.runCommand(command),
    track: async (operation) => { await operation(); } });
    return <><MenuBar snapshot={snapshot} commands={commands} />
      <CsvTable ref={table} rows={rows} readOnly={false} onFind={() => {}}
        onFocusChange={(next) => setFocus((current) => current?.row === next.row
          && current.column === next.column ? current : next)}
        onEdit={(next) => { saved = writeCsvSource(next); setRows(next); }} /></>;
  }
  await act(async () => root.render(<Harness />));
  await act(async () => dom.window.document.querySelector('button[aria-label="Table"]').click());
  let action = [...dom.window.document.querySelectorAll(
    '[role="menu"][aria-label="Table"] button')].find((button) =>
    button.textContent === "Sort Asc");
  assert.equal(action?.disabled, true, "no selected heading");
  await act(async () => dom.window.document.querySelector('button[aria-label="Table"]').click());
  await act(async () => cell(dom, 0, 1).click());
  await act(async () => dom.window.document.querySelector('button[aria-label="Table"]').click());
  action = [...dom.window.document.querySelectorAll(
    '[role="menu"][aria-label="Table"] button')].find((button) =>
    button.textContent === "Sort Asc");
  assert.equal(action?.disabled, false);
  await act(async () => action.click());
  assert.deepEqual(parseCsvSource(saved).rows, [["name", "rank"],
    ["Bea", "1"], ["Ada", "10"], ["Zoe", "2"]]);
  assert.equal(dom.window.document.querySelectorAll(".csv-insertion-placeholder").length, 1);

  await act(async () => cell(dom, 1, 1).click());
  await act(async () => dom.window.document.querySelector('button[aria-label="Table"]').click());
  assert.equal([...dom.window.document.querySelectorAll(
    '[role="menu"][aria-label="Table"] button')].find((button) =>
    button.textContent === "Sort Desc")?.disabled, true, "data cell selection");
  await act(async () => dom.window.document.querySelector('button[aria-label="Table"]').click());
  await act(async () => cell(dom, 4, 1).click());
  await act(async () => dom.window.document.querySelector('button[aria-label="Table"]').click());
  assert.equal([...dom.window.document.querySelectorAll(
    '[role="menu"][aria-label="Table"] button')].find((button) =>
    button.textContent === "Sort Asc")?.disabled, true, "insertion row selection");
  await act(async () => dom.window.document.querySelector('button[aria-label="Table"]').click());

  await act(async () => cell(dom, 0, 1).click());
  await key(dom, cell(dom, 0, 1), "Enter");
  const userEvent = (await import("@testing-library/user-event")).default;
  const user = userEvent.setup({ document: dom.window.document });
  const input = dom.window.document.querySelector(".csv-cell-editor");
  await act(async () => user.clear(input));
  await act(async () => user.type(input, "order"));
  await act(async () => dom.window.document.querySelector('button[aria-label="Table"]').click());
  assert.equal(parseCsvSource(saved).rows[0][1], "order", "opening the menu commits the heading");
  action = [...dom.window.document.querySelectorAll(
    '[role="menu"][aria-label="Table"] button')].find((button) =>
    button.textContent === "Sort Desc");
  assert.equal(action?.disabled, false);
  await act(async () => action.click());
  assert.deepEqual(parseCsvSource(saved).rows, [["name", "order"],
    ["Zoe", "2"], ["Ada", "10"], ["Bea", "1"]]);
});

test("Table sort compares trimmed English text and keeps stable ties and blank keys last", async (t) => {
  const { dom, root } = mounted(t);
  const table = createRef();
  let saved = writeCsvSource([["name", "name", ""], ["A", "  a  ", "8"],
    ["B", "á", "7"], ["C", "A", "6"], ["D", "10", "5"],
    ["E", "2", "4"], ["F", " ", "3"], ["G", "", "2"], ["H", "a", "1"]]);
  function Harness() {
    const [rows, setRows] = useState(parseCsvSource(saved).rows);
    const [focus, setFocus] = useState(null);
    const snapshot = { kind: "edit", adoption: 1,
      document: { contentType: "csv" }, working: { text: saved },
      commands: { write: true } };
    const commands = createShellCommands({ session: { getSnapshot: () => snapshot,
      subscribe: () => () => {} }, facts: () => ({ activeAdoption: 1,
      profileReady: true, modalBusy: false, csvView: "table", tableFocus: focus }),
    run: (command) => table.current.runCommand(command),
    track: async (operation) => { await operation(); } });
    return <><MenuBar snapshot={snapshot} commands={commands} />
      <CsvTable ref={table} rows={rows} readOnly={false} onFind={() => {}}
        onFocusChange={(next) => setFocus((current) => current?.row === next.row
          && current.column === next.column ? current : next)}
        onEdit={(next) => { saved = writeCsvSource(next); setRows(next); }} /></>;
  }
  await act(async () => root.render(<Harness />));
  const sort = async (label) => {
    await act(async () => dom.window.document.querySelector('button[aria-label="Table"]').click());
    const action = [...dom.window.document.querySelectorAll(
      '[role="menu"][aria-label="Table"] button')].find((button) =>
      button.textContent === label);
    assert.equal(action?.disabled, false);
    await act(async () => action.click());
  };
  const names = () => parseCsvSource(saved).rows.slice(1).map((row) => row[0]);
  await act(async () => cell(dom, 0, 1).click());
  await sort("Sort Asc");
  assert.deepEqual(names(), ["D", "E", "A", "C", "H", "B", "F", "G"]);
  assert.equal(parseCsvSource(saved).rows.find((row) => row[0] === "A")[1], "  a  ",
    "comparison does not alter the stored cell text");
  await sort("Sort Desc");
  assert.deepEqual(names(), ["B", "A", "C", "H", "E", "D", "F", "G"]);
  await act(async () => cell(dom, 0, 2).click());
  await sort("Sort Asc");
  assert.deepEqual(names(), ["H", "G", "F", "E", "D", "C", "B", "A"],
    "blank heading selects its column by position");
  await act(async () => cell(dom, 0, 1).click());
  await sort("Sort Asc");
  assert.deepEqual(names(), ["D", "E", "H", "C", "A", "B", "G", "F"],
    "a later sort preserves its current order within equal keys");
  assert.equal(parseCsvSource(saved).valid, true);
  assert.equal(parseCsvSource(saved).rows.length, 9,
    "heading and insertion placeholder stay outside the data row sort");
});
