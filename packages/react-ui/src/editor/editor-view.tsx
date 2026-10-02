import React, { useEffect, useImperativeHandle, useRef, useState,
  type KeyboardEvent } from "react";
import type { DocumentSessionSnapshot, SessionDocument, SnapshotSource,
  WorkingCopySelection } from "@scpefe/frontend-core";
import { useSessionSnapshot } from "../use-session-snapshot.ts";

/** Editing commands needed by the shared document workspace. */
export interface EditorSession extends SnapshotSource<DocumentSessionSnapshot<SessionDocument>> {
  edit(text: string, selection?: WorkingCopySelection): boolean;
  setSelection(selection: WorkingCopySelection): boolean;
  findNext(text: string): { status: string; wrapped?: boolean;
    selection?: WorkingCopySelection } | null;
  replaceSelection(find: string, replacement: string): { status: string;
    wrapped?: boolean; selection?: WorkingCopySelection } | null;
  replaceAll(find: string, replacement: string): { replacements: number } | null;
  undo(): boolean;
  redo(): boolean;
}

/** Narrow controls needed by menu commands and lifecycle focus restoration. */
export interface EditorViewHandle {
  openFind(mode: "find" | "replace", returnFocus?: HTMLElement | null): void;
  reset(): void;
  focus(): void;
}

interface EditorViewProps {
  session: EditorSession;
  active: boolean;
  locked: boolean;
  blocked: boolean;
  onMessage(message: string): void;
  onReturnFocus(element: HTMLElement | null): void;
  ref?: React.Ref<EditorViewHandle>;
}

/** Presents the working copy and owns modeless search state for one adoption. */
export function EditorView({ session, active, locked, blocked, onMessage,
  onReturnFocus, ref }: EditorViewProps): React.ReactElement {
  const snapshot = useSessionSnapshot(session);
  const working = snapshot.kind === "read-only" || snapshot.kind === "edit"
    ? snapshot.working : null;
  const text = working?.text ?? "";
  const readOnly = snapshot.kind !== "edit" || !snapshot.commands.write;
  const editor = useRef<HTMLTextAreaElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const findReturnFocus = useRef<HTMLElement | null>(null);
  const suspendedFindFocus = useRef<"find" | "replace" | null>(null);
  const wasBlocked = useRef(false);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [findStatus, setFindStatus] = useState("");

  if (blocked && !wasBlocked.current && findOpen) {
    suspendedFindFocus.current = document.activeElement === replaceInput.current
      ? "replace" : "find";
  }
  useEffect(() => {
    const restore = wasBlocked.current && !blocked && active;
    const restoreFind = restore && findOpen && suspendedFindFocus.current !== null;
    wasBlocked.current = blocked;
    if (!restore) return;
    const { start, end } = working?.selection ?? { start: 0, end: 0 };
    requestAnimationFrame(() => {
      editor.current?.setSelectionRange(Math.min(start, text.length), Math.min(end, text.length));
      if (restoreFind) {
        (suspendedFindFocus.current === "replace" ? replaceInput.current : findInput.current)
          ?.focus();
        suspendedFindFocus.current = null;
      }
    });
  });

  function openFind(mode: "find" | "replace", returnFocus?: HTMLElement | null): void {
    if (!active) return;
    findReturnFocus.current = returnFocus?.isConnected
      ? returnFocus : document.activeElement as HTMLElement | null;
    setFindOpen(true);
    requestAnimationFrame(() => (mode === "replace"
      ? replaceInput.current : findInput.current)?.focus());
  }

  function closeFind(): void {
    setFindOpen(false);
    requestAnimationFrame(() => (findReturnFocus.current?.isConnected
      ? findReturnFocus.current : editor.current)?.focus());
  }

  function reset(): void {
    setFindOpen(false); setFindText(""); setReplaceText(""); setFindStatus("");
    suspendedFindFocus.current = null;
    findReturnFocus.current = null;
  }

  useImperativeHandle(ref, () => ({ openFind, reset,
    focus: () => editor.current?.focus() }), [active]);

  function findNext(): void {
    if (!findText || !editor.current) { setFindStatus("Enter text to find."); return; }
    session.setSelection({ start: editor.current.selectionStart,
      end: editor.current.selectionEnd });
    const found = session.findNext(findText);
    if (!found || found.status !== "selected" || !found.selection) {
      setFindStatus("Text not found."); onMessage("Text not found."); return;
    }
    editor.current.focus();
    editor.current.setSelectionRange(found.selection.start, found.selection.end);
    const status = found.wrapped ? "Match selected after wrapping to the start."
      : "Match selected.";
    setFindStatus(status); onMessage(status);
  }

  function replaceSelection(): void {
    if (!findText || !editor.current || !active || readOnly) return;
    const { selectionStart: start, selectionEnd: end } = editor.current;
    session.setSelection({ start, end });
    const result = session.replaceSelection(findText, replaceText);
    if (!result) return;
    if (result.status === "selected" && result.selection) {
      editor.current.focus();
      editor.current.setSelectionRange(result.selection.start, result.selection.end);
      const status = result.wrapped ? "Match selected after wrapping to the start."
        : "Match selected.";
      setFindStatus(status); onMessage(status);
      return;
    }
    if (result.status !== "replaced") {
      setFindStatus("Text not found."); onMessage("Text not found."); return;
    }
    const replaced = session.getSnapshot();
    const next = replaced.kind === "edit"
      ? replaced.working.selection.start : start + replaceText.length;
    setFindStatus("Selected match replaced."); onMessage("Selected match replaced.");
    requestAnimationFrame(() => {
      editor.current?.focus(); editor.current?.setSelectionRange(next, next);
    });
  }

  function replaceAll(): void {
    if (!findText || !active || readOnly) return;
    const matches = session.replaceAll(findText, replaceText)?.replacements ?? 0;
    if (!matches) { setFindStatus("Text not found."); onMessage("Text not found."); return; }
    const replaced = session.getSnapshot();
    const cursor = replaced.kind === "edit" ? replaced.working.selection.start : 0;
    const status = `${matches} match${matches === 1 ? "" : "es"} replaced.`;
    setFindStatus(status); onMessage(status);
    requestAnimationFrame(() => editor.current?.setSelectionRange(cursor, cursor));
  }

  function editorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "f") {
      event.preventDefault();
      onReturnFocus(editor.current);
      openFind("find", editor.current);
    } else if (modifier && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) session.redo(); else session.undo();
    } else if (modifier && event.key.toLowerCase() === "y") {
      event.preventDefault(); session.redo();
    }
  }

  return <section className="editor-surface" aria-label="Document workspace">
    {!active && <p className="editor-placeholder" role="note">
      {locked ? "Document locked. Use Security → Unlock to continue."
        : "No document. Use File → New or File → Open."}</p>}
    <textarea ref={editor} aria-label="Document text" value={active && !blocked ? text : ""}
      disabled={!active} readOnly={!active || readOnly}
      onSelect={(event) => {
        const selection = { start: event.currentTarget.selectionStart,
          end: event.currentTarget.selectionEnd };
        if (working && (selection.start !== working.selection.start
            || selection.end !== working.selection.end)) session.setSelection(selection);
      }}
      onKeyDown={editorKeyDown} onChange={(event) => session.edit(event.target.value,
        { start: event.target.selectionStart, end: event.target.selectionEnd })} />
    {findOpen && active && !blocked && <section className="modeless-dialog" role="dialog"
      aria-modal="false" aria-labelledby="find-replace-title" onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); closeFind(); }
      }}><h2 id="find-replace-title">Find and replace</h2>
      <label>Find<input ref={findInput} value={findText}
        onChange={(event) => { setFindText(event.target.value); setFindStatus(""); }} /></label>
      <label>Replace with<input ref={replaceInput} value={replaceText}
        onChange={(event) => setReplaceText(event.target.value)} /></label>
      <div className="dialog-actions"><button type="button" disabled={!findText}
        onClick={findNext}>Find next</button>
        <button type="button" disabled={readOnly || !findText}
          onClick={replaceSelection}>Replace</button>
        <button type="button" disabled={readOnly || !findText}
          onClick={replaceAll}>Replace all</button>
        <button type="button" onClick={closeFind}>Close</button></div>
      <p className="modeless-status" role="status" aria-live="polite">{findStatus}</p>
    </section>}
  </section>;
}
