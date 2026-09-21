import React, { FormEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CreationSecurityDialog } from "./creation-security-dialog.mjs";
import { compactionAvailable, CompactionControls } from "./compaction-controls.mjs";
import "./styles.css";

type Profile = { name: string; email: string; deviceName: string };
type Settings = { regularSaveEnabled: boolean; regularSaveIntervalMs: number };
type Publication = "target-published" | "pending-publication" | "conflict";
type Opened = { content?: string; readOnly: true; invitationRequired?: true } | {
  content: string; readOnly: boolean; canEdit: boolean; publicationState: Publication;
  invitationRequired?: false; recovery?: object; headMismatch?: { title: string; explanation: string };
  profileMismatch?: object; migrationRequired?: true; migrationWarning?: string;
  provisional?: true;
  canAddPasswords?: boolean; canRemovePasswords?: boolean; managedSlots?: Array<{
    slotId: string; identityName: string; identityEmail: string; canEdit: boolean;
    canAddPasswords: boolean; canRemovePasswords: boolean; mustBeChanged: boolean;
    permissionsKnown?: boolean; identityKnown?: boolean; mustBeChangedKnown?: boolean }> };
type DialogName = "profile" | "open" | "unlock" | "find" | "replace" | "passwords"
  | "export" | "claim" | "recovery" | "head" | "profile-mismatch" | "migration"
  | "publication" | "invitation-result" | "edit-guard" | "profile-warning" | null;
const isOpened = (value: Opened | null): value is Extract<Opened, { canEdit: boolean }> =>
  value !== null && value.invitationRequired !== true;
let modalDepth = 0;

declare global { interface Window { scpefe: Record<string, (...args: any[]) => Promise<any>> & {
  onLocked(listener: (value: { warning: string | null }) => void): () => void;
  onJournalWarning(listener: (value: string) => void): () => void;
  onRegularSave(listener: (value: object) => void): () => void;
  onExternalOpenRequested(listener: (value: object) => void): () => void;
  onUnresolvedJournalSummary(listener: (value: { total: number }) => void): () => void;
  onSwitchRetained(listener: (value: Opened) => void): () => void;
}; } }

function Modal({ title, children, close, focus }: { title: string; children: React.ReactNode;
  close?: () => void; focus?: React.RefObject<HTMLElement | null> }) {
  const host = useRef<HTMLElement>(null);
  useEffect(() => { const prior = document.activeElement as HTMLElement | null;
    const chrome = document.querySelector<HTMLElement>(".shell-chrome"); modalDepth += 1; chrome?.setAttribute("inert", "");
    (focus?.current ?? host.current?.querySelector<HTMLElement>("button, input, select"))?.focus();
    return () => { modalDepth -= 1; if (modalDepth === 0) chrome?.removeAttribute("inert"); requestAnimationFrame(() => {
      if (modalDepth !== 0 || document.querySelector('[aria-modal="true"]')) return;
      if (prior?.isConnected) prior.focus();
      else document.querySelector<HTMLElement>('[role="menubar"] [role="menuitem"]')?.focus();
    }); };
  }, []);
  return <div className="dialog-backdrop" onKeyDown={(event) => {
    if (event.key === "Escape" && close) { event.preventDefault(); close(); }
    if (event.key === "Tab" && host.current) { const items = [...host.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)")];
      if (!items.length) return; const at = items.indexOf(document.activeElement as HTMLElement); const next = event.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at === items.length - 1 ? 0 : at + 1);
      event.preventDefault(); items[next].focus(); }
  }}><section ref={host} className="app-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
    <h2 id="dialog-title">{title}</h2>{children}</section></div>;
}

function Modeless({ children, close, focus }: { children: React.ReactNode; close(): void;
  focus: React.RefObject<HTMLElement | null> }) {
  useEffect(() => { focus.current?.focus(); }, []);
  return <section className="modeless-dialog" role="dialog" aria-modal="false"
    aria-labelledby="find-dialog-title"><h2 id="find-dialog-title">Find and replace</h2>
    {children}<button onClick={close}>Close</button></section>;
}

const definitions: Array<[string, Array<[string, string, string?] | null>]> = [
  ["File", [["new", "New", "Ctrl+N"], ["open", "Open…", "Ctrl+O"], null,
    ["save", "Save", "Ctrl+S"], ["backup", "Backup…"], ["export", "Export Plaintext…"],
    null, ["close", "Close", "Ctrl+W"], ["exit", "Exit"]]],
  ["Edit", [["edit", "Edit Contents"], null, ["undo", "Undo", "Ctrl+Z"],
    ["redo", "Redo", "Ctrl+Y"], null, ["find", "Find…", "Ctrl+F"], ["replace", "Replace…", "Ctrl+H"]]],
  ["Security", [["lock", "Lock"], null, ["passwords", "Passwords…"], ["profile", "Profile…"]]],
];

function MenuBar({ enabled, locked, run }: { enabled: Record<string, boolean>; locked: boolean; run(command: string): void }) {
  const [open, setOpen] = useState<string | null>(null);
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
  const menuHosts = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => { if (!open) return; requestAnimationFrame(() => menuHosts.current[open]?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus()); }, [open]);
  useEffect(() => { const access = (event: KeyboardEvent) => { if (!event.altKey || event.ctrlKey
      || document.querySelector(".shell-chrome")?.hasAttribute("inert")) return;
    const match = definitions.find(([name]) => name[0].toLowerCase() === event.key.toLowerCase());
    if (match) { event.preventDefault(); setOpen(match[0]); triggers.current[match[0]]?.focus(); }
  }; window.addEventListener("keydown", access); return () => window.removeEventListener("keydown", access); }, []);
  return <nav className="menu-bar" role="menubar" aria-label="Application menu">{definitions.map(([name, items], index) => <div className="menu" key={name}>
    <button type="button" role="menuitem" aria-label={name} aria-haspopup="menu" aria-expanded={open === name}
      ref={(node) => { triggers.current[name] = node; }} onClick={() => setOpen(open === name ? null : name)}
      onKeyDown={(event) => { if (["ArrowDown", "Enter", " "].includes(event.key)) { event.preventDefault(); setOpen(name); } }}>
      <u>{name[0]}</u>{name.slice(1)}</button>
    {open === name && <div ref={(node) => { menuHosts.current[name] = node; }} role="menu" aria-label={name} onKeyDown={(event) => {
      if (event.key === "Escape") { setOpen(null); triggers.current[name]?.focus(); }
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault(); const next = (index + (event.key === "ArrowRight" ? 1 : 2)) % 3;
        setOpen(definitions[next][0]); triggers.current[definitions[next][0]]?.focus();
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }
    }}>{items.map((item, at) => item === null ? <hr key={at} /> : <button key={item[0]} role="menuitem"
      disabled={!enabled[item[0]]} onClick={() => { setOpen(null); run(item[0]); requestAnimationFrame(() => {
        if (!document.querySelector(".dialog-backdrop")) triggers.current[name]?.focus();
      }); }}>
      {item[0] === "lock" && locked ? "Unlock" : item[1]}{item[2] && <kbd>{item[2]}</kbd>}</button>)}</div>}
  </div>)}</nav>;
}

export function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [settings, setSettings] = useState<Settings>({ regularSaveEnabled: false, regularSaveIntervalMs: 120_000 });
  const [opened, setOpened] = useState<Opened | null>(null);
  const [name, setName] = useState(""); const [lockedName, setLockedName] = useState("");
  const [pendingName, setPendingName] = useState("");
  const [text, setText] = useState(""); const [saved, setSaved] = useState("");
  const [publication, setPublication] = useState<Publication>("target-published");
  const [logicallyDirty, setLogicallyDirty] = useState(false);
  const [history, setHistory] = useState<string[]>([""]); const [historyAt, setHistoryAt] = useState(0);
  const [dialog, setDialog] = useState<DialogName>(null); const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState(""); const [error, setError] = useState("");
  const [find, setFind] = useState(""); const [replacement, setReplacement] = useState("");
  const [lineEndings, setLineEndings] = useState("lf"); const [temporary, setTemporary] = useState("");
  const [external, setExternal] = useState<object | null>(null);
  const [queuedExternal, setQueuedExternal] = useState<object | null>(null);
  const [pendingProfile, setPendingProfile] = useState<{ profile: Profile; settings: Settings } | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null); const password = useRef<HTMLInputElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const modalBusy = useRef(false);
  const active = isOpened(opened); const locked = !opened && Boolean(lockedName); const dirty = active && (logicallyDirty || text !== saved);
  modalBusy.current = creating || dialog !== null;
  const fail = (value: unknown) => setError(value instanceof Error ? value.message : String(value));
  function present(result: Opened, target = name) {
    setOpened(result); setName(target); setLockedName(""); setError("");
    if (isOpened(result)) { setText(result.content); setSaved(result.content); setPublication(result.publicationState); setLogicallyDirty(result.provisional === true || Boolean(result.recovery));
      setHistory([result.content]); setHistoryAt(0);
      if (result.migrationRequired) setDialog("migration"); else if (result.profileMismatch) setDialog("profile-mismatch");
      else if (result.headMismatch) setDialog("head"); else if (result.recovery) setDialog("recovery");
      else if (result.publicationState !== "target-published" || result.provisional) setDialog("publication"); else setDialog(null);
    } else setDialog("claim");
  }
  useEffect(() => { void window.scpefe.getProfile().then((value) => { setProfile(value); if (!value) setDialog("profile"); }).catch(fail); }, []);
  useEffect(() => { void window.scpefe.getClientSettings().then(setSettings).catch(fail); }, []);
  useEffect(() => {
    const stops = [window.scpefe.onLocked((result) => { setLockedName(name); setOpened(null); setText(""); setSaved(""); setDialog(null); setMessage(result.warning ?? "Document locked."); }),
      window.scpefe.onJournalWarning(fail), window.scpefe.onRegularSave((value) => { const result = value as { content: string; provisional: true };
        setText(result.content); setLogicallyDirty(true); setPublication("target-published");
        setOpened((old) => isOpened(old) ? { ...old, content: result.content, provisional: true, readOnly: true, publicationState: "target-published" } : old);
        setMessage("Regular save published provisionally; changes remain unsaved until manual save."); setDialog("publication"); }),
      window.scpefe.onExternalOpenRequested((request) => { if (modalBusy.current) { setQueuedExternal(request); setMessage("An external open request is waiting for the current dialog."); return; }
        setExternal(request); setPendingName(String((request as { name?: string }).name ?? "document.scpefe")); setDialog("open"); }),
      window.scpefe.onUnresolvedJournalSummary((summary) => { if (summary.total) setMessage(`${summary.total} recovery item${summary.total === 1 ? "" : "s"} need attention.`); }),
      window.scpefe.onSwitchRetained((result) => present(result))];
    const activity = () => { void window.scpefe.activity(); }; addEventListener("keydown", activity); addEventListener("pointerdown", activity);
    return () => { stops.forEach((stop) => stop()); removeEventListener("keydown", activity); removeEventListener("pointerdown", activity); };
  }, [name]);
  useEffect(() => { if (!creating && dialog === null && queuedExternal) { setExternal(queuedExternal);
    setPendingName(String((queuedExternal as { name?: string }).name ?? "document.scpefe")); setQueuedExternal(null); setDialog("open"); } }, [creating, dialog, queuedExternal]);
  useEffect(() => { const title = active || locked ? `${dirty ? "*" : ""}${name || lockedName} — SCPEFE` : "SCPEFE";
    document.title = title; void window.scpefe.setWindowTitle(title); }, [active, locked, dirty, name, lockedName]);

  function modify(value: string) { setText(value); setHistory((old) => [...old.slice(0, historyAt + 1), value]); setHistoryAt((at) => at + 1);
    void window.scpefe.updateWorkingCopy({ content: value, cursor: { start: value.length, end: value.length } }).catch(fail); }
  function move(offset: number) { const next = historyAt + offset; if (next >= 0 && next < history.length) { const value = history[next]; setHistoryAt(next); setText(value);
    void window.scpefe.updateWorkingCopy({ content: value, cursor: { start: value.length, end: value.length } }).catch(fail); } }
  async function saveDocument() { try { const result = publication === "conflict" ? await window.scpefe.saveDivergenceResolution(text) : await window.scpefe.saveDocument(text);
    setText(result.content); setSaved(result.content); setLogicallyDirty(false); setPublication(result.publicationState); setOpened((old) => isOpened(old) ? { ...old, content: result.content,
      provisional: undefined, readOnly: result.publicationState !== "target-published", publicationState: result.publicationState } : old);
    setMessage(result.publicationState === "target-published" ? "Manual save published and verified." : result.publicationState === "conflict" ? "Divergence needs resolution." : "Manual save pending publication.");
    if (result.publicationState !== "target-published") setDialog("publication");
  } catch (value) { fail(value); } }
  async function chooseOpen() { try { const chosen = await window.scpefe.chooseOpenTarget(); if (chosen) { setPendingName(chosen.name); setDialog("open"); } } catch (value) { fail(value); } }
  async function submitPassword(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setError(""); const entered = String(new FormData(event.currentTarget).get("password"));
    try { const result = external ? await window.scpefe.openExternalDocument({ ...external, password: entered }) : dialog === "unlock"
      ? await window.scpefe.unlockDocument(entered) : await window.scpefe.openSelectedDocument(entered);
      if (result) { setExternal(null); present(result, pendingName || name); setPendingName(""); }
    } catch (value) { fail(value); requestAnimationFrame(() => password.current?.focus()); } }
  async function cancelPassword() { if (dialog === "open" && !external) await window.scpefe.cancelOpenTarget(); setExternal(null); setPendingName(""); setDialog(null); setError(""); }
  function findNext() { if (!find || !editor.current) return; let at = text.indexOf(find, editor.current.selectionEnd); if (at < 0) at = text.indexOf(find);
    if (at < 0) return setMessage("Text not found."); editor.current.focus(); editor.current.setSelectionRange(at, at + find.length); }
  function replaceOne() { if (!active || opened.readOnly || !editor.current) return; const start = editor.current.selectionStart, end = editor.current.selectionEnd;
    if (text.slice(start, end) !== find) return findNext(); modify(text.slice(0, start) + replacement + text.slice(end)); }
  const enabled: Record<string, boolean> = { new: Boolean(profile), open: Boolean(profile), save: active && !opened.readOnly && dirty,
    backup: active, export: active, close: active || locked, exit: true, edit: active && opened.readOnly && opened.canEdit && publication === "target-published",
    undo: active && !opened.readOnly && historyAt > 0, redo: active && !opened.readOnly && historyAt < history.length - 1,
    find: active, replace: active, lock: active || locked, passwords: active, profile: Boolean(profile) };
  async function run(command: string) { setError("");
    if (command === "new") try { if (await window.scpefe.prepareReplacement() && await window.scpefe.chooseCreateTarget()) setCreating(true); } catch (value) { fail(value); }
    if (command === "open") { try { if (await window.scpefe.prepareReplacement()) await chooseOpen(); } catch (value) { fail(value); } } if (command === "save") await saveDocument();
    if (command === "backup") try { if (await window.scpefe.backupDocument()) setMessage("Verified backup replica created."); } catch (value) { fail(value); }
    if (command === "export" || command === "profile" || command === "passwords" || command === "find" || command === "replace") setDialog(command as DialogName);
    if (command === "close") try { if (await window.scpefe.closeDocument()) { setOpened(null); setLockedName(""); setName(""); setText(""); setSaved(""); } } catch (value) { fail(value); }
    if (command === "exit") void window.scpefe.exitApplication();
    if (command === "lock") locked ? setDialog("unlock") : void window.scpefe.lock().catch(fail);
    if (command === "edit") try { setOpened(await window.scpefe.enterEditMode()); setMessage("Edit mode entered."); editor.current?.focus(); } catch (value) { fail(value); setDialog("edit-guard"); }
    if (command === "undo") move(-1); if (command === "redo") move(1);
  }
  useEffect(() => { const shortcut = (event: KeyboardEvent) => { if ((!event.ctrlKey && !event.metaKey)
      || creating || (dialog !== null && dialog !== "find" && dialog !== "replace")) return; const keys: Record<string, string> = {
    n: "new", o: "open", s: "save", w: "close", z: "undo", y: "redo", f: "find", h: "replace" }; const command = keys[event.key.toLowerCase()];
    if (command && enabled[command]) { event.preventDefault(); void run(command); } }; addEventListener("keydown", shortcut); return () => removeEventListener("keydown", shortcut); });

  const state = locked ? "Locked" : !active ? "No document" : opened.readOnly ? "Read-only" : "Edit mode";
  const persisted = !active ? "—" : `${dirty ? "Dirty" : "Clean"} · ${publication === "conflict" ? "Conflict · action required" : publication === "pending-publication" ? "Pending publication · action required" : opened.provisional ? "Provisional · manual save required" : "Published"}`;
  return <main className="app-shell"><div className="shell-chrome"><MenuBar enabled={enabled} locked={locked} run={(command) => void run(command)} />
    <section className="editor-surface" aria-label="Document workspace">{!active && <p className="editor-placeholder">{locked
      ? "This document is securely locked. Use Security → Unlock to continue." : "No document. Use File → New or File → Open."}</p>}
      <textarea ref={editor} aria-label="Document text" value={active ? text : ""} disabled={!active} readOnly={!active || opened.readOnly}
        onChange={(event) => modify(event.target.value)} /></section>
    <footer className="status-bar" role="status" aria-live="polite"><span>{state}</span><span>{persisted}</span><span>{message}</span></footer>
    {error && dialog === null && <div className="global-error" role="alert">{error}</div>}</div>
    {creating && <CreationSecurityDialog onCancel={async () => { await window.scpefe.cancelCreateTarget(); setCreating(false); }}
      onCreate={async (request: object) => { const result = await window.scpefe.createDocument(request); if (result) { setCreating(false);
        present(result.opened ?? { content: "", readOnly: false, canEdit: true, publicationState: "target-published" }, result.name ?? name);
        setMessage("Encrypted blank document published successfully."); } }} />}
    {(dialog === "open" || dialog === "unlock") && <Modal title={dialog === "unlock" ? "Unlock document" : "Open document"} close={() => void cancelPassword()} focus={password}>
      <form onSubmit={submitPassword}><label>Document password<input ref={password} name="password" type="password" required /></label>{error && <p role="alert" className="dialog-error">{error}</p>}
        <div className="dialog-actions"><button type="button" onClick={() => void cancelPassword()}>Cancel</button><button>{dialog === "unlock" ? "Unlock" : "Open"}</button></div></form></Modal>}
    {dialog === "profile" && <ProfileDialog profile={profile} settings={settings} required={!profile} close={() => setDialog(null)} save={async (value, nextSettings) => {
      if (profile && (profile.name !== value.name || profile.email !== value.email)) { setPendingProfile({ profile: value, settings: nextSettings }); setDialog("profile-warning"); return; }
      setProfile(await window.scpefe.saveProfile(value)); setSettings(await window.scpefe.saveClientSettings(nextSettings)); setDialog(null); setMessage("Local profile and client settings saved."); }} />}
    {dialog === "profile-warning" && pendingProfile && <Decision title="Change profile identity?" text="Previously claimed documents may require identity reconciliation after changing name or email."
      first="Save identity changes" second="Cancel" one={async () => { setProfile(await window.scpefe.saveProfile(pendingProfile.profile)); setSettings(await window.scpefe.saveClientSettings(pendingProfile.settings)); setPendingProfile(null); setDialog(null); }}
      two={() => { setPendingProfile(null); setDialog("profile"); }} />}
    {(dialog === "find" || dialog === "replace") && <Modeless close={() => { setDialog(null); editor.current?.focus(); }} focus={findInput}>
      <label>Find<input ref={findInput} value={find} onChange={(event) => setFind(event.target.value)} /></label><label>Replace with<input value={replacement} onChange={(event) => setReplacement(event.target.value)} /></label>
      <div className="dialog-actions"><button onClick={findNext}>Find next</button><button disabled={!active || opened.readOnly} onClick={replaceOne}>Replace</button>
        <button disabled={!active || opened.readOnly} onClick={() => find && modify(text.split(find).join(replacement))}>Replace all</button></div></Modeless>}
    {dialog === "export" && <Modal title="Export plaintext" close={() => setDialog(null)}><p className="warning"><strong>Not password protected:</strong> exported text may persist in backups or storage history.</p>
      <label>Line endings<select value={lineEndings} onChange={(event) => setLineEndings(event.target.value)}><option value="lf">Canonical LF</option><option value="native">Platform native</option></select></label>
      {error && <p role="alert" className="dialog-error">{error}</p>}<div className="dialog-actions"><button onClick={() => setDialog(null)}>Cancel</button><button onClick={async () => { try { if (await window.scpefe.exportPlaintext({ content: text, lineEndings })) { setDialog(null); setMessage("Unprotected plaintext exported."); } } catch (value) { fail(value); } }}>Export…</button></div></Modal>}
    {dialog === "passwords" && active && <Passwords opened={opened} update={(value) => setOpened(value)} close={() => setDialog(null)} result={(value) => { setTemporary(value); setDialog("invitation-result"); }} />}
    {dialog === "invitation-result" && <Modal title="Invitation created"><p>Temporary passphrase (shown once):</p><output className="temporary-password">{temporary}</output>
      <p className="warning">Send it separately using a secure channel.</p><div className="dialog-actions"><button onClick={() => void navigator.clipboard.writeText(temporary)}>Copy</button><button onClick={() => { setTemporary(""); setDialog(null); }}>Done</button></div></Modal>}
    {dialog === "claim" && <Modal title="Claim invitation"><p>Choose a private replacement password before document content is exposed.</p><form onSubmit={async (event) => { event.preventDefault(); try { present(await window.scpefe.claimInvitation(String(new FormData(event.currentTarget).get("password")))); } catch (value) { fail(value); } }}>
      <label>New password<input name="password" type="password" minLength={12} required autoFocus /></label>{error && <p role="alert" className="dialog-error">{error}</p>}<div className="dialog-actions"><button type="button" onClick={() => void window.scpefe.lock()}>Cancel and lock</button><button>Replace password and claim identity</button></div></form></Modal>}
    {dialog === "recovery" && isOpened(opened) && <Decision title="Recovered work" text="Recovered unsaved work is available. Restore or discard it before editing." first="Restore unsaved work" second="Discard recovered work"
      one={async () => { const recovered = await window.scpefe.restoreRecoveredWork(); setOpened({ ...opened, ...recovered, publicationState: opened.publicationState, readOnly: false });
        setText(recovered.content); setSaved(opened.content); setPublication(opened.publicationState); setLogicallyDirty(true); setDialog(null); setMessage("Recovered work restored as unsaved changes."); }}
      two={async () => present(await window.scpefe.discardRecoveredWork())} />}
    {dialog === "head" && isOpened(opened) && opened.headMismatch && <Decision title={opened.headMismatch.title} text={opened.headMismatch.explanation} first="Accept current authenticated head" one={async () => present(await window.scpefe.acceptHeadMismatch())} />}
    {dialog === "profile-mismatch" && <Decision title="Profile mismatch" text="The slot identity differs from this local profile. Editing remains blocked until reconciled." first="Reconcile identity and publish" one={async () => present(await window.scpefe.reconcileIdentity())} />}
    {dialog === "edit-guard" && <Decision title="Editing is unavailable" text={error || "The document remains read-only because an existing security, identity, lease, recovery, or publication guard blocked editing."}
      first="Keep read-only" one={() => { setDialog(null); setError(""); editor.current?.focus(); }} />}
    {dialog === "migration" && isOpened(opened) && <Decision title="Older container" text={opened.migrationWarning ?? "Migration is required before editing."} first="Create verified backup and migrate…" second="Keep read-only"
      one={async () => { const value = await window.scpefe.migrateDocument(); if (value) present(value.opened); }} two={() => setDialog(null)} />}
    {dialog === "publication" && isOpened(opened) && <Decision title={opened.provisional ? "Provisional save needs attention" : publication === "conflict" ? "Divergence needs resolution" : "Manual save pending publication"}
      text={opened.provisional ? "These changes remain logically unsaved until a manual save." : publication === "conflict" ? "The target changed. Resolve the preserved local and current versions before editing continues." : "The manual save is stored locally but has not reached its target."}
      first={opened.provisional ? "Enter edit mode and manually save" : publication === "conflict" ? "Begin conflict resolution" : "Retry publication"} second={opened.provisional ? "Discard provisional changes" : "Discard pending save"}
      one={async () => { if (opened.provisional) { const editable = await window.scpefe.enterEditMode(); setOpened(editable); const value = await window.scpefe.saveDocument(opened.content); setText(value.content); setSaved(value.content); setLogicallyDirty(false); setPublication(value.publicationState); setDialog(null); }
        else if (publication === "conflict") { const draft = await window.scpefe.beginDivergenceResolution(); setText(draft.content); setLogicallyDirty(true); setPublication("conflict"); setOpened({ ...opened, content: draft.content, readOnly: false }); setDialog(null); }
        else { const value = await window.scpefe.reconnectPendingPublication(); setText(value.content); setSaved(value.content); setPublication(value.publicationState); if (value.publicationState === "target-published") setDialog(null); } }}
      two={async () => present(opened.provisional ? await window.scpefe.discardRecoveredWork() : await window.scpefe.discardPendingPublication())} />}
  </main>;
}

function ProfileDialog({ profile, settings, required, close, save }: { profile: Profile | null; settings: Settings; required: boolean; close(): void; save(value: Profile, settings: Settings): Promise<void> }) {
  const [profileError, setProfileError] = useState("");
  return <Modal title={required ? "Set up this client" : "Profile"} close={required ? undefined : close}><form onSubmit={async (event) => { event.preventDefault(); const data = new FormData(event.currentTarget);
    try { await save({ name: String(data.get("name")), email: String(data.get("email")), deviceName: String(data.get("deviceName")) },
      { regularSaveEnabled: data.get("regularSaveEnabled") === "on", regularSaveIntervalMs: Number(data.get("regularSaveIntervalSeconds")) * 1000 }); }
    catch (value) { setProfileError(value instanceof Error ? value.message : String(value)); } }}>
    <label>Name<input name="name" defaultValue={profile?.name} required autoFocus /></label><label>Email<input name="email" type="email" defaultValue={profile?.email} required /></label>
    <label>Device name<input name="deviceName" defaultValue={profile?.deviceName} required /></label>
    <fieldset><legend>Regular saves</legend><label className="check"><input name="regularSaveEnabled" type="checkbox" defaultChecked={settings.regularSaveEnabled} /> Enable regular provisional saves</label>
      <label>Interval (seconds)<input name="regularSaveIntervalSeconds" type="number" min="10" max="86400" defaultValue={settings.regularSaveIntervalMs / 1000} required /></label>
      <small>Regular saves update the target but remain unsaved until a manual save.</small></fieldset>
      {profileError && <p role="alert" className="dialog-error">{profileError}</p>}
      <div className="dialog-actions">{!required && <button type="button" onClick={close}>Cancel</button>}
      {required && <button type="button" onClick={() => void window.scpefe.exitApplication()}>Exit</button>}<button>Save</button></div></form></Modal>;
}
function Decision({ title, text, first, second, one, two }: { title: string; text: string; first: string; second?: string; one(): unknown; two?: () => unknown }) {
  const [decisionError, setDecisionError] = useState("");
  const act = async (operation: () => unknown) => { setDecisionError(""); try { await operation(); } catch (value) { setDecisionError(value instanceof Error ? value.message : String(value)); } };
  return <Modal title={title}><p>{text}</p>{decisionError && <p role="alert" className="dialog-error">{decisionError}</p>}<div className="dialog-actions">
    {second && <button onClick={() => void act(() => two?.())}>{second}</button>}<button autoFocus onClick={() => void act(one)}>{first}</button></div></Modal>;
}
function Passwords({ opened, close, result, update }: { opened: Extract<Opened, { canEdit: boolean }>; close(): void; result(value: string): void; update(value: Extract<Opened, { canEdit: boolean }>): void }) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState("");
  const [passwordNotice, setPasswordNotice] = useState("");
  const [slots, setSlots] = useState(opened.managedSlots ?? []);
  return <Modal title="Passwords" close={close}><p>The permanent owner remains a full administrator and cannot be demoted or removed. The recovery password is also permanent.</p>{opened.canAddPasswords && !opened.readOnly && <form onSubmit={async (event) => { event.preventDefault(); const data = new FormData(event.currentTarget);
    try { const value = await window.scpefe.createInvitation({ temporaryLabel: String(data.get("label")), temporaryPassword: String(data.get("password")) || undefined,
      canEdit: data.get("edit") === "on", canAddPasswords: false, canRemovePasswords: false }); result(value.temporaryPassword); }
    catch (value) { setPasswordError(value instanceof Error ? value.message : String(value)); } }}>
    <h3>Invite another person</h3><label>Temporary label<input name="label" required /></label><label>Temporary passphrase (leave blank to generate)<input name="password" type="password" /></label>
    <label className="check"><input name="edit" type="checkbox" /> May edit</label><button>Create invitation</button></form>}
    {slots.map((slot) => <section className="managed-slot" key={slot.slotId}><h3>{slot.identityKnown === false ? slot.identityName : `${slot.identityName} · ${slot.identityEmail}`}</h3><p>{slot.mustBeChangedKnown === false ? "Invitation claim state is protected until authentication." : slot.mustBeChanged ? "Invitation not yet claimed" : slot.canEdit ? "Editor" : "View-only"}</p>
      <form onSubmit={async (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); try { const changed = await window.scpefe.updateSlotPermissions({ slotId: slot.slotId,
        canEdit: data.get("edit") === "on", canAddPasswords: data.get("add") === "on", canRemovePasswords: data.get("remove") === "on" }); update(changed); setSlots(changed.managedSlots ?? []); }
        catch (value) { setPasswordError(value instanceof Error ? value.message : String(value)); } }}>
        <fieldset disabled={opened.readOnly || !opened.canAddPasswords || !opened.canRemovePasswords}><legend>Permissions for {slot.identityName}</legend>
          <label className="check"><input name="edit" type="checkbox" defaultChecked={slot.canEdit} /> May edit</label>
          <label className="check"><input name="add" type="checkbox" defaultChecked={slot.canAddPasswords} /> May add passwords</label><label className="check"><input name="remove" type="checkbox" defaultChecked={slot.canRemovePasswords} /> May remove passwords</label>
          <small>Password administration implies edit permission.</small><button>Publish permission changes</button></fieldset></form>
      {opened.canRemovePasswords && !opened.readOnly && removing !== slot.slotId && <button onClick={() => setRemoving(slot.slotId)}>Remove this password slot…</button>}
      {removing === slot.slotId && <div className="warning" role="alert"><p>Removal cannot revoke plaintext, keys already obtained, or older replicas.</p>
        <button onClick={async () => { try { const removal = await window.scpefe.removeSlot(slot.slotId); setSlots((values) => values.filter((value) => value.slotId !== slot.slotId)); setPasswordNotice(removal.warning); setRemoving(null); } catch (value) { setPasswordError(value instanceof Error ? value.message : String(value)); } }}>Confirm slot removal</button><button onClick={() => setRemoving(null)}>Cancel</button></div>}
    </section>)}
    {compactionAvailable(opened) && <CompactionControls onCompact={async () => { await window.scpefe.compactDocument(); }} />}
    {passwordError && <p role="alert" className="dialog-error">{passwordError}</p>}{passwordNotice && <p role="status">{passwordNotice}</p>}<div className="dialog-actions"><button onClick={close}>Close</button></div></Modal>;
}

createRoot(document.getElementById("root")!).render(<App />);
