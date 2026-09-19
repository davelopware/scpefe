import React, { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Profile = { name: string; email: string; deviceName: string };
type Opened = { content: string; readOnly: boolean; canEdit: boolean };
declare global { interface Window { scpefe: {
  getProfile(): Promise<Profile | null>;
  saveProfile(profile: Profile): Promise<Profile>;
  createDocument(request: object): Promise<{ created: true } | null>;
  openDocument(password: string): Promise<Opened | null>;
  enterEditMode(): Promise<Opened>;
  saveDocument(content: string): Promise<{ saved: true; content: string }>;
  exportPlaintext(request: { content: string; lineEndings: "lf" | "native" }):
    Promise<{ exported: true } | null>;
}; } }

function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [message, setMessage] = useState("");
  const [workingText, setWorkingText] = useState("");
  const [history, setHistory] = useState<string[]>([""]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [lineEndings, setLineEndings] = useState<"lf" | "native">("lf");
  const editor = useRef<HTMLTextAreaElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  useEffect(() => { window.scpefe.getProfile().then(setProfile).catch(showError); }, []);
  const showError = (error: unknown) => setMessage(error instanceof Error ? error.message : String(error));

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
      const content = result?.content ?? "";
      setWorkingText(content);
      setHistory([content]);
      setHistoryIndex(0);
    }
    catch (error) { showError(error); }
  }

  async function enterEditMode() {
    try {
      setOpened(await window.scpefe.enterEditMode());
      setMessage("Edit mode entered.");
    } catch (error) { showError(error); }
  }

  async function save() {
    try {
      const result = await window.scpefe.saveDocument(workingText);
      setWorkingText(result.content);
      setHistory((current) => current.map((entry, index) =>
        index === historyIndex ? result.content : entry));
      setOpened((current) => current && { ...current, content: result.content });
      setMessage("Manual save published and verified.");
    } catch (error) { showError(error); }
  }

  function edit(next: string) {
    setWorkingText(next);
    setHistory((current) => [...current.slice(0, historyIndex + 1), next]);
    setHistoryIndex((current) => current + 1);
  }

  function moveHistory(offset: number) {
    const next = historyIndex + offset;
    if (next < 0 || next >= history.length) return;
    setHistoryIndex(next);
    setWorkingText(history[next]);
  }

  function findNext() {
    if (!findText || !editor.current) return;
    const start = editor.current.selectionEnd;
    let match = workingText.indexOf(findText, start);
    if (match < 0) match = workingText.indexOf(findText);
    if (match < 0) {
      setMessage("Text not found.");
      return;
    }
    editor.current.focus();
    editor.current.setSelectionRange(match, match + findText.length);
    setMessage("Match selected.");
  }

  function replaceSelection() {
    if (!findText || !editor.current || opened?.readOnly) return;
    const { selectionStart: start, selectionEnd: end } = editor.current;
    if (workingText.slice(start, end) !== findText) {
      findNext();
      return;
    }
    edit(workingText.slice(0, start) + replaceText + workingText.slice(end));
    requestAnimationFrame(() => editor.current?.setSelectionRange(
      start + replaceText.length, start + replaceText.length));
  }

  function replaceAll() {
    if (!findText || opened?.readOnly) return;
    const matches = workingText.split(findText).length - 1;
    if (!matches) {
      setMessage("Text not found.");
      return;
    }
    edit(workingText.split(findText).join(replaceText));
    setMessage(`${matches} match${matches === 1 ? "" : "es"} replaced.`);
  }

  function editorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "f") {
      event.preventDefault();
      findInput.current?.focus();
    } else if (modifier && event.key.toLowerCase() === "z") {
      event.preventDefault();
      moveHistory(event.shiftKey ? 1 : -1);
    } else if (modifier && event.key.toLowerCase() === "y") {
      event.preventDefault();
      moveHistory(1);
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
  return <main><h1>SCPEFE</h1><p>{profile.name} · {profile.email} · {profile.deviceName}</p><section><h2>Create</h2><p className="warning">There is no account reset: without a valid owner or recovery password, the document is permanently irrecoverable.</p><form onSubmit={create}><label>Initial text<textarea name="content" /></label><label>Owner password<input name="ownerPassword" type="password" minLength={12} required /></label><label>Independent recovery password (strongly recommended)<input name="recoveryPassword" type="password" minLength={12} /></label><small>Store the recovery password safely offline and separately from the owner password and document.</small><label className="check"><input name="understandsIrrecoverable" type="checkbox" required /> I understand that lost passwords cannot be recovered.</label><label className="check"><input name="storedRecoverySeparately" type="checkbox" /> I will store the recovery password independently.</label><button>Create encrypted document…</button></form></section><section><h2>Open document</h2><form onSubmit={open}><label>Password<input name="password" type="password" required /></label><button>Choose document…</button></form>{opened && <><p className="mode">{opened.readOnly ? "Read-only mode" : "Edit mode"}</p><div className="toolbar" aria-label="Editing tools"><button disabled={opened.readOnly || historyIndex === 0} onClick={() => moveHistory(-1)}>Undo</button><button disabled={opened.readOnly || historyIndex === history.length - 1} onClick={() => moveHistory(1)}>Redo</button></div><textarea ref={editor} aria-label="Document text" value={workingText} readOnly={opened.readOnly} onKeyDown={editorKeyDown} onChange={(event) => edit(event.target.value)} /><fieldset><legend>Find and replace</legend><label>Find<input ref={findInput} value={findText} onChange={(event) => setFindText(event.target.value)} /></label><label>Replace with<input value={replaceText} onChange={(event) => setReplaceText(event.target.value)} /></label><div className="toolbar"><button onClick={findNext}>Find next</button><button disabled={opened.readOnly} onClick={replaceSelection}>Replace</button><button disabled={opened.readOnly} onClick={replaceAll}>Replace all</button></div></fieldset>{opened.readOnly ? <button disabled={!opened.canEdit} onClick={enterEditMode}>Enter edit mode</button> : <button onClick={save}>Save</button>}<fieldset><legend>Export plaintext</legend><p className="warning"><strong>Not password protected:</strong> the exported text may persist in backups or storage history.</p><label>Line endings<select value={lineEndings} onChange={(event) => setLineEndings(event.target.value as "lf" | "native")}><option value="lf">Canonical LF</option><option value="native">Platform native</option></select></label><button onClick={exportPlaintext}>Export current text…</button></fieldset></>}</section><p role="status">{message}</p></main>;
}

createRoot(document.getElementById("root")!).render(<App />);
