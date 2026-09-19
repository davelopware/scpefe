import React, { FormEvent, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Profile = { name: string; email: string; deviceName: string };
type Cursor = { start: number; end: number };
type Recovery = { content: string; state: "unsaved"; updateTime: number; cursor: Cursor };
type Opened = { content: string; readOnly: boolean; canEdit: boolean; recovery?: Recovery };
type LockResult = { locked: true; journalSaved: boolean; warning: string | null };
declare global { interface Window { scpefe: {
  getProfile(): Promise<Profile | null>;
  saveProfile(profile: Profile): Promise<Profile>;
  createDocument(request: object): Promise<{ created: true } | null>;
  openDocument(password: string): Promise<Opened | null>;
  enterEditMode(): Promise<Opened>;
  saveDocument(content: string): Promise<{ saved: true; content: string }>;
  updateWorkingCopy(value: { content: string; cursor: Cursor }): Promise<object>;
  activity(): Promise<object>;
  restoreRecoveredWork(): Promise<Opened & { recoveredUnsaved: true; cursor: Cursor }>;
  discardRecoveredWork(): Promise<Opened>;
  lock(): Promise<LockResult>;
  onLocked(listener: (result: LockResult) => void): () => void;
  onJournalWarning(listener: (warning: string) => void): () => void;
}; } }

function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [message, setMessage] = useState("");
  const [workingText, setWorkingText] = useState("");
  useEffect(() => { window.scpefe.getProfile().then(setProfile).catch(showError); }, []);
  const showError = (error: unknown) => setMessage(error instanceof Error ? error.message : String(error));
  useEffect(() => {
    const stopLocked = window.scpefe.onLocked((result) => {
      setOpened(null);
      setWorkingText("");
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
      setMessage("Recovered work restored as unsaved changes.");
    } catch (error) { showError(error); }
  }

  async function discardRecovery() {
    try {
      const result = await window.scpefe.discardRecoveredWork();
      setOpened(result);
      setWorkingText(result.content);
      setMessage("Recovered work discarded.");
    } catch (error) { showError(error); }
  }

  async function lock() {
    try { await window.scpefe.lock(); } catch (error) { showError(error); }
  }

  function edit(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const content = event.target.value;
    const cursor = { start: event.target.selectionStart, end: event.target.selectionEnd };
    setWorkingText(content);
    void window.scpefe.updateWorkingCopy({ content, cursor }).catch(showError);
  }

  async function save() {
    try {
      const result = await window.scpefe.saveDocument(workingText);
      setWorkingText(result.content);
      setOpened((current) => current && { ...current, content: result.content });
      setMessage("Manual save published and verified.");
    } catch (error) { showError(error); }
  }

  if (!profile) return <main><h1>Set up this client</h1><p>Name, email, and device name are required before creating a document.</p><form onSubmit={saveProfile}><label>Name<input name="name" required /></label><label>Email<input name="email" type="email" required /></label><label>Device name<input name="deviceName" required /></label><button>Save local profile</button></form><p role="status">{message}</p></main>;
  return <main><h1>SCPEFE</h1><p>{profile.name} · {profile.email} · {profile.deviceName}</p><section><h2>Create</h2><p className="warning">There is no account reset: without a valid owner or recovery password, the document is permanently irrecoverable.</p><form onSubmit={create}><label>Initial text<textarea name="content" /></label><label>Owner password<input name="ownerPassword" type="password" minLength={12} required /></label><label>Independent recovery password (strongly recommended)<input name="recoveryPassword" type="password" minLength={12} /></label><small>Store the recovery password safely offline and separately from the owner password and document.</small><label className="check"><input name="understandsIrrecoverable" type="checkbox" required /> I understand that lost passwords cannot be recovered.</label><label className="check"><input name="storedRecoverySeparately" type="checkbox" /> I will store the recovery password independently.</label><button>Create encrypted document…</button></form></section><section><h2>Open document</h2><form onSubmit={open}><label>Password<input name="password" type="password" required /></label><button>Choose document…</button></form>{opened && <><p className="mode">{opened.readOnly ? "Read-only mode" : "Edit mode"}</p>{opened.recovery && <div className="warning" role="alert"><p>Recovered work from {new Date(opened.recovery.updateTime).toLocaleString()} is available as unsaved changes.</p><button disabled={!opened.canEdit} onClick={restoreRecovery}>Restore unsaved work</button><button onClick={discardRecovery}>Discard recovered work</button></div>}<textarea aria-label="Document text" value={workingText} readOnly={opened.readOnly} onChange={edit} />{opened.readOnly ? <button disabled={!opened.canEdit} onClick={enterEditMode}>Enter edit mode</button> : <button onClick={save}>Save</button>}<button onClick={lock}>Lock now</button></>}</section><p role="status">{message}</p></main>;
}

createRoot(document.getElementById("root")!).render(<App />);
