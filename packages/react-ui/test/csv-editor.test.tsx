// @ts-nocheck -- narrow session fixture exercises the mounted source view.
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { EditorView } from "../src/editor/editor-view.tsx";
import { MenuBar } from "../src/shell/menu-bar.tsx";

test("CSV source view reports a parse location and Go to error selects it", async (t) => {
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
  let root;
  t.after(() => {
    frames.clear();
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
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
    cancelAnimationFrame: (token) => frames.delete(token),
    IS_REACT_ACT_ENVIRONMENT: true });
  const text = "heading,other\nonly-one";
  let snapshot = { kind: "edit", document: { content: text, contentType: "csv" },
    working: { text, selection: { start: 0, end: 0 } }, commands: { write: true } };
  const session = { subscribe: () => () => {}, getSnapshot: () => snapshot,
    edit: () => true, setSelection: () => true, undo: () => true, redo: () => true,
    findNext: () => null, replaceSelection: () => null, replaceAll: () => null };
  root = createRoot(dom.window.document.getElementById("root"));
  await act(async () => root.render(<EditorView session={session} active locked={false}
    blocked={false} csvView="source" onMessage={() => {}} onReturnFocus={() => {}} />));
  const alert = dom.window.document.querySelector('[role="alert"]');
  assert.match(alert?.textContent ?? "", /line 2, column 1/);
  const editor = dom.window.document.querySelector("textarea");
  assert.equal(editor?.getAttribute("aria-label"), "CSV source");
  await act(async () => alert.querySelector("button").click());
  assert.equal(editor.selectionStart, text.indexOf("only-one"));
  assert.equal(dom.window.document.activeElement, editor);
  await act(async () => root.render(<MenuBar snapshot={snapshot}
    commands={{ available: () => true, invoke: async () => true }} />));
  await act(async () => dom.window.document.querySelector('button[aria-label="File"]').click());
  assert.match(dom.window.document.querySelector('[role="menu"]')?.textContent ?? "",
    /Export CSV…/);
  assert.ok(dom.window.document.querySelector('button[aria-label="Table"]'));

  const valid = "same,,same\n,,\nvalue,,\"\"";
  snapshot = { ...snapshot, document: { ...snapshot.document, content: valid },
    working: { ...snapshot.working, text: valid } };
  await act(async () => root.render(<EditorView session={session} active locked={false}
    blocked={false} csvView="table" onMessage={() => {}} onReturnFocus={() => {}} />));
  assert.equal(dom.window.document.querySelector("textarea"), null);
  const rows = dom.window.document.querySelectorAll(".csv-table tr");
  assert.equal(rows.length, 4, "heading, two saved rows, and one placeholder");
  assert.deepEqual([...rows[0].querySelectorAll("th")].map((cell) => cell.textContent),
    ["same", "", "same"]);
  assert.deepEqual([...rows[1].querySelectorAll("td")].map((cell) => cell.textContent),
    ["", "", ""]);
  assert.equal(rows[1].classList.contains("csv-insertion-placeholder"), false);
  assert.equal(dom.window.document.querySelectorAll(".csv-insertion-placeholder").length, 1);
  assert.equal(rows[3].getAttribute("aria-label"), "Insertion placeholder");
  await act(async () => root.render(<EditorView session={session} active locked={false}
    blocked csvView="table" onMessage={() => {}} onReturnFocus={() => {}} />));
  assert.equal(dom.window.document.querySelector(".csv-table"), null,
    "modal protection hides table content");
  await act(async () => root.render(<EditorView session={session} active locked={false}
    blocked={false} csvView="source" onMessage={() => {}} onReturnFocus={() => {}} />));
  assert.equal(dom.window.document.querySelector("textarea")?.value, valid);
  snapshot = { ...snapshot, kind: "read-only",
    commands: { write: false } };
  await act(async () => root.render(<EditorView session={session} active locked={false}
    blocked={false} csvView="source" onMessage={() => {}} onReturnFocus={() => {}} />));
  assert.equal(dom.window.document.querySelector("textarea")?.readOnly, true);
  snapshot = { ...snapshot, kind: "locked" };
  await act(async () => root.render(<EditorView session={session} active={false} locked
    blocked={false} csvView="table" onMessage={() => {}} onReturnFocus={() => {}} />));
  assert.equal(dom.window.document.querySelector(".csv-table"), null);
  assert.equal(dom.window.document.querySelector("textarea")?.value, "");
  snapshot = { ...snapshot, kind: "edit",
    document: { ...snapshot.document, contentType: "plain-text" } };
  await act(async () => root.render(<MenuBar snapshot={snapshot}
    commands={{ available: () => true, invoke: async () => true }} />));
  assert.equal(dom.window.document.querySelector('button[aria-label="Table"]'), null);
  await act(async () => { root.unmount(); root = null; });
});
