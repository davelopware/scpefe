// @ts-nocheck -- mounted editor test uses a compact public session adapter.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { WorkingCopy } from '@scpefe/frontend-core';
import { EditorView } from '../src/editor/editor-view.tsx';

test('text Find counts canonical matches, resets on cursor and content changes, and replaces',
  async (t) => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>",
      { url: 'https://scpefe.invalid/' });
    const keys = ['window', 'document', 'HTMLElement', 'Node', 'MutationObserver',
      'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'];
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
      cancelAnimationFrame: (token) => frames.delete(token),
      IS_REACT_ACT_ENVIRONMENT: true });
    const root = createRoot(dom.window.document.getElementById('root'));
    t.after(async () => {
      await act(async () => root.unmount());
      frames.clear();
      dom.window.close();
      for (const [key, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    });
    let scope = 0;
    const copy = new WorkingCopy({ createJournalScope: () => `find-${++scope}`,
      updateWorkingCopy: async () => {}, onJournalWarning: () => () => {} });
    copy.adoptOpen('aaaaa AA');
    const listeners = new Set();
    let snapshot;
    let kind = 'edit';
    let contentType = 'plain-text';
    const refresh = () => {
      const working = copy.getSnapshot();
      snapshot = { kind, document: { content: working.text, contentType }, working,
        commands: { write: kind === 'edit' } };
      for (const listener of listeners) listener();
    };
    refresh();
    const dispose = copy.subscribe(refresh);
    t.after(() => { dispose(); copy.dispose(); });
    const session = { subscribe: (listener) => {
      listeners.add(listener); return () => listeners.delete(listener);
    }, getSnapshot: () => snapshot,
    edit: (text, selection) => { copy.edit(text, selection); return true; },
    setSelection: (selection) => { copy.setSelection(selection); return true; },
    findNext: (query) => copy.findNext(query),
    replaceSelection: (query, replacement) => copy.replaceSelection(query, replacement),
    replaceAll: (query, replacement) => copy.replaceAll(query, replacement),
    undo: () => copy.undo(), redo: () => copy.redo() };
    const view = createRef();
    await act(async () => root.render(<EditorView ref={view} session={session} active
      locked={false} blocked={false} csvView="source" onMessage={() => {}}
      onReturnFocus={() => {}} />));
    const editor = dom.window.document.querySelector('textarea');
    await act(async () => view.current.openFind('find', editor));
    const find = dom.window.document.querySelector('input');
    const userEvent = (await import('@testing-library/user-event')).default;
    const user = userEvent.setup({ document: dom.window.document });
    await act(async () => user.type(find, 'aa'));
    const count = () => dom.window.document.querySelector('.find-match-count')?.textContent;
    assert.equal(count(), '0 / 2');
    await act(async () => find.dispatchEvent(new dom.window.KeyboardEvent('keydown',
      { key: 'Enter', bubbles: true, cancelable: true })));
    assert.equal(dom.window.document.activeElement === editor, true);
    assert.deepEqual([editor.selectionStart, editor.selectionEnd], [0, 2]);
    assert.equal(count(), '1 / 2');
    await act(async () => dom.window.document.querySelector('.dialog-actions button').click());
    assert.deepEqual([editor.selectionStart, editor.selectionEnd], [2, 4]);
    assert.equal(count(), '2 / 2');
    await act(async () => { editor.setSelectionRange(1, 1);
      dom.window.document.dispatchEvent(new dom.window.Event('selectionchange'));
      editor.dispatchEvent(new dom.window.Event('select', { bubbles: true })); });
    assert.equal(count(), '0 / 2');
    await act(async () => find.focus());
    await act(async () => find.dispatchEvent(new dom.window.KeyboardEvent('keydown',
      { key: 'Enter', bubbles: true, cancelable: true })));
    assert.deepEqual([editor.selectionStart, editor.selectionEnd], [2, 4]);
    assert.equal(count(), '2 / 2');
    await act(async () => user.clear(find));
    await act(async () => user.type(find, 'AA'));
    assert.equal(count(), '0 / 1');
    await act(async () => user.clear(find));
    await act(async () => user.type(find, 'missing'));
    assert.equal(count(), '0 / 0');
    await act(async () => user.clear(find));
    await act(async () => user.type(find, 'aa'));
    await act(async () => dom.window.document.querySelector('.dialog-actions button').click());
    assert.equal(count(), '1 / 2');
    const replace = [...dom.window.document.querySelectorAll('.dialog-actions button')]
      .find((button) => button.textContent === 'Replace');
    const replaceAll = [...dom.window.document.querySelectorAll('.dialog-actions button')]
      .find((button) => button.textContent === 'Replace all');
    const replacement = dom.window.document.querySelectorAll('input')[1];
    await act(async () => user.type(replacement, 'aa!'));
    await act(async () => replacement.dispatchEvent(new dom.window.KeyboardEvent('keydown',
      { key: 'Enter', bubbles: true, cancelable: true })));
    assert.equal(editor.value, 'aaaaa AA');
    assert.equal(count(), '1 / 2');
    await act(async () => replace.click());
    assert.equal(editor.value, 'aa!aaa AA');
    assert.equal(count(), '0 / 2');
    await act(async () => replaceAll.click());
    assert.equal(editor.value, 'aa!!aa!a AA');
    assert.equal(count(), '0 / 2');
    await act(async () => {
      kind = 'read-only'; contentType = 'csv'; refresh();
      root.render(<EditorView ref={view} session={session} active
        locked={false} blocked={false} csvView="source" onMessage={() => {}}
        onReturnFocus={() => {}} />);
    });
    assert.equal(editor.readOnly, true);
    assert.equal(count(), '0 / 2');
    await act(async () => find.focus());
    await act(async () => find.dispatchEvent(new dom.window.KeyboardEvent('keydown',
      { key: 'Enter', bubbles: true, cancelable: true })));
    assert.equal(dom.window.document.activeElement === editor, true);
    assert.deepEqual([editor.selectionStart, editor.selectionEnd], [0, 2]);
    assert.equal(count(), '1 / 2');
  });
