import React, { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Profile = { name: string; email: string; deviceName: string };
type Cursor = { start: number; end: number };
type Recovery = { content: string; state: "unsaved"; updateTime: number; cursor: Cursor };
type Lease = { active: boolean; holderName: string; holderEmail: string;
  deviceName: string; holderUtcMs: number; durationMs: number };
type HeadMismatch = { kind: "rollback" | "divergence" | "replacement" | "witness-error";
  title: string; explanation: string; editingBlocked: true };
type PublicationState = "target-published" | "pending-publication" | "conflict";
type SaveState = "unsaved" | PublicationState;
type Opened = { content: string; readOnly: boolean; canEdit: boolean;
  publicationState: PublicationState; recovery?: Recovery; lease?: Lease;
  headMismatch?: HeadMismatch };
type LockResult = { locked: true; journalSaved: boolean; warning: string | null };
declare global { interface Window { scpefe: {
  getProfile(): Promise<Profile | null>;
  saveProfile(profile: Profile): Promise<Profile>;
  createDocument(request: object): Promise<{ created: true } | null>;
  openDocument(password: string): Promise<Opened | null>;
  enterEditMode(): Promise<Opened>;
  saveDocument(content: string): Promise<{ saved: true; content: string;
    publicationState: PublicationState }>;
  reconnectPendingPublication(): Promise<{ content: string;
    publicationState: PublicationState }>;
  discardPendingPublication(): Promise<Opened>;
  exportPlaintext(request: { content: string; lineEndings: "lf" | "native" }):
    Promise<{ exported: true } | null>;
  updateWorkingCopy(value: { content: string; cursor: Cursor }): Promise<object>;
  activity(): Promise<object>;
  restoreRecoveredWork(): Promise<Opened & { recoveredUnsaved: true; cursor: Cursor }>;
  discardRecoveredWork(): Promise<Opened>;
  acceptHeadMismatch(): Promise<Opened>;
  lock(): Promise<LockResult>;
  onLocked(listener: (result: LockResult) => void): () => void;
  onJournalWarning(listener: (warning: string) => void): () => void;
}; } }

function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [message, setMessage] = useState("");
  const [workingText, setWorkingText] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("target-published");
  const [history, setHistory] = useState<string[]>([""]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [lineEndings, setLineEndings] = useState<"lf" | "native">("lf");
  const editor = useRef<HTMLTextAreaElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  useEffect(() => { window.scpefe.getProfile().then(setProfile).catch(showError); }, []);
  const showError = (error: unknown) => setMessage(error instanceof Error ? error.message : String(error));
  useEffect(() => {
    const stopLocked = window.scpefe.onLocked((result) => {
      setOpened(null);
      setWorkingText("");
      setSaveState("target-published");
      setMessage(result.warning ?? "Document locked. Enter its password to unlock again.");
    });
    const stopWarning = window.scpefe.onJournalWarning(setMessage);
    const activity = () => { void window.scpefe.activity(); };
    window.addEventListener("keydown", activity);
    window.addEventListener("pointerdown", activity);
    return () => {
      stopLocked(); stopWarning();
      window.removeEventListener("keydown", activity);
      window.removeEventListener("pointerdown", activity);
    };
  }, []);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      setProfile(await window.scpefe.saveProfile({
        name: String(data.get("name")), email: String(data.get("email")),
        deviceName: String(data.get("deviceName")),
      }));
      setMessage("Local profile saved.");
    } catch (error) { showError(error); }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const result = await window.scpefe.createDocument({
        ownerPassword: String(data.get("ownerPassword")),
        recoveryPassword: String(data.get("recoveryPassword")),
        content: String(data.get("content")),
        understandsIrrecoverable: data.get("understandsIrrecoverable") === "on",
        storedRecoverySeparately: data.get("storedRecoverySeparately") === "on",
      });
      if (result) setMessage("Encrypted document published successfully.");
    } catch (error) { showError(error); }
  }

  async function open(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const result = await window.scpefe.openDocument(String(data.get("password")));
      setOpened(result);
      setWorkingText(result?.content ?? "");
      setSaveState(result?.recovery ? "unsaved"
        : result?.publicationState ?? "target-published");
      setHistory([result?.content ?? ""]);
      setHistoryIndex(0);
      if (result?.lease?.active) {
        setMessage(`Editing lease held by ${result.lease.holderName || "another editor"} (${result.lease.holderEmail}) on ${result.lease.deviceName}.`);
      }
    }
    catch (error) { showError(error); }
  }

  async function enterEditMode() {
    try {
      setOpened(await window.scpefe.enterEditMode());
      setMessage("Edit mode entered.");
    } catch (error) { showError(error); }
  }

  async function restoreRecovery() {
    try {
      const result = await window.scpefe.restoreRecoveredWork();
      setOpened(result);
      setWorkingText(result.content);
      setHistory([result.content]);
      setHistoryIndex(0);
      setSaveState("unsaved");
      setMessage("Recovered work restored as unsaved changes.");
    } catch (error) { showError(error); }
  }

  async function discardRecovery() {
    try {
      const result = await window.scpefe.discardRecoveredWork();
      setOpened(result);
      setWorkingText(result.content);
      setSaveState("target-published");
      setMessage("Recovered work discarded.");
    } catch (error) { showError(error); }
  }

  async function acceptHeadMismatch() {
    try {
      const result = await window.scpefe.acceptHeadMismatch();
      setOpened(result);
      setMessage("Current authenticated head accepted. Editing may now be enabled.");
    } catch (error) { setMessage((error as Error).message); }
  }

  async function lock() {
    try { await window.scpefe.lock(); } catch (error) { showError(error); }
  }

  function edit(content: string, cursor?: Cursor) {
    setWorkingText(content);
    setSaveState("unsaved");
    setHistory((current) => [...current.slice(0, historyIndex + 1), content]);
    setHistoryIndex((current) => current + 1);
    const nextCursor = cursor ?? { start: content.length, end: content.length };
    void window.scpefe.updateWorkingCopy({ content, cursor: nextCursor }).catch(showError);
  }

  async function save() {
    try {
      const result = await window.scpefe.saveDocument(workingText);
      setWorkingText(result.content);
      setOpened((current) => current && { ...current, content: result.content,
        readOnly: result.publicationState !== "target-published",
        publicationState: result.publicationState });
      setSaveState(result.publicationState);
      setMessage(result.publicationState === "pending-publication"
        ? "Manual save is pending publication; its exact candidate is stored locally."
        : result.publicationState === "conflict"
          ? "Manual save is local, but the target changed; divergence must be resolved."
          : "Manual save published and verified.");
    } catch (error) { showError(error); }
  }

  async function reconnectPublication() {
    try {
      const result = await window.scpefe.reconnectPendingPublication();
      setOpened((current) => current && { ...current, content: result.content,
        readOnly: true, publicationState: result.publicationState });
      setWorkingText(result.content);
      setSaveState(result.publicationState);
      setMessage(result.publicationState === "target-published"
        ? "Pending manual save published and verified."
        : result.publicationState === "conflict"
          ? "The target changed; divergence must be resolved without overwriting it."
          : "The target is still unavailable; publication remains pending.");
    } catch (error) { showError(error); }
  }

  async function discardPublication() {
    try {
      const result = await window.scpefe.discardPendingPublication();
      setOpened(result);
      setWorkingText(result.content);
      setSaveState("target-published");
      setMessage("Pending manual save explicitly discarded.");
    } catch (error) { showError(error); }
  }

  function moveHistory(offset: number) {
    const next = historyIndex + offset;
    if (next < 0 || next >= history.length) return;
    const content = history[next];
    setHistoryIndex(next);
    setWorkingText(content);
    void window.scpefe.updateWorkingCopy({ content,
      cursor: { start: content.length, end: content.length } }).catch(showError);
  }

  function findNext() {
    if (!findText || !editor.current) return;
    const start = editor.current.selectionEnd;
    let match = workingText.indexOf(findText, start);
    if (match < 0) match = workingText.indexOf(findText);
    if (match < 0) { setMessage("Text not found."); return; }
    editor.current.focus();
    editor.current.setSelectionRange(match, match + findText.length);
    setMessage("Match selected.");
  }

  function replaceSelection() {
    if (!findText || !editor.current || opened?.readOnly) return;
    const { selectionStart: start, selectionEnd: end } = editor.current;
    if (workingText.slice(start, end) !== findText) { findNext(); return; }
    const content = workingText.slice(0, start) + replaceText + workingText.slice(end);
    const next = start + replaceText.length;
    edit(content, { start: next, end: next });
    requestAnimationFrame(() => editor.current?.setSelectionRange(next, next));
  }

  function replaceAll() {
    if (!findText || opened?.readOnly) return;
    const matches = workingText.split(findText).length - 1;
    if (!matches) { setMessage("Text not found."); return; }
    edit(workingText.split(findText).join(replaceText));
    setMessage(`${matches} match${matches === 1 ? "" : "es"} replaced.`);
  }

  function editorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "f") {
      event.preventDefault(); findInput.current?.focus();
    } else if (modifier && event.key.toLowerCase() === "z") {
      event.preventDefault(); moveHistory(event.shiftKey ? 1 : -1);
    } else if (modifier && event.key.toLowerCase() === "y") {
      event.preventDefault(); moveHistory(1);
    }
  }

  async function exportPlaintext() {
    try {
      const result = await window.scpefe.exportPlaintext({
        content: workingText, lineEndings,
      });
      if (result) setMessage("Unprotected plaintext exported.");
    } catch (error) { showError(error); }
  }

  if (!profile) return <main><h1>Set up this client</h1><p>Name, email, and device name are required before creating a document.</p><form onSubmit={saveProfile}><label>Name<input name="name" required /></label><label>Email<input name="email" type="email" required /></label><label>Device name<input name="deviceName" required /></label><button>Save local profile</button></form><p role="status">{message}</p></main>;
  return <main><h1>SCPEFE</h1><p>{profile.name} · {profile.email} · {profile.deviceName}</p><section><h2>Create</h2><p className="warning">There is no account reset: without a valid owner or recovery password, the document is permanently irrecoverable.</p><form onSubmit={create}><label>Initial text<textarea name="content" /></label><label>Owner password<input name="ownerPassword" type="password" minLength={12} required /></label><label>Independent recovery password (strongly recommended)<input name="recoveryPassword" type="password" minLength={12} /></label><small>Store the recovery password safely offline and separately from the owner password and document.</small><label className="check"><input name="understandsIrrecoverable" type="checkbox" required /> I understand that lost passwords cannot be recovered.</label><label className="check"><input name="storedRecoverySeparately" type="checkbox" /> I will store the recovery password independently.</label><button>Create encrypted document…</button></form></section><section><h2>Open document</h2><form onSubmit={open}><label>Password<input name="password" type="password" required /></label><button>Choose document…</button></form>{opened && <><p className="mode">{opened.readOnly ? "Read-only mode" : "Edit mode"} · {saveState === "unsaved" ? "Unsaved edits" : saveState === "pending-publication" ? "Manual save pending publication" : saveState === "conflict" ? "Divergence needs resolution" : "Published to target"}</p>{opened.headMismatch && <div className="warning" role="alert"><strong>{opened.headMismatch.title}</strong><p>{opened.headMismatch.explanation}</p><button onClick={acceptHeadMismatch}>Accept current authenticated head</button></div>}{opened.recovery && <div className="warning" role="alert"><p>Recovered work from {new Date(opened.recovery.updateTime).toLocaleString()} is available as unsaved changes.</p><button disabled={!opened.canEdit} onClick={restoreRecovery}>Restore unsaved work</button><button onClick={discardRecovery}>Discard recovered work</button></div>}{(opened.publicationState === "pending-publication" || opened.publicationState === "conflict") && <div className="warning" role="alert"><p>{opened.publicationState === "conflict" ? "The target changed. The locally saved candidate was preserved for divergence handling." : "This manual save is stored locally and has not reached its target."}</p><button onClick={reconnectPublication}>Retry publication</button><button onClick={discardPublication}>Discard pending save</button></div>}<div className="toolbar" aria-label="Editing tools"><button disabled={opened.readOnly || historyIndex === 0} onClick={() => moveHistory(-1)}>Undo</button><button disabled={opened.readOnly || historyIndex === history.length - 1} onClick={() => moveHistory(1)}>Redo</button></div><textarea ref={editor} aria-label="Document text" value={workingText} readOnly={opened.readOnly} onKeyDown={editorKeyDown} onChange={(event) => edit(event.target.value, { start: event.target.selectionStart, end: event.target.selectionEnd })} /><fieldset><legend>Find and replace</legend><label>Find<input ref={findInput} value={findText} onChange={(event) => setFindText(event.target.value)} /></label><label>Replace with<input value={replaceText} onChange={(event) => setReplaceText(event.target.value)} /></label><div className="toolbar"><button onClick={findNext}>Find next</button><button disabled={opened.readOnly} onClick={replaceSelection}>Replace</button><button disabled={opened.readOnly} onClick={replaceAll}>Replace all</button></div></fieldset>{opened.readOnly ? <button disabled={!opened.canEdit || opened.publicationState !== "target-published"} onClick={enterEditMode}>Enter edit mode</button> : <button onClick={save}>Save</button>}<button onClick={lock}>Lock now</button><fieldset><legend>Export plaintext</legend><p className="warning"><strong>Not password protected:</strong> the exported text may persist in backups or storage history.</p><label>Line endings<select value={lineEndings} onChange={(event) => setLineEndings(event.target.value as "lf" | "native")}><option value="lf">Canonical LF</option><option value="native">Platform native</option></select></label><button onClick={exportPlaintext}>Export current text…</button></fieldset></>}</section><p role="status">{message}</p></main>;
}

createRoot(document.getElementById("root")!).render(<App />);
