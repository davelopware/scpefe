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
  const snapshot = { kind: "edit", document: { content: text, contentType: "csv" },
    working: { text, selection: { start: 0, end: 0 } }, commands: { write: true } };
  const session = { subscribe: () => () => {}, getSnapshot: () => snapshot,
    edit: () => true, setSelection: () => true, undo: () => true, redo: () => true,
    findNext: () => null, replaceSelection: () => null, replaceAll: () => null };
  root = createRoot(dom.window.document.getElementById("root"));
  await act(async () => root.render(<EditorView session={session} active locked={false}
    blocked={false} onMessage={() => {}} onReturnFocus={() => {}} />));
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
  await act(async () => { root.unmount(); root = null; });
});
