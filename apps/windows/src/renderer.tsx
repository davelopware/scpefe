import React, { FormEvent, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Profile = { name: string; email: string; deviceName: string };
type Opened = { content: string; readOnly: true };
declare global { interface Window { scpefe: {
  getProfile(): Promise<Profile | null>;
  saveProfile(profile: Profile): Promise<Profile>;
  createDocument(request: object): Promise<{ created: true } | null>;
  openDocument(password: string): Promise<Opened | null>;
}; } }

function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [message, setMessage] = useState("");
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
    try { setOpened(await window.scpefe.openDocument(String(data.get("password")))); }
    catch (error) { showError(error); }
  }

  if (!profile) return <main><h1>Set up this client</h1><p>Name, email, and device name are required before creating a document.</p><form onSubmit={saveProfile}><label>Name<input name="name" required /></label><label>Email<input name="email" type="email" required /></label><label>Device name<input name="deviceName" required /></label><button>Save local profile</button></form><p role="status">{message}</p></main>;
  return <main><h1>SCPEFE</h1><p>{profile.name} · {profile.email} · {profile.deviceName}</p><section><h2>Create</h2><p className="warning">There is no account reset: without a valid owner or recovery password, the document is permanently irrecoverable.</p><form onSubmit={create}><label>Initial text<textarea name="content" /></label><label>Owner password<input name="ownerPassword" type="password" minLength={12} required /></label><label>Independent recovery password (strongly recommended)<input name="recoveryPassword" type="password" minLength={12} /></label><small>Store the recovery password safely offline and separately from the owner password and document.</small><label className="check"><input name="understandsIrrecoverable" type="checkbox" required /> I understand that lost passwords cannot be recovered.</label><label className="check"><input name="storedRecoverySeparately" type="checkbox" /> I will store the recovery password independently.</label><button>Create encrypted document…</button></form></section><section><h2>Open read-only</h2><form onSubmit={open}><label>Password<input name="password" type="password" required /></label><button>Choose document…</button></form>{opened && <><p className="mode">Read-only mode</p><textarea aria-label="Document text" value={opened.content} readOnly /></>}</section><p role="status">{message}</p></main>;
}

createRoot(document.getElementById("root")!).render(<App />);
