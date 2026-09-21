import React, { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { compactionAvailable, CompactionControls } from "./compaction-controls.mjs";
import { PasswordConfirmationFields } from "./creation-security-controls.mjs";
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
type DocumentOpened = { content: string; readOnly: boolean; canEdit: boolean;
  publicationState: PublicationState; recovery?: Recovery; lease?: Lease;
  canAddPasswords?: boolean; canRemovePasswords?: boolean; invitationRequired?: false;
  headMismatch?: HeadMismatch; profileMismatch?: ProfileMismatch;
  managedSlots?: ManagedSlot[]; provisional?: true; migrationRequired?: true;
  migrationWarning?: string };
type Opened = DocumentOpened | { readOnly: true; invitationRequired: true };

function isDocumentOpened(value: Opened | null): value is DocumentOpened {
  return value !== null && value.invitationRequired !== true;
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
  getClientSettings(): Promise<ClientSettings>;
  saveClientSettings(settings: ClientSettings): Promise<ClientSettings>;
  getUnresolvedJournalSummary(): Promise<JournalSummary>;
  createDocument(request: object): Promise<{ created: true } | null>;
  openDocument(password: string): Promise<Opened | null>;
  openExternalDocument(request: ExternalOpenRequest & { password: string }):
    Promise<Opened | null>;
  enterEditMode(): Promise<DocumentOpened>;
  saveDocument(content: string): Promise<{ saved: true; content: string;
    publicationState: PublicationState }>;
  reconnectPendingPublication(): Promise<{ content: string;
    publicationState: PublicationState }>;
  beginDivergenceResolution(): Promise<MergeDraft>;
  saveDivergenceResolution(content: string): Promise<{ saved: true; content: string;
    publicationState: PublicationState }>;
  discardPendingPublication(): Promise<DocumentOpened>;
  backupDocument(): Promise<{ backedUp: true } | null>;
  compactDocument(): Promise<{ compacted: true; backupCreated: true;
    previousHead: string; head: string } | null>;
  migrateDocument(): Promise<{ migrated: true; backupCreated: true;
    compatibilityWarning: string; opened: DocumentOpened } | null>;
  createInvitation(request: object): Promise<{ created: true; temporaryPassword: string }>;
  claimInvitation(password: string): Promise<DocumentOpened>;
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
  const [saveState, setSaveState] = useState<SaveState>("target-published");
  const [history, setHistory] = useState<string[]>([""]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [lineEndings, setLineEndings] = useState<"lf" | "native">("lf");
  const [ownerPasswordsVisible, setOwnerPasswordsVisible] = useState(false);
  const [recoveryPasswordsVisible, setRecoveryPasswordsVisible] = useState(false);
  const [journalSummary, setJournalSummary] = useState<JournalSummary>({
    total: 0, pendingPublications: 0,
  });
  const [externalOpenRequest, setExternalOpenRequest] =
    useState<ExternalOpenRequest | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    window.scpefe.getProfile().then(setProfile).catch(showError);
    window.scpefe.getClientSettings().then(setClientSettings).catch(showError);
    window.scpefe.getUnresolvedJournalSummary().then(setJournalSummary).catch(showError);
  }, []);
  const showError = (error: unknown) => setMessage(error instanceof Error ? error.message : String(error));
  useEffect(() => {
    const stopLocked = window.scpefe.onLocked((result) => {
      setOpened(null);
      setWorkingText("");
      setSaveState("target-published");
      setMessage(result.warning ?? "Document locked. Enter its password to unlock again.");
    });
    const stopWarning = window.scpefe.onJournalWarning(setMessage);
    const stopRegularSave = window.scpefe.onRegularSave((result) => {
      setSaveState("provisional");
      setOpened((current) => isDocumentOpened(current) ? { ...current,
        content: result.content, provisional: true } : current);
      setMessage("Regular save published provisionally; changes remain unsaved until manual save.");
    });
    const stopExternalOpen = window.scpefe.onExternalOpenRequested((request) => {
      setExternalOpenRequest(request);
      setMessage("Another open request is waiting. Enter its document password to continue.");
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

  function showOpenedResult(result: Opened | null) {
    setOpened(result);
    const content = result && !result.invitationRequired ? result.content : "";
    setWorkingText(content);
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

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const result = await window.scpefe.createDocument({
        ownerPassword: String(data.get("ownerPassword")),
        ownerPasswordConfirmation: String(data.get("ownerPasswordConfirmation")),
        recoveryPassword: String(data.get("recoveryPassword")),
        recoveryPasswordConfirmation: String(data.get("recoveryPasswordConfirmation")),
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
      showOpenedResult(result);
    }
    catch (error) { showError(error); }
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
      if (result) showOpenedResult(result);
      else setMessage("Open request canceled; the current document remains open.");
      setJournalSummary(await window.scpefe.getUnresolvedJournalSummary());
    } catch (error) { showError(error); }
  }

  async function enterEditMode() {
    try {
      setOpened(await window.scpefe.enterEditMode());
      setMessage("Edit mode entered.");
    } catch (error) { showError(error); }
  }

  async function migrate() {
    try {
      const result = await window.scpefe.migrateDocument();
      if (!result) {
        setMessage("Migration declined. The document remains read-only; saving requires migration.");
        return;
      }
      setOpened(result.opened);
      setWorkingText(result.opened.content);
      setMessage(result.compatibilityWarning);
    } catch (error) { showError(error); }
  }

  async function claimInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const result = await window.scpefe.claimInvitation(String(data.get("newPassword")));
      setOpened(result); setWorkingText(result.content);
      setMessage("Invitation claimed and replacement password safely published.");
    } catch (error) { showError(error); }
  }

  async function createInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const result = await window.scpefe.createInvitation({
        temporaryLabel: String(data.get("temporaryLabel")),
        temporaryPassword: String(data.get("temporaryPassword")) || undefined,
        canEdit: data.get("canEdit") === "on", canAddPasswords: false,
        canRemovePasswords: false,
      });
      setMessage(`Temporary invitation passphrase (shown once): ${result.temporaryPassword}`);
      event.currentTarget.reset();
    } catch (error) { showError(error); }
  }

  async function reconcileIdentity() {
    try {
      const result = await window.scpefe.reconcileIdentity();
      setOpened(result);
      setMessage("Password-slot identity reconciled through a sealed publication.");
    } catch (error) { showError(error); }
  }

  async function updateManagedSlot(slot: ManagedSlot, canEdit: boolean,
    canAddPasswords: boolean, canRemovePasswords: boolean) {
    try {
      const result = await window.scpefe.updateSlotPermissions({ slotId: slot.slotId,
        canEdit, canAddPasswords, canRemovePasswords });
      setOpened(result);
      setMessage("Slot permissions published.");
    } catch (error) { showError(error); }
  }

  async function removeManagedSlot(slot: ManagedSlot) {
    try {
      const result = await window.scpefe.removeSlot(slot.slotId);
      setOpened((current) => isDocumentOpened(current) ? { ...current,
        managedSlots: current.managedSlots?.filter(
          (candidate) => candidate.slotId !== slot.slotId) } : current);
      setMessage(result.warning);
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
    setSaveState((current) => current === "conflict" ? "conflict" : "unsaved");
    setHistory((current) => [...current.slice(0, historyIndex + 1), content]);
    setHistoryIndex((current) => current + 1);
    const nextCursor = cursor ?? { start: content.length, end: content.length };
    void window.scpefe.updateWorkingCopy({ content, cursor: nextCursor }).catch(showError);
  }

  async function save() {
    try {
      const result = saveState === "conflict"
        ? await window.scpefe.saveDivergenceResolution(workingText)
        : await window.scpefe.saveDocument(workingText);
      setWorkingText(result.content);
      setOpened((current) => isDocumentOpened(current) ? { ...current,
        content: result.content,
        readOnly: result.publicationState !== "target-published",
        publicationState: result.publicationState,
        provisional: undefined } : current);
      setSaveState(result.publicationState);
      setMessage(result.publicationState === "pending-publication"
        ? "Manual save is pending publication; its exact candidate is stored locally."
        : result.publicationState === "conflict"
          ? "Manual save is local, but the target changed; divergence must be resolved."
          : "Manual save published and verified.");
    } catch (error) { showError(error); }
  }

  async function beginDivergenceResolution() {
    try {
      const draft = await window.scpefe.beginDivergenceResolution();
      setWorkingText(draft.content);
      setHistory([draft.content]);
      setHistoryIndex(0);
      setOpened((current) => isDocumentOpened(current) ? { ...current,
        content: draft.content, readOnly: false, canEdit: true } : current);
      setSaveState("conflict");
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

  async function backup() {
    try {
      const result = await window.scpefe.backupDocument();
      if (result) setMessage("Verified byte-identical backup replica created.");
    } catch (error) { showError(error); }
  }

  async function compact() {
    try {
      const result = await window.scpefe.compactDocument();
      if (result) setMessage(
        "Verified backup created and document history compacted.");
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

  useEffect(() => {
    const host = document.createElement("div");
    host.id = "slot-administration-root";
    const authorized = isDocumentOpened(opened)
      && (opened.canAddPasswords === true || opened.canRemovePasswords === true);
    if (!authorized) return;
    document.body.append(host);
    const root = createRoot(host);
    root.render(<SlotAdministration opened={opened}
      onUpdate={updateManagedSlot} onRemove={removeManagedSlot}
      onCompact={compact} />);
    return () => { root.unmount(); host.remove(); };
  }, [opened]);

  const outstandingNotices = <>
    {journalSummary.total > 0 && <aside className="warning journal-discovery" role="alert"
      aria-labelledby="unresolved-journals-heading">
      <h2 id="unresolved-journals-heading">Recovery work needs attention</h2>
      <p>{journalSummary.total} unresolved work journal{journalSummary.total === 1 ? "" : "s"}
        {journalSummary.pendingPublications > 0
          ? `, including ${journalSummary.pendingPublications} save${journalSummary.pendingPublications === 1 ? "" : "s"} pending publication`
          : ""}. Open the associated document to restore, publish, resolve, or explicitly discard it.</p>
    </aside>}
    {externalOpenRequest && <aside className="warning" role="alert"
      aria-labelledby="external-open-heading">
      <h2 id="external-open-heading">Open request received</h2>
      <p>The existing SCPEFE window received a request to open another document.</p>
      <form onSubmit={openExternal}><label>Document password
        <input name="password" type="password" required autoFocus />
      </label><button>Open requested document</button></form>
    </aside>}
  </>;

  if (opened?.invitationRequired) return <main><h1>Claim invitation</h1>{outstandingNotices}<p>Choose a private replacement password to claim this invitation with your configured identity.</p><form onSubmit={claimInvitation}><label>New password<input name="newPassword" type="password" minLength={12} required /></label><button>Replace password and claim identity</button></form><button onClick={lock}>Cancel and lock</button><p role="status">{message}</p></main>;
  if (opened?.migrationRequired) return <main><h1>Older container</h1>{outstandingNotices}<div className="warning" role="alert"><p>{opened.migrationWarning}</p><p>If you decline, this document stays read-only and any later save will still require migration.</p><button onClick={migrate}>Create verified backup and migrate…</button></div><textarea aria-label="Document text" value={workingText} readOnly /><button onClick={lock}>Keep read-only and close</button><p role="status">{message}</p></main>;
  if (opened?.profileMismatch) return <main><h1>Profile mismatch</h1>{outstandingNotices}<div className="warning" role="alert"><p>This password slot is registered to {opened.profileMismatch.slotName} · {opened.profileMismatch.slotEmail}, while this client is configured as {opened.profileMismatch.profileName} · {opened.profileMismatch.profileEmail}.</p><p>The document remains available read-only. Editing is blocked until you explicitly reconcile the slot identity.</p><button onClick={reconcileIdentity}>Reconcile identity and publish</button></div><textarea aria-label="Document text" value={workingText} readOnly /><button onClick={lock}>Lock now</button><p role="status">{message}</p></main>;
  if (!profile) return <main><h1>Set up this client</h1>{outstandingNotices}<p>Name, email, and device name are required before creating a document.</p><form onSubmit={saveProfile}><label>Name<input name="name" required /></label><label>Email<input name="email" type="email" required /></label><label>Device name<input name="deviceName" required /></label><button>Save local profile</button></form><p role="status">{message}</p></main>;
  return <main><h1>SCPEFE</h1>{outstandingNotices}<p>{profile.name} · {profile.email} · {profile.deviceName}</p><section><h2>Client settings</h2><form onSubmit={saveClientSettings}><label className="check"><input name="regularSaveEnabled" type="checkbox" defaultChecked={clientSettings.regularSaveEnabled} /> Enable regular provisional saves</label><label>Interval (seconds)<input name="regularSaveIntervalSeconds" type="number" min="10" max="86400" defaultValue={clientSettings.regularSaveIntervalMs / 1000} required /></label><small>Regular saves update the target but remain unsaved until you manually save.</small><button>Save client settings</button></form></section><section><h2>Create</h2><p className="warning">There is no account reset: without a valid owner or recovery password, the document is permanently irrecoverable.</p><form onSubmit={create}><label>Initial text<textarea name="content" /></label><PasswordConfirmationFields kind="owner" label="Owner password" confirmationLabel="Confirm owner password" revealed={ownerPasswordsVisible} required onToggle={() => setOwnerPasswordsVisible((visible) => !visible)} /><PasswordConfirmationFields kind="recovery" label="Independent recovery password (strongly recommended)" confirmationLabel="Confirm recovery password" revealed={recoveryPasswordsVisible} required={false} onToggle={() => setRecoveryPasswordsVisible((visible) => !visible)} /><small>Leave both recovery fields empty to create a document without a recovery password. Store a recovery password safely offline and separately from the owner password and document.</small><label className="check"><input name="understandsIrrecoverable" type="checkbox" required /> I understand that lost passwords cannot be recovered.</label><label className="check"><input name="storedRecoverySeparately" type="checkbox" /> I will store the recovery password independently.</label><button>Create encrypted document…</button></form></section><section><h2>Open document</h2><form onSubmit={open}><label>Password<input name="password" type="password" required /></label><button>Choose document…</button></form>{opened && <><p className="mode">{opened.readOnly ? "Read-only mode" : "Edit mode"} · {saveState === "unsaved" ? "Unsaved edits" : saveState === "provisional" ? "Provisionally saved · still unsaved" : saveState === "pending-publication" ? "Manual save pending publication" : saveState === "conflict" ? "Divergence needs resolution" : "Published to target"}</p>{opened.headMismatch && <div className="warning" role="alert"><strong>{opened.headMismatch.title}</strong><p>{opened.headMismatch.explanation}</p><button onClick={acceptHeadMismatch}>Accept current authenticated head</button></div>}{opened.recovery && <div className="warning" role="alert"><p>Recovered work from {new Date(opened.recovery.updateTime).toLocaleString()} is available as unsaved changes.</p><button disabled={!opened.canEdit} onClick={restoreRecovery}>Restore unsaved work</button><button onClick={discardRecovery}>Discard recovered work</button></div>}{(opened.publicationState === "pending-publication" || opened.publicationState === "conflict") && <div className="warning" role="alert"><p>{opened.publicationState === "conflict" ? "The target changed. The locally saved candidate was preserved for divergence handling." : "This manual save is stored locally and has not reached its target."}</p><button onClick={reconnectPublication}>Retry publication</button><button onClick={discardPublication}>Discard pending save</button></div>}<div className="toolbar" aria-label="Editing tools"><button disabled={opened.readOnly || historyIndex === 0} onClick={() => moveHistory(-1)}>Undo</button><button disabled={opened.readOnly || historyIndex === history.length - 1} onClick={() => moveHistory(1)}>Redo</button></div><textarea ref={editor} aria-label="Document text" value={workingText} readOnly={opened.readOnly} onKeyDown={editorKeyDown} onChange={(event) => edit(event.target.value, { start: event.target.selectionStart, end: event.target.selectionEnd })} /><fieldset><legend>Find and replace</legend><label>Find<input ref={findInput} value={findText} onChange={(event) => setFindText(event.target.value)} /></label><label>Replace with<input value={replaceText} onChange={(event) => setReplaceText(event.target.value)} /></label><div className="toolbar"><button onClick={findNext}>Find next</button><button disabled={opened.readOnly} onClick={replaceSelection}>Replace</button><button disabled={opened.readOnly} onClick={replaceAll}>Replace all</button></div></fieldset>{opened.readOnly ? <button disabled={!opened.canEdit || opened.publicationState !== "target-published"} onClick={enterEditMode}>Enter edit mode</button> : <button onClick={save}>Save</button>}{!opened.readOnly && opened.canAddPasswords && <form onSubmit={createInvitation}><h3>Invite another person</h3><label>Temporary label<input name="temporaryLabel" required /></label><label>Temporary passphrase (leave blank to generate)<input name="temporaryPassword" type="password" /></label><label className="check"><input name="canEdit" type="checkbox" /> May edit</label><button>Create invitation</button></form>}<button onClick={backup}>Back up…</button><button onClick={lock}>Lock now</button><fieldset><legend>Export plaintext</legend><p className="warning"><strong>Not password protected:</strong> the exported text may persist in backups or storage history.</p><label>Line endings<select value={lineEndings} onChange={(event) => setLineEndings(event.target.value as "lf" | "native")}><option value="lf">Canonical LF</option><option value="native">Platform native</option></select></label><button onClick={exportPlaintext}>Export current text…</button></fieldset></>}</section><p role="status">{message}</p></main>;
}

createRoot(document.getElementById("root")!).render(<App />);
