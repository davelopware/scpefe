import React, { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { compactionAvailable, CompactionControls } from "./compaction-controls.mjs";
import { CreationSecurityDialog } from "./creation-security-dialog.mjs";
import "./styles.css";

type Profile = { name: string; email: string; deviceName: string };
type Cursor = { start: number; end: number };
type Recovery = { content: string; state: "unsaved"; updateTime: number; cursor: Cursor;
  authorName?: string; deviceName?: string };
type Lease = { active: boolean; holderName: string; holderEmail: string;
  deviceName: string; holderUtcMs: number; durationMs: number };
type HeadMismatch = { kind: "rollback" | "divergence" | "replacement" | "witness-error";
  title: string; explanation: string; editingBlocked: true };
type PublicationState = "target-published" | "pending-publication" | "conflict";
type SaveState = "unsaved" | "provisional" | PublicationState;
type ClientSettings = { regularSaveEnabled: boolean; regularSaveIntervalMs: number };
type JournalSummary = { total: number; pendingPublications: number };
type ExternalOpenRequest = { token: string };
type ProfileMismatch = { slotName: string; slotEmail: string;
  profileName: string; profileEmail: string; editingBlocked: true };
type ManagedSlot = { slotId: string; identityName: string; identityEmail: string;
  canEdit: boolean; canAddPasswords: boolean; canRemovePasswords: boolean;
  mustBeChanged: boolean; slotIdKnown?: boolean; permissionsKnown?: boolean;
  mustBeChangedKnown?: boolean; identityKnown?: boolean };
type MergeDraft = { content: string; hasConflicts: boolean;
  ancestorRevision: string; localRevision: string; currentRevision: string };
type LeaseDecision = { decisionRequired: "lease-takeover"; holderName: string };
type DocumentOpened = { content: string; readOnly: boolean; canEdit: boolean;
  publicationState: PublicationState; recovery?: Recovery; lease?: Lease;
  targetName?: string;
  canAddPasswords?: boolean; canRemovePasswords?: boolean; invitationRequired?: false;
  recoverySlot?: boolean; slotId?: string; slotIdentityName?: string;
  slotIdentityEmail?: string;
  headMismatch?: HeadMismatch; profileMismatch?: ProfileMismatch;
  managedSlots?: ManagedSlot[]; provisional?: true; migrationRequired?: true;
  migrationWarning?: string };
type Opened = DocumentOpened | { readOnly: true; invitationRequired: true;
  targetName?: string };
type DialogName = "profile" | "open" | "find" | "replace" | "export"
  | "unlock" | "passwords" | "compaction" | null;
type OpenedDialogName = "claim" | "migration" | "profile-mismatch" | "head"
  | "recovery" | "publication" | null;

function isDocumentOpened(value: Opened | null): value is DocumentOpened {
  return value !== null && value.invitationRequired !== true;
}

function openedDialogName(value: Opened | null): OpenedDialogName {
  if (value?.invitationRequired) return "claim";
  if (!isDocumentOpened(value)) return null;
  if (value.migrationRequired) return "migration";
  if (value.profileMismatch) return "profile-mismatch";
  if (value.headMismatch) return "head";
  if (value.recovery) return "recovery";
  if (value.publicationState === "pending-publication"
    || value.publicationState === "conflict") return "publication";
  return null;
}

const menuDefinitions: Array<[string, Array<[string, string, string?] | null>]> = [
  ["File", [["new", "New", "Ctrl+N"], ["open", "Open…", "Ctrl+O"], null,
    ["save", "Save", "Ctrl+S"], ["backup", "Backup…"],
    ["export", "Export Plaintext…"], null, ["close", "Close", "Ctrl+W"],
    ["exit", "Exit"]]],
  ["Edit", [["edit", "Edit Contents"], null, ["undo", "Undo", "Ctrl+Z"],
    ["redo", "Redo", "Ctrl+Y"], null, ["find", "Find…", "Ctrl+F"],
    ["replace", "Replace…", "Ctrl+H"]]],
  ["Security", [["lock", "Lock"], ["unlock", "Unlock"], null,
    ["passwords", "Passwords…"],
    ["profile", "Profile…"]]],
];

function MenuBar({ enabled, run }: { enabled: Record<string, boolean>;
  run(command: string, returnFocus: HTMLButtonElement): void }) {
  const [open, setOpen] = useState<string | null>(null);
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
  const menus = useRef<Record<string, HTMLDivElement | null>>({});
  const focusFirst = (name: string) => requestAnimationFrame(() =>
    menus.current[name]?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
  const openMenu = (name: string) => { setOpen(name); focusFirst(name); };
  useEffect(() => {
    const accessKey = (event: globalThis.KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey
        || document.querySelector(".shell-chrome")?.hasAttribute("inert")) return;
      const match = menuDefinitions.find(([name]) =>
        name[0].toLowerCase() === event.key.toLowerCase());
      if (!match) return;
      event.preventDefault(); openMenu(match[0]);
    };
    window.addEventListener("keydown", accessKey);
    return () => window.removeEventListener("keydown", accessKey);
  }, []);
  return <nav className="menu-bar" role="menubar" aria-label="Application menu">
    {menuDefinitions.map(([name, items], menuIndex) => <div className="menu" key={name}>
      <button type="button" role="menuitem" aria-label={name} aria-haspopup="menu"
        aria-expanded={open === name} ref={(node) => { triggers.current[name] = node; }}
        onClick={() => open === name ? setOpen(null) : openMenu(name)}
        onKeyDown={(event) => {
          if (["ArrowDown", "Enter", " "].includes(event.key)) {
            event.preventDefault(); openMenu(name);
          } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            const offset = event.key === "ArrowRight" ? 1 : menuDefinitions.length - 1;
            const next = menuDefinitions[(menuIndex + offset) % menuDefinitions.length][0];
            if (open !== null) { setOpen(next); focusFirst(next); }
            triggers.current[next]?.focus();
          }
        }}><u>{name[0]}</u>{name.slice(1)}</button>
      {open === name && <div role="menu" aria-label={name}
        ref={(node) => { menus.current[name] = node; }} onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault(); setOpen(null); triggers.current[name]?.focus(); return;
          }
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            const offset = event.key === "ArrowRight" ? 1 : menuDefinitions.length - 1;
            const next = menuDefinitions[(menuIndex + offset) % menuDefinitions.length][0];
            setOpen(next); triggers.current[next]?.focus(); focusFirst(next); return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)")];
            const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const offset = event.key === "ArrowDown" ? 1 : buttons.length - 1;
            buttons[(Math.max(at, 0) + offset) % buttons.length]?.focus();
          }
        }}>{items.map((item, index) => item === null
          ? <hr key={index} role="separator" />
          : <button key={item[0]} type="button" role="menuitem"
            disabled={!enabled[item[0]]} onClick={() => {
              const returnFocus = triggers.current[name];
              returnFocus?.focus(); setOpen(null);
              if (returnFocus) run(item[0], returnFocus);
              requestAnimationFrame(() => {
                if (!document.querySelector('[role="dialog"]')) triggers.current[name]?.focus();
              });
            }}><span>{item[1]}</span>{item[2] && <kbd>{item[2]}</kbd>}</button>)}</div>}
    </div>)}</nav>;
}

let modalDepth = 0;
function FocusedDialog({ title, children, close, initialFocus, returnFocus }: {
  title: string; children: React.ReactNode; close?: () => void;
  initialFocus?: React.RefObject<HTMLElement | null>; returnFocus?: HTMLElement | null }) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const prior = returnFocus ?? document.activeElement as HTMLElement | null;
    const chrome = document.querySelector<HTMLElement>(".shell-chrome");
    modalDepth += 1; chrome?.setAttribute("inert", "");
    (initialFocus?.current ?? dialog.current?.querySelector<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)"))?.focus();
    return () => { modalDepth -= 1; if (modalDepth === 0) chrome?.removeAttribute("inert");
      requestAnimationFrame(() => {
        if (modalDepth !== 0 || document.querySelector('[aria-modal="true"]')) return;
        if (prior?.isConnected) prior.focus();
        else document.querySelector<HTMLElement>('[role="menubar"] > .menu > [role="menuitem"]')?.focus();
      }); };
  }, []);
  return <div className="dialog-backdrop" onKeyDown={(event) => {
    if (event.key === "Escape" && close) { event.preventDefault(); close(); return; }
    if (event.key !== "Tab" || !dialog.current) return;
    const controls = [...dialog.current.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)")];
    if (!controls.length) return;
    const at = controls.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (at <= 0 ? controls.length - 1 : at - 1)
      : (at >= controls.length - 1 ? 0 : at + 1);
    event.preventDefault(); controls[next].focus();
  }}><section ref={dialog} className="app-dialog" role="dialog" aria-modal="true"
    aria-labelledby="focused-dialog-title"><h2 id="focused-dialog-title">{title}</h2>
    {children}</section></div>;
}

function ManagedSlotControls({ slot, canUpdate, canRemove, onUpdate, onRemove }: {
  slot: ManagedSlot; canUpdate: boolean; canRemove: boolean;
  onUpdate(slot: ManagedSlot, canEdit: boolean, canAddPasswords: boolean,
    canRemovePasswords: boolean): Promise<void>;
  onRemove(slot: ManagedSlot): Promise<void>;
}) {
  const [canEdit, setCanEdit] = useState(slot.canEdit);
  const [canAddPasswords, setCanAddPasswords] = useState(slot.canAddPasswords);
  const [canRemovePasswords, setCanRemovePasswords] = useState(slot.canRemovePasswords);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const label = slot.identityKnown === false
    ? slot.identityName : `${slot.identityName} · ${slot.identityEmail}`;
  const updateEdit = (enabled: boolean) => {
    setCanEdit(enabled);
    if (!enabled) { setCanAddPasswords(false); setCanRemovePasswords(false); }
  };
  const updateAdministration = (kind: "add" | "remove", enabled: boolean) => {
    if (enabled) setCanEdit(true);
    if (kind === "add") setCanAddPasswords(enabled);
    else setCanRemovePasswords(enabled);
  };
  return <li className="managed-slot"><h4>{label}</h4>
    {slot.identityKnown === false && <p>Identity is unknown until this legacy slot authenticates and reconciles.</p>}
    {slot.permissionsKnown === false && <p>Current permissions are unknown. Saving replaces them with the choices below.</p>}
    {slot.mustBeChangedKnown === false
      ? <p>Claim state is protected by the slot password and is not yet known administratively.</p>
      : slot.mustBeChanged && <p>Invitation not yet claimed; its temporary password must be replaced.</p>}
    <form onSubmit={(event) => { event.preventDefault(); void onUpdate(slot,
      canEdit, canAddPasswords, canRemovePasswords); }}>
      <fieldset disabled={!canUpdate}><legend>Permissions for {label}</legend>
        <label className="check"><input type="checkbox" checked={canEdit}
          onChange={(event) => updateEdit(event.target.checked)} /> May edit</label>
        <label className="check"><input type="checkbox" checked={canAddPasswords}
          onChange={(event) => updateAdministration("add", event.target.checked)} /> May add passwords</label>
        <label className="check"><input type="checkbox" checked={canRemovePasswords}
          onChange={(event) => updateAdministration("remove", event.target.checked)} /> May remove passwords</label>
        <small>Password administration always implies edit permission.</small>
        <button type="submit">Publish permission changes</button>
      </fieldset>
    </form>
    {canRemove && !confirmRemoval && <button type="button"
      onClick={() => setConfirmRemoval(true)}>Remove this password slot…</button>}
    {canRemove && confirmRemoval && <div className="warning" role="alert">
      <p>Removal blocks this password only in the updated document. It cannot revoke plaintext, keys already obtained, or older replicas.</p>
      <div className="toolbar"><button type="button" onClick={() => { setConfirmRemoval(false);
        void onRemove(slot); }}>Confirm slot removal</button>
        <button type="button" onClick={() => setConfirmRemoval(false)}>Cancel</button></div>
    </div>}
  </li>;
}

function SlotAdministration({ opened, onUpdate, onRemove, onCompact }: {
  opened: DocumentOpened;
  onUpdate(slot: ManagedSlot, canEdit: boolean, canAddPasswords: boolean,
    canRemovePasswords: boolean): Promise<void>;
  onRemove(slot: ManagedSlot): Promise<void>;
  onCompact(): Promise<void>;
}) {
  const slots = opened.managedSlots ?? [];
  const canUpdate = compactionAvailable(opened);
  const canRemove = !opened.readOnly && opened.canRemovePasswords === true;
  return <aside className="slot-administration" aria-labelledby="slot-administration-heading">
    <h2 id="slot-administration-heading">Password-slot administration</h2>
    <p>The permanent owner remains a full administrator and cannot be demoted or removed. The recovery password is also permanent and is never listed as an ordinary slot.</p>
    {opened.readOnly && <p>Enter edit mode to publish permission changes or remove a slot.</p>}
    {canUpdate && <CompactionControls onCompact={onCompact} />}
    <p className="warning">Removing a slot affects only this updated document and does not revoke older copies or information already obtained.</p>
    {slots.length === 0 ? <p>No ordinary invitation slots exist.</p>
      : <ul className="managed-slots">{slots.map((slot) =>
        <ManagedSlotControls key={`${slot.slotId}-${slot.canEdit}-${slot.canAddPasswords}-${slot.canRemovePasswords}`}
          slot={slot} canUpdate={canUpdate} canRemove={canRemove}
          onUpdate={onUpdate} onRemove={onRemove} />)}</ul>}
  </aside>;
}

type LockResult = { locked: true; journalSaved: boolean; warning: string | null };
declare global { interface Window { scpefe: {
  getProfile(): Promise<Profile | null>;
  saveProfile(profile: Profile): Promise<Profile>;
  reconcileProfile(): Promise<DocumentOpened | null>;
  getClientSettings(): Promise<ClientSettings>;
  saveClientSettings(settings: ClientSettings): Promise<ClientSettings>;
  getUnresolvedJournalSummary(): Promise<JournalSummary>;
  chooseCreateTarget(): Promise<{ selected: true } | null>;
  cancelCreateTarget(): Promise<void>;
  createDocument(request: object): Promise<{ created: true; opened: DocumentOpened;
    name: string } | null>;
  chooseOpenTarget(): Promise<{ selected: true; name: string } | null>;
  cancelOpenTarget(): Promise<void>;
  openSelectedDocument(password: string): Promise<Opened>;
  unlockDocument(password: string): Promise<Opened>;
  openExternalDocument(request: ExternalOpenRequest & { password: string }):
    Promise<Opened | null>;
  enterEditMode(request?: { forceTakeover: boolean }): Promise<DocumentOpened | LeaseDecision>;
  saveDocument(content: string): Promise<{ saved: true; content: string;
    publicationState: PublicationState }>;
  reconnectPendingPublication(): Promise<{ content: string;
    publicationState: PublicationState }>;
  beginDivergenceResolution(): Promise<MergeDraft>;
  saveDivergenceResolution(content: string): Promise<{ saved: true; content: string;
    publicationState: PublicationState }>;
  discardPendingPublication(): Promise<DocumentOpened>;
  backupDocument(): Promise<{ backedUp: true } | null>;
  compactDocument(request: { confirmed: true }): Promise<{ compacted: true; backupCreated: true;
    previousHead: string; head: string } | null>;
  migrateDocument(request?: { forceTakeover: boolean }): Promise<{
    migrated: true; backupCreated: true; compatibilityWarning: string;
    opened: DocumentOpened } | LeaseDecision | null>;
  changePassword(request: { currentPassword: string; newPassword: string;
    newPasswordConfirmation: string }): Promise<DocumentOpened>;
  createInvitation(request: object): Promise<{ created: true; temporaryPassword: string }>;
  copyInvitationPassphrase(password: string): Promise<boolean>;
  claimInvitation(request: { newPassword: string;
    newPasswordConfirmation: string }): Promise<DocumentOpened>;
  cancelInvitationClaim(): Promise<boolean>;
  reconcileIdentity(): Promise<DocumentOpened>;
  updateSlotPermissions(request: object): Promise<DocumentOpened>;
  removeSlot(slotId: string): Promise<{ removed: true; warning: string }>;
  exportPlaintext(request: { content: string; lineEndings: "lf" | "native" }):
    Promise<{ exported: true } | null>;
  updateWorkingCopy(value: { content: string; cursor: Cursor }): Promise<object>;
  activity(): Promise<object>;
  restoreRecoveredWork(): Promise<DocumentOpened & { recoveredUnsaved: true; cursor: Cursor }>;
  discardRecoveredWork(): Promise<DocumentOpened>;
  acceptHeadMismatch(): Promise<DocumentOpened>;
  lock(): Promise<LockResult>;
  onLocked(listener: (result: LockResult) => void): () => void;
  onJournalWarning(listener: (warning: string) => void): () => void;
  onRegularSave(listener: (result: { published: true; provisional: true;
    content: string }) => void): () => void;
  onExternalOpenRequested(listener: (request: ExternalOpenRequest) => void): () => void;
  onUnresolvedJournalSummary(listener: (summary: JournalSummary) => void): () => void;
  onSwitchRetained(listener: (opened: DocumentOpened) => void): () => void;
}; } }

function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [clientSettings, setClientSettings] = useState<ClientSettings>({
    regularSaveEnabled: false, regularSaveIntervalMs: 120_000,
  });
  const [opened, setOpened] = useState<Opened | null>(null);
  const [message, setMessage] = useState("");
  const [workingText, setWorkingText] = useState("");
  const [manualSavedText, setManualSavedText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("target-published");
  const [history, setHistory] = useState<string[]>([""]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [lineEndings, setLineEndings] = useState<"lf" | "native">("lf");
  const [journalSummary, setJournalSummary] = useState<JournalSummary>({
    total: 0, pendingPublications: 0,
  });
  const [externalOpenRequest, setExternalOpenRequest] =
    useState<ExternalOpenRequest | null>(null);
  const [queuedExternalOpenRequest, setQueuedExternalOpenRequest] =
    useState<ExternalOpenRequest | null>(null);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [creating, setCreating] = useState(false);
  const [openError, setOpenError] = useState("");
  const [pendingOpenName, setPendingOpenName] = useState("");
  const [invitationStaged, setInvitationStaged] = useState(false);
  const [targetName, setTargetName] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [editFailure, setEditFailure] = useState<string | null>(null);
  const [leaseDecision, setLeaseDecision] = useState<{
    operation: "edit" | "migration"; holderName: string } | null>(null);
  const [decisionError, setDecisionError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [compactionError, setCompactionError] = useState("");
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const [pendingProfile, setPendingProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [invitationPassphrase, setInvitationPassphrase] = useState<string | null>(null);
  const [invitationError, setInvitationError] = useState("");
  const [claimError, setClaimError] = useState("");
  const editor = useRef<HTMLTextAreaElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const openPassword = useRef<HTMLInputElement>(null);
  const profileConfirmation = useRef<HTMLButtonElement>(null);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);
  const targetNameRef = useRef<string | null>(null);
  const modalBusy = useRef(false);
  const openedDialog = openedDialogName(opened);
  const visibleOpenedDialog = !creating && dialog === null && !resolvingConflict
    && leaseDecision === null && saveError === ""
    ? invitationStaged ? "claim" : openedDialog : null;
  modalBusy.current = creating || dialog !== null || visibleOpenedDialog !== null
    || invitationStaged
    || editFailure !== null || leaseDecision !== null || saveError !== "";
  useEffect(() => {
    window.scpefe.getProfile().then((value) => {
      setProfile(value); if (!value) setDialog("profile");
    }).catch(showError);
    window.scpefe.getClientSettings().then(setClientSettings).catch(showError);
    window.scpefe.getUnresolvedJournalSummary().then(setJournalSummary).catch(showError);
  }, []);
  const showError = (error: unknown) => setMessage(error instanceof Error ? error.message : String(error));
  useEffect(() => {
    const stopLocked = window.scpefe.onLocked(showLockedResult);
    const stopWarning = window.scpefe.onJournalWarning(setMessage);
    const stopRegularSave = window.scpefe.onRegularSave((result) => {
      setSaveState("provisional");
      setOpened((current) => isDocumentOpened(current) ? { ...current,
        content: result.content, provisional: true } : current);
      setMessage("Regular save published provisionally; changes remain unsaved until manual save.");
    });
    const stopExternalOpen = window.scpefe.onExternalOpenRequested((request) => {
      if (modalBusy.current) {
        setQueuedExternalOpenRequest(request);
        setMessage("Another open request is waiting for the current dialog.");
      } else {
        dialogReturnFocus.current = document.activeElement as HTMLElement | null;
        setExternalOpenRequest(request); setDialog("open");
        setMessage("Another open request is waiting. Enter its document password to continue.");
      }
    });
    const stopJournalSummary = window.scpefe.onUnresolvedJournalSummary(
      setJournalSummary);
    const stopSwitchRetained = window.scpefe.onSwitchRetained((result) => {
      showOpenedResult(result);
      setMessage("The current document remains open with its manual save pending publication.");
    });
    const activity = () => { void window.scpefe.activity(); };
    window.addEventListener("keydown", activity);
    window.addEventListener("pointerdown", activity);
    return () => {
      stopLocked(); stopWarning(); stopRegularSave(); stopExternalOpen();
      stopJournalSummary();
      stopSwitchRetained();
      window.removeEventListener("keydown", activity);
      window.removeEventListener("pointerdown", activity);
    };
  }, []);
  useEffect(() => {
    if (!creating && dialog === null && openedDialog === null && queuedExternalOpenRequest) {
      dialogReturnFocus.current = document.activeElement as HTMLElement | null;
      setExternalOpenRequest(queuedExternalOpenRequest);
      setQueuedExternalOpenRequest(null);
      setDialog("open");
      setMessage("Another open request is waiting. Enter its document password to continue.");
    }
  }, [creating, dialog, openedDialog, queuedExternalOpenRequest]);

  function showOpenedResult(result: Opened | null) {
    setOpened(result);
    const content = result && !result.invitationRequired ? result.content : "";
    if (result) {
      setLocked(false);
      if (result.targetName) {
        targetNameRef.current = result.targetName;
        setTargetName(result.targetName);
      }
    }
    setWorkingText(content);
    setManualSavedText(content);
    setDirty(Boolean(result && !result.invitationRequired && result.provisional));
    setSaveState(result && !result.invitationRequired && result.provisional ? "provisional"
      : result && !result.invitationRequired && result.recovery ? "unsaved"
      : result && !result.invitationRequired
        ? result.publicationState : "target-published");
    setHistory([content]);
    setHistoryIndex(0);
    if (result && !result.invitationRequired && result.recovery) {
      const source = [result.recovery.authorName, result.recovery.deviceName]
        .filter(Boolean).join(" on ");
      setMessage(`Recovered unsaved work${source ? ` from ${source}` : ""}. Restore or discard it before editing.`);
    } else if (result && !result.invitationRequired && result.lease?.active) {
      setMessage(`Editing lease held by ${result.lease.holderName || "another editor"} (${result.lease.holderEmail}) on ${result.lease.deviceName}.`);
    }
  }

  function showReplacementResult(result: Opened) {
    if (result.invitationRequired) {
      setInvitationStaged(true);
      setMessage("Claim the invitation before its document replaces the current session.");
      return;
    }
    setInvitationStaged(false);
    showOpenedResult(result);
  }

  const activeDocument = isDocumentOpened(opened);
  const lockedDocument = locked && targetName !== null;
  const enabled: Record<string, boolean> = {
    new: profile !== null, open: profile !== null,
    save: activeDocument && !opened.readOnly && dirty,
    backup: activeDocument, export: activeDocument, close: false, exit: true,
    edit: activeDocument && opened.readOnly && opened.canEdit
      && opened.publicationState === "target-published" && !opened.recovery
      && !opened.headMismatch && !opened.profileMismatch && !opened.migrationRequired,
    undo: activeDocument && !opened.readOnly && historyIndex > 0,
    redo: activeDocument && !opened.readOnly && historyIndex < history.length - 1,
    find: activeDocument, replace: activeDocument && !opened.readOnly,
    lock: activeDocument, unlock: lockedDocument,
    passwords: activeDocument, profile: profile !== null,
  };

  async function runCommand(command: string, returnFocus?: HTMLElement | null) {
    if (modalBusy.current) return;
    if (returnFocus?.isConnected) dialogReturnFocus.current = returnFocus;
    if (command === "new") {
      try { if (await window.scpefe.chooseCreateTarget()) setCreating(true); }
      catch (error) { showError(error); }
    } else if (command === "open") {
      try {
        const selected = await window.scpefe.chooseOpenTarget();
        if (selected) {
          setPendingOpenName(selected.name); setOpenError(""); setDialog("open");
        }
      } catch (error) { showError(error); }
    } else if (command === "find" || command === "replace"
      || command === "export" || command === "passwords" || command === "profile") {
      setDialog(command as DialogName);
    } else if (command === "save") await save();
    else if (command === "backup") await backup();
    else if (command === "edit") await enterEditMode();
    else if (command === "undo") moveHistory(-1);
    else if (command === "redo") moveHistory(1);
    else if (command === "lock") await lock();
    else if (command === "unlock") {
      setOpenError(""); setDialog("unlock");
    }
    else if (command === "exit") window.close();
  }

  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || (!event.ctrlKey && !event.metaKey)
        || event.altKey || modalBusy.current) return;
      const commands: Record<string, string> = { n: "new", o: "open", s: "save",
        w: "close", z: "undo", y: "redo", f: "find", h: "replace" };
      const command = commands[event.key.toLowerCase()];
      if (command && enabled[command]) { event.preventDefault();
        void runCommand(command, document.activeElement as HTMLElement | null); }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const candidate = {
      name: String(data.get("name")), email: String(data.get("email")),
      deviceName: String(data.get("deviceName")),
    };
    if (profile && (candidate.name.trim() !== profile.name
        || candidate.email.trim() !== profile.email)) {
      setPendingProfile(candidate);
      setProfileError("");
      return;
    }
    await commitProfile(candidate);
  }

  async function commitProfile(candidate: Profile) {
    try {
      const identityChanged = profile !== null
        && (profile.name !== candidate.name || profile.email !== candidate.email);
      const saved = await window.scpefe.saveProfile(candidate);
      const authoritative = identityChanged ? await window.scpefe.reconcileProfile() : null;
      setProfile(saved);
      setPendingProfile(null);
      setProfileError("");
      if (authoritative) setOpened(authoritative);
      setDialog(null);
      setMessage("Local profile saved.");
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : String(error));
      requestAnimationFrame(() => profileConfirmation.current?.focus());
    }
  }

  async function saveClientSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const result = await window.scpefe.saveClientSettings({
        regularSaveEnabled: data.get("regularSaveEnabled") === "on",
        regularSaveIntervalMs: Number(data.get("regularSaveIntervalSeconds")) * 1000,
      });
      setClientSettings(result);
      setMessage(result.regularSaveEnabled
        ? "Regular provisional saves enabled." : "Regular provisional saves disabled.");
    } catch (error) { showError(error); }
  }

  async function open(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      setOpenError("");
      const result = dialog === "unlock"
        ? await window.scpefe.unlockDocument(String(data.get("password")))
        : await window.scpefe.openSelectedDocument(String(data.get("password")));
      showReplacementResult(result);
      setPendingOpenName(""); setDialog(null);
    }
    catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
      requestAnimationFrame(() => openPassword.current?.focus());
    }
  }

  async function cancelOpen() {
    try {
      if (dialog === "open" && !externalOpenRequest) await window.scpefe.cancelOpenTarget();
    } catch (error) { showError(error); }
    setExternalOpenRequest(null); setPendingOpenName(""); setOpenError(""); closeDialog();
  }

  async function openExternal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!externalOpenRequest) return;
    const data = new FormData(event.currentTarget);
    try {
      const result = await window.scpefe.openExternalDocument({
        ...externalOpenRequest, password: String(data.get("password")),
      });
      setExternalOpenRequest(null);
      if (result) { showReplacementResult(result); setDialog(null); }
      else setMessage("Open request canceled; the current document remains open.");
      setJournalSummary(await window.scpefe.getUnresolvedJournalSummary());
    } catch (error) { showError(error); }
  }

  async function enterEditMode() {
    try {
      const result = await window.scpefe.enterEditMode({ forceTakeover: false });
      if ("decisionRequired" in result) {
        setLeaseDecision({ operation: "edit", holderName: result.holderName });
        setDecisionError("");
        setMessage("Editing requires a confirmed lease takeover.");
        return;
      }
      setOpened(result);
      setMessage("Edit mode entered.");
    } catch (error) {
      setEditFailure(error instanceof Error ? error.message : String(error));
    }
  }

  async function migrate(forceTakeover = false) {
    try {
      setDecisionError("");
      const result = await window.scpefe.migrateDocument({ forceTakeover });
      if (!result) {
        setMessage("Migration declined. The document remains read-only; saving requires migration.");
        return;
      }
      if ("decisionRequired" in result) {
        setLeaseDecision({ operation: "migration", holderName: result.holderName });
        setMessage("Migration requires a confirmed lease takeover.");
        return;
      }
      setLeaseDecision(null);
      setOpened(result.opened);
      setWorkingText(result.opened.content);
      setMessage(result.compatibilityWarning);
    } catch (error) {
      const value = error instanceof Error ? error.message : String(error);
      setDecisionError(value); setMessage(`Migration needs attention: ${value}`);
    }
  }

  async function confirmLeaseTakeover() {
    if (!leaseDecision) return;
    try {
      setDecisionError("");
      if (leaseDecision.operation === "migration") {
        await migrate(true);
        return;
      }
      const result = await window.scpefe.enterEditMode({ forceTakeover: true });
      if ("decisionRequired" in result) throw new Error("Lease evidence is still uncertain");
      setOpened(result); setLeaseDecision(null); setMessage("Edit mode entered after confirmed lease takeover.");
    } catch (error) {
      const value = error instanceof Error ? error.message : String(error);
      setDecisionError(value); setMessage(`Lease takeover needs attention: ${value}`);
    }
  }

  async function claimInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get("newPassword"));
    if (password !== String(data.get("newPasswordConfirmation"))) {
      setClaimError("Replacement passwords do not match.");
      requestAnimationFrame(() => form.elements.namedItem(
        "newPasswordConfirmation") instanceof HTMLElement
        && (form.elements.namedItem("newPasswordConfirmation") as HTMLElement).focus());
      return;
    }
    try {
      setClaimError("");
      const result = await window.scpefe.claimInvitation({ newPassword: password,
        newPasswordConfirmation: String(data.get("newPasswordConfirmation")) });
      form.reset();
      setInvitationStaged(false); showOpenedResult(result);
      setMessage("Invitation claimed and replacement password safely published.");
    } catch (error) {
      setClaimError(error instanceof Error ? error.message : String(error));
      requestAnimationFrame(() => (form.elements.namedItem(
        "newPassword") as HTMLElement | null)?.focus());
    }
  }

  async function cancelInvitationClaim() {
    try {
      if (!await window.scpefe.cancelInvitationClaim()) {
        throw new Error("The invitation claim is no longer staged");
      }
      setClaimError("");
      setInvitationStaged(false);
      setMessage("Invitation claim canceled; the current session is unchanged.");
    } catch (error) {
      setClaimError(error instanceof Error ? error.message : String(error));
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      setPasswordError("");
      const result = await window.scpefe.changePassword({
        currentPassword: String(data.get("currentPassword")),
        newPassword: String(data.get("newPassword")),
        newPasswordConfirmation: String(data.get("newPasswordConfirmation")),
      });
      form.reset();
      setOpened(result);
      setMessage("Password changed and the updated document was published safely.");
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : String(error));
      requestAnimationFrame(() => {
        const current = form.elements.namedItem("currentPassword") as HTMLElement | null;
        current?.focus();
      });
    }
  }

  async function createInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const result = await window.scpefe.createInvitation({
        temporaryLabel: String(data.get("temporaryLabel")),
        temporaryPassword: String(data.get("temporaryPassword")) || undefined,
        canEdit: data.get("canEdit") === "on",
        canAddPasswords: data.get("canAddPasswords") === "on",
        canRemovePasswords: data.get("canRemovePasswords") === "on",
      });
      setInvitationError("");
      setInvitationPassphrase(result.temporaryPassword);
      form.reset();
    } catch (error) {
      setInvitationError(error instanceof Error ? error.message : String(error));
    }
  }

  async function reconcileIdentity() {
    try {
      setPasswordError("");
      const result = await window.scpefe.reconcileIdentity();
      setOpened(result);
      setMessage("Password-slot identity reconciled through a sealed publication.");
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : String(error));
    }
  }

  async function updateManagedSlot(slot: ManagedSlot, canEdit: boolean,
    canAddPasswords: boolean, canRemovePasswords: boolean) {
    try {
      setPasswordError("");
      const result = await window.scpefe.updateSlotPermissions({ slotId: slot.slotId,
        canEdit, canAddPasswords, canRemovePasswords });
      setOpened(result);
      setMessage("Slot permissions published.");
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : String(error));
    }
  }

  async function removeManagedSlot(slot: ManagedSlot) {
    try {
      setPasswordError("");
      const result = await window.scpefe.removeSlot(slot.slotId);
      setOpened((current) => isDocumentOpened(current) ? { ...current,
        managedSlots: current.managedSlots?.filter(
          (candidate) => candidate.slotId !== slot.slotId) } : current);
      setMessage(result.warning);
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : String(error));
    }
  }

  async function restoreRecovery() {
    try {
      const result = await window.scpefe.restoreRecoveredWork();
      setOpened(result);
      setWorkingText(result.content);
      setHistory([result.content]);
      setHistoryIndex(0);
      setDirty(true);
      setSaveState("unsaved");
      setMessage("Recovered work restored as unsaved changes.");
    } catch (error) { showError(error); }
  }

  async function discardRecovery() {
    try {
      const result = await window.scpefe.discardRecoveredWork();
      setOpened(result);
      setWorkingText(result.content);
      setManualSavedText(result.content);
      setDirty(false);
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
    try { showLockedResult(await window.scpefe.lock()); }
    catch (error) { showError(error); }
  }

  function showLockedResult(result: LockResult) {
    document.querySelectorAll<HTMLInputElement>(
      "input[type='password'], input[readonly]").forEach((input) => { input.value = ""; });
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    flushSync(() => {
      setOpened(null);
      setWorkingText("");
      setManualSavedText("");
      setHistory([""]);
      setHistoryIndex(0);
      setFindText("");
      setReplaceText("");
      setPendingProfile(null);
      setProfileError("");
      setOpenError("");
      setPendingOpenName("");
      setPasswordError("");
      setInvitationPassphrase(null);
      setInvitationError("");
      setClaimError("");
      setInvitationStaged(false);
      setExternalOpenRequest(null);
      setQueuedExternalOpenRequest(null);
      setCreating(false);
      setDialog(null);
      setEditFailure(null);
      setLeaseDecision(null);
      setDecisionError("");
      setSaveError("");
      setCompactionError("");
      setResolvingConflict(false);
      setLocked(targetNameRef.current !== null);
      setMessage(result.warning ?? "Document locked. Use Security → Unlock to continue.");
    });
    dialogReturnFocus.current = null;
  }

  function edit(content: string, cursor?: Cursor) {
    setWorkingText(content);
    setDirty(content !== manualSavedText);
    setSaveState((current) => current === "conflict" ? "conflict" : "unsaved");
    setHistory((current) => [...current.slice(0, historyIndex + 1), content]);
    setHistoryIndex((current) => current + 1);
    const nextCursor = cursor ?? { start: content.length, end: content.length };
    void window.scpefe.updateWorkingCopy({ content, cursor: nextCursor }).catch(showError);
  }

  async function save() {
    try {
      setSaveError("");
      const result = saveState === "conflict"
        ? await window.scpefe.saveDivergenceResolution(workingText)
        : await window.scpefe.saveDocument(workingText);
      setWorkingText(result.content);
      setManualSavedText(result.content);
      setDirty(false);
      setOpened((current) => isDocumentOpened(current) ? { ...current,
        content: result.content,
        readOnly: result.publicationState !== "target-published",
        publicationState: result.publicationState,
        provisional: undefined } : current);
      setSaveState(result.publicationState);
      if (result.publicationState !== "conflict") setResolvingConflict(false);
      setMessage(result.publicationState === "pending-publication"
        ? "Manual save is pending publication; its exact candidate is stored locally."
        : result.publicationState === "conflict"
          ? "Manual save is local, but the target changed; divergence must be resolved."
          : "Manual save published and verified.");
    } catch (error) {
      const value = error instanceof Error ? error.message : String(error);
      setSaveError(value); setMessage(`Manual save failed; changes remain recoverable: ${value}`);
    }
  }

  async function beginDivergenceResolution() {
    try {
      const draft = await window.scpefe.beginDivergenceResolution();
      setWorkingText(draft.content);
      setDirty(true);
      setHistory([draft.content]);
      setHistoryIndex(0);
      setOpened((current) => isDocumentOpened(current) ? { ...current,
        content: draft.content, readOnly: false, canEdit: true } : current);
      setSaveState("conflict");
      setResolvingConflict(true);
      setMessage(draft.hasConflicts
        ? "Resolve every local/current marker, then save the merge."
        : "The three-way merge is clean. Review it, then save the merge.");
    } catch (error) { showError(error); }
  }

  async function reconnectPublication() {
    try {
      if (isDocumentOpened(opened) && opened.publicationState === "conflict") {
        await beginDivergenceResolution();
        return;
      }
      const result = await window.scpefe.reconnectPendingPublication();
      setOpened((current) => isDocumentOpened(current) ? { ...current,
        content: result.content, readOnly: true,
        publicationState: result.publicationState } : current);
      setWorkingText(result.content);
      setManualSavedText(result.content);
      setDirty(false);
      setSaveState(result.publicationState);
      if (result.publicationState !== "conflict") setResolvingConflict(false);
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
      setManualSavedText(result.content);
      setDirty(false);
      setSaveState("target-published");
      setMessage("Pending manual save explicitly discarded.");
    } catch (error) { showError(error); }
  }

  async function backup() {
    try {
      const result = await window.scpefe.backupDocument();
      if (result) setMessage("Verified byte-identical backup replica created.");
    } catch (error) { showError(error); }
  }

  async function compact() {
    try {
      setCompactionError("");
      const result = await window.scpefe.compactDocument({ confirmed: true });
      if (result) {
        setDialog("passwords");
        setMessage("Verified backup created and document history compacted.");
      } else setMessage("Compaction canceled; document history is unchanged.");
    } catch (error) {
      const value = error instanceof Error ? error.message : String(error);
      setCompactionError(value); setMessage(`Compaction needs attention: ${value}`);
    }
  }

  function moveHistory(offset: number) {
    const next = historyIndex + offset;
    if (next < 0 || next >= history.length) return;
    const content = history[next];
    setHistoryIndex(next);
    setWorkingText(content);
    setDirty(content !== manualSavedText);
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
      event.preventDefault();
      dialogReturnFocus.current = editor.current;
      setDialog("find");
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

  const state = opened?.invitationRequired ? "Invitation" : lockedDocument ? "Locked"
    : !activeDocument ? "No document" : opened.readOnly ? "Read-only" : "Edit mode";
  const cleanliness = !activeDocument && !lockedDocument ? "—" : dirty ? "Dirty" : "Clean";
  const publication = !activeDocument && !lockedDocument ? "—"
    : saveState === "pending-publication" ? "Pending publication"
      : saveState === "conflict" ? "Publication conflict"
        : saveState === "provisional" ? "Provisional publication" : "Published";
  const closeDialog = () => {
    setPendingProfile(null);
    setProfileError("");
    setPasswordError("");
    setInvitationPassphrase(null);
    setInvitationError("");
    setDialog(null);
  };

  useEffect(() => {
    document.title = targetName
      ? `${dirty ? "*" : ""}${targetName} — SCPEFE` : "SCPEFE";
  }, [targetName, dirty]);

  return <main className="app-shell"><div className="shell-chrome">
    <MenuBar enabled={enabled} run={(command, returnFocus) =>
      void runCommand(command, returnFocus)} />
    <section className="editor-surface" aria-label="Document workspace">
      {!activeDocument && <p className="editor-placeholder" role="note">
        {lockedDocument ? "Document locked. Use Security → Unlock to continue."
          : "No document. Use File → New or File → Open."}</p>}
      <textarea ref={editor} aria-label="Document text"
        value={activeDocument && visibleOpenedDialog === null && !leaseDecision && !saveError
          ? workingText : ""}
        disabled={!activeDocument} readOnly={!activeDocument || opened.readOnly}
        onKeyDown={editorKeyDown} onChange={(event) => edit(event.target.value,
          { start: event.target.selectionStart, end: event.target.selectionEnd })} />
    </section>
    <footer className="status-bar" role="status" aria-live="polite" aria-atomic="true">
      <span aria-label="Document state">{state}</span>
      <span aria-label="Working copy state">{cleanliness}</span>
      <span aria-label="Publication state">{publication}</span>
      <span>{journalSummary.total > 0 ? `${journalSummary.total} recovery item${journalSummary.total === 1 ? "" : "s"} need attention. ` : ""}{message}</span>
    </footer></div>
    {editFailure && <FocusedDialog returnFocus={dialogReturnFocus.current}
      title="Editing unavailable" close={() => setEditFailure(null)}>
      <div className="warning" role="alert"><p>{editFailure}</p>
        <p>The document remains read-only.</p></div>
      <div className="dialog-actions"><button autoFocus onClick={() => setEditFailure(null)}>
        Continue read-only</button></div>
    </FocusedDialog>}
    {leaseDecision && <FocusedDialog returnFocus={dialogReturnFocus.current}
      title="Confirm editing-lease takeover">
      <div className="warning" role="alert"><p>The lease held by {leaseDecision.holderName} cannot be proved expired because the clocks disagree.</p>
        <p>Force takeover only after confirming that no other client is editing this document.</p></div>
      {decisionError && <p className="dialog-error" role="alert">{decisionError}</p>}
      <div className="dialog-actions"><button autoFocus onClick={() => {
        setLeaseDecision(null); setDecisionError("");
        setMessage("Lease takeover canceled; the document remains read-only.");
      }}>Cancel</button><button onClick={() => void confirmLeaseTakeover()}>
        {leaseDecision.operation === "migration" ? "Force takeover and migrate" : "Force takeover"}
      </button></div>
    </FocusedDialog>}
    {saveError && <FocusedDialog returnFocus={dialogReturnFocus.current}
      title="Manual save failed" close={() => setSaveError("")}>
      <p className="dialog-error" role="alert">{saveError}</p>
      <p>The working copy and recovery journal remain available. No successful publication is being reported.</p>
      <div className="dialog-actions"><button onClick={() => setSaveError("")}>Continue editing</button>
        <button autoFocus onClick={() => void save()}>Retry manual save</button></div>
    </FocusedDialog>}
    {creating && <CreationSecurityDialog returnFocus={dialogReturnFocus.current} onCancel={async () => {
      await window.scpefe.cancelCreateTarget(); setCreating(false);
    }} onCreate={async (request: object) => {
      const result = await window.scpefe.createDocument(request);
      if (result) {
        showOpenedResult({ ...result.opened, targetName: result.name });
        setCreating(false); setMessage("Encrypted blank document published successfully.");
        requestAnimationFrame(() => editor.current?.focus());
      }
    }} />}
    {dialog === "profile" && <FocusedDialog returnFocus={dialogReturnFocus.current}
      title={profile ? "Profile" : "Set up this client"}
      close={profile ? closeDialog : undefined}><p>Name, email, and device name identify this client locally. This profile is self-asserted and is not an authenticated account.</p>
      {pendingProfile ? <div className="warning" role="alert">
        <p>Changing your name or email does not silently change identities already claimed in documents. Those documents may request explicit identity reconciliation before editing.</p>
        {profileError && <p className="dialog-error">{profileError}</p>}
        <div className="dialog-actions"><button type="button" onClick={() => setPendingProfile(null)}>Go back</button>
          <button ref={profileConfirmation} type="button" autoFocus
            onClick={() => void commitProfile(pendingProfile)}>
            Save identity change</button></div></div>
        : <form onSubmit={saveProfile}><label>Name<input name="name" defaultValue={profile?.name} required autoFocus /></label>
          <label>Email<input name="email" type="email" defaultValue={profile?.email} required /></label>
          <label>Device name<input name="deviceName" defaultValue={profile?.deviceName} required /></label>
          {profileError && <p className="dialog-error" role="alert">{profileError}</p>}
          <div className="dialog-actions">{!profile && <button type="button"
            onClick={() => window.close()}>Exit application</button>}
            {profile && <button type="button" onClick={closeDialog}>Cancel</button>}
            <button>Save local profile</button></div></form>}
      {profile && <form onSubmit={saveClientSettings}><fieldset><legend>Regular saves</legend>
        <label className="check"><input name="regularSaveEnabled" type="checkbox"
          defaultChecked={clientSettings.regularSaveEnabled} /> Enable regular provisional saves</label>
        <label>Interval (seconds)<input name="regularSaveIntervalSeconds" type="number" min="10"
          max="86400" defaultValue={clientSettings.regularSaveIntervalMs / 1000} required /></label>
        <small>Regular saves update the target but remain unsaved until you manually save.</small></fieldset>
        <div className="dialog-actions"><button type="button" onClick={closeDialog}>Close</button>
          <button>Save client settings</button></div></form>}</FocusedDialog>}
    {(dialog === "open" || dialog === "unlock") && <FocusedDialog
      returnFocus={dialogReturnFocus.current}
      title={dialog === "unlock" ? "Unlock document"
        : externalOpenRequest ? "Open requested document" : "Open document"}
      close={() => { void cancelOpen(); }} initialFocus={openPassword}>
      {pendingOpenName && <p>Selected target: <strong>{pendingOpenName}</strong></p>}
      <form onSubmit={externalOpenRequest ? openExternal : open}><label>Password
        <input ref={openPassword} name="password" type="password" required
          aria-describedby={openError ? "open-password-error" : undefined} /></label>
        {openError && <p id="open-password-error" className="dialog-error" role="alert">
          {openError}</p>}
        <div className="dialog-actions"><button type="button" onClick={() => {
          void cancelOpen();
        }}>Cancel</button><button>{dialog === "unlock" ? "Unlock" : "Open"}</button>
        </div></form></FocusedDialog>}
    {(dialog === "find" || dialog === "replace") && <FocusedDialog
      returnFocus={dialogReturnFocus.current} title="Find and replace"
      close={closeDialog} initialFocus={findInput}>
      <label>Find<input ref={findInput} value={findText}
        onChange={(event) => setFindText(event.target.value)} /></label>
      <label>Replace with<input value={replaceText}
        onChange={(event) => setReplaceText(event.target.value)} /></label>
      <div className="dialog-actions"><button onClick={findNext}>Find next</button>
        <button disabled={!activeDocument || opened.readOnly} onClick={replaceSelection}>Replace</button>
        <button disabled={!activeDocument || opened.readOnly} onClick={replaceAll}>Replace all</button>
        <button onClick={closeDialog}>Close</button></div></FocusedDialog>}
    {dialog === "export" && activeDocument && <FocusedDialog returnFocus={dialogReturnFocus.current}
      title="Export plaintext" close={closeDialog}>
      <p className="warning"><strong>Not password protected:</strong> the exported text may persist in backups or storage history.</p>
      <label>Line endings<select value={lineEndings}
        onChange={(event) => setLineEndings(event.target.value as "lf" | "native")}>
        <option value="lf">Canonical LF</option><option value="native">Platform native</option></select></label>
      <div className="dialog-actions"><button onClick={closeDialog}>Cancel</button>
        <button onClick={async () => { await exportPlaintext(); closeDialog(); }}>Export current text…</button></div></FocusedDialog>}
    {dialog === "passwords" && activeDocument && <FocusedDialog returnFocus={dialogReturnFocus.current}
      title="Passwords" close={closeDialog}>
      {invitationPassphrase ? <section aria-labelledby="invitation-result-title">
        <h3 id="invitation-result-title">Invitation created</h3>
        <p className="warning">Send this temporary passphrase through a separate secure channel. It is shown only now and cannot be recovered after Done.</p>
        <label>One-time temporary passphrase<input readOnly autoFocus
          value={invitationPassphrase} aria-describedby="invitation-once-warning" /></label>
        <p id="invitation-once-warning">Copy it before continuing.</p>
        {invitationError && <p className="dialog-error" role="alert">{invitationError}</p>}
        <div className="dialog-actions"><button type="button" onClick={async () => {
          try {
            setInvitationError("");
            await window.scpefe.copyInvitationPassphrase(invitationPassphrase);
            setMessage("Invitation passphrase copied. Complete the secure transfer, then choose Done.");
          } catch (error) {
            setInvitationError(error instanceof Error ? error.message : String(error));
          }
        }}>Copy</button><button type="button" onClick={() => {
          setInvitationPassphrase(null); setMessage("Invitation created.");
        }}>Done</button></div></section> : opened.profileMismatch ? <>
        <section className="warning" aria-labelledby="reconcile-heading">
          <h3 id="reconcile-heading">Identity reconciliation required</h3>
          <p>This slot is registered to {opened.profileMismatch.slotName} · {opened.profileMismatch.slotEmail}, while this client uses {opened.profileMismatch.profileName} · {opened.profileMismatch.profileEmail}. Password administration and editing remain blocked until you explicitly reconcile it.</p>
          <button type="button" autoFocus onClick={reconcileIdentity}>
            Reconcile identity and publish</button>
        </section>
        {passwordError && <p className="dialog-error" role="alert">{passwordError}</p>}
        <div className="dialog-actions"><button onClick={closeDialog}>Close</button></div></> : <>
        <form onSubmit={changePassword}><h3>Change this password</h3>
          <p>{opened.recoverySlot
            ? "This is the recovery/master slot. Store its replacement safely offline and do not use it routinely."
            : "Changing this password re-wraps the existing document key; it does not rotate a possibly compromised document key."}</p>
          <label>Current password<input name="currentPassword" type="password" required autoFocus /></label>
          <label>New password<input name="newPassword" type="password" minLength={12} required /></label>
          <label>Confirm new password<input name="newPasswordConfirmation" type="password" minLength={12} required /></label>
          {passwordError && <p className="dialog-error" role="alert">{passwordError}</p>}
          <button>Change password</button></form>
        {!opened.readOnly && opened.canAddPasswords && (opened.managedSlots?.length ?? 0) < 7
          && <form onSubmit={createInvitation}><h3>Invite another person</h3>
            <label>Temporary label<input name="temporaryLabel" required /></label>
            <label>Temporary passphrase (leave blank to generate)<input name="temporaryPassword" type="password" /></label>
            <label className="check"><input name="canEdit" type="checkbox" /> May edit</label>
            {opened.canAddPasswords && <label className="check"><input name="canAddPasswords" type="checkbox" /> May add passwords</label>}
            {opened.canRemovePasswords && <label className="check"><input name="canRemovePasswords" type="checkbox" /> May remove passwords</label>}
            {invitationError && <p className="dialog-error" role="alert">{invitationError}</p>}
            <button>Create invitation</button></form>}
        {!opened.readOnly && opened.canAddPasswords && (opened.managedSlots?.length ?? 0) >= 7
          && <p role="note">The limit of eight ordinary password slots has been reached.</p>}
        <SlotAdministration opened={opened} onUpdate={updateManagedSlot}
          onRemove={removeManagedSlot} onCompact={async () => {
            setCompactionError(""); setDialog("compaction");
          }} />
        <div className="dialog-actions"><button onClick={closeDialog}>Close</button></div></>}
      </FocusedDialog>}
    {dialog === "compaction" && activeDocument && <FocusedDialog
      returnFocus={dialogReturnFocus.current} title="Permanently compact document history?"
      close={() => { setCompactionError(""); setDialog("passwords"); }}>
      <div className="warning" role="alert"><p>Compaction irreversibly removes older embedded history from this container.</p>
        <p>SCPEFE creates and verifies an exact backup first. Compaction cannot delete copies held by backups, sync tools, caches, or storage providers.</p></div>
      {compactionError && <p className="dialog-error" role="alert">{compactionError}</p>}
      <div className="dialog-actions"><button autoFocus onClick={() => {
        setCompactionError(""); setDialog("passwords");
        setMessage("Compaction canceled; document history is unchanged.");
      }}>Cancel</button><button onClick={() => void compact()}>
        Create verified backup and compact</button></div>
    </FocusedDialog>}
    {visibleOpenedDialog === "claim" && <FocusedDialog returnFocus={dialogReturnFocus.current}
      title="Claim invitation">
      <p>Choose a private replacement password to claim this invitation with your configured local profile. Document content remains locked until the claim is safely published.</p>
      <form onSubmit={claimInvitation}><label>New password<input name="newPassword" type="password"
        minLength={12} required autoFocus /></label>
        <label>Confirm new password<input name="newPasswordConfirmation" type="password"
          minLength={12} required /></label>
        {claimError && <p className="dialog-error" role="alert">{claimError}</p>}
        <button>Replace password and claim identity</button></form>
      <button onClick={() => void cancelInvitationClaim()}>Cancel</button></FocusedDialog>}
    {visibleOpenedDialog === "migration" && activeDocument && <FocusedDialog
      returnFocus={dialogReturnFocus.current} title="Older container">
      <div className="warning" role="alert"><p>{opened.migrationWarning}</p>
        <p>If you decline, this document stays read-only and any later save will still require migration.</p></div>
      <div className="dialog-actions"><button onClick={lock}>Keep read-only and close</button>
        {decisionError && <p className="dialog-error" role="alert">{decisionError}</p>}
        <button onClick={() => void migrate()}>Create verified backup and migrate…</button></div></FocusedDialog>}
    {visibleOpenedDialog === "profile-mismatch" && activeDocument && opened.profileMismatch && <FocusedDialog
      returnFocus={dialogReturnFocus.current} title="Profile mismatch">
      <div className="warning" role="alert"><p>This password slot is registered to {opened.profileMismatch.slotName} · {opened.profileMismatch.slotEmail}, while this client is configured as {opened.profileMismatch.profileName} · {opened.profileMismatch.profileEmail}.</p>
        <p>The document remains available read-only. Editing is blocked until you explicitly reconcile the slot identity.</p></div>
      <div className="dialog-actions"><button onClick={lock}>Lock now</button>
        <button onClick={() => setDialog("passwords")}>Open Passwords to reconcile</button></div></FocusedDialog>}
    {visibleOpenedDialog === "head" && activeDocument && opened.headMismatch && <FocusedDialog
      returnFocus={dialogReturnFocus.current} title={opened.headMismatch.title}>
      <p>{opened.headMismatch.explanation}</p><button onClick={acceptHeadMismatch}>Accept current authenticated head</button>
    </FocusedDialog>}
    {visibleOpenedDialog === "recovery" && activeDocument && opened.recovery && <FocusedDialog
      returnFocus={dialogReturnFocus.current} title="Recovered work">
      <p>Recovered work from {new Date(opened.recovery.updateTime).toLocaleString()} is available as unsaved changes.</p>
      <div className="dialog-actions"><button onClick={discardRecovery}>Discard recovered work</button>
        <button disabled={!opened.canEdit} onClick={restoreRecovery}>Restore unsaved work</button></div></FocusedDialog>}
    {visibleOpenedDialog === "publication" && activeDocument
      && <FocusedDialog returnFocus={dialogReturnFocus.current}
        title={opened.publicationState === "conflict" ? "Divergence needs resolution" : "Manual save pending publication"}>
        <p>{opened.publicationState === "conflict" ? "The target changed. The locally saved candidate was preserved for divergence handling." : "This manual save is stored locally and has not reached its target."}</p>
        <div className="dialog-actions"><button onClick={discardPublication}>Discard pending save</button>
          <button onClick={reconnectPublication}>Retry publication</button></div></FocusedDialog>}
  </main>;
}

export function mountApp(host: HTMLElement): Root {
  const root = createRoot(host);
  root.render(<App />);
  return root;
}

const applicationHost = document.getElementById("root");
if (applicationHost) {
  const applicationRoot = mountApp(applicationHost);
  const mountObserver = (window as unknown as Record<symbol,
    ((root: Root) => void) | undefined>)[Symbol.for("scpefe.renderer.mount")];
  mountObserver?.(applicationRoot);
}
