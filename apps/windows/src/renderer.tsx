import React, { FormEvent, KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { DocumentSession, type WorkingCopyJournalHost } from "@scpefe/frontend-core";
import { useModalFocus, useSessionSnapshot } from "@scpefe/react-ui";
import { compactionAvailable, CompactionControls } from "./compaction-controls.mjs";
import { CreationSecurityDialog } from "./creation-security-dialog.tsx";
import { assessProposedPassword, PasswordPolicyStatus,
  proposedPasswordRejectionMessage } from "./password-policy.mjs";
import { RENDERER_LIFECYCLE_COMPLETION,
  RendererLifecycleCompletion } from "./renderer-lifecycle-completion.mjs";
import { catalogText, safeRendererErrorMessage } from "./error-boundary.mjs";
import "./styles.css";

const rendererLifecycleCompletion = new RendererLifecycleCompletion();

type Profile = { name: string; email: string; deviceName: string };
type Cursor = { start: number; end: number };
type Recovery = { content: string; state: "unsaved"; updateTime: number; cursor: Cursor;
  authorName?: string; deviceName?: string };
type Lease = { active: boolean; holderName: string; holderEmail: string;
  deviceName: string; holderUtcMs: number; durationMs: number };
type HeadMismatch = { kind: "rollback" | "divergence" | "replacement" | "witness-error";
  title: string; explanation: string; editingBlocked: true };
type PublicationState = "target-published" | "pending-publication" | "conflict";
type ClientSettings = { regularSaveEnabled: boolean; regularSaveIntervalMs: number };
type JournalSummary = { total: number; pendingPublications: number };
type ExternalOpenRequest = { token: string };
type ProtectionOperation = "new" | "open" | "external-open" | "close" | "exit";
type ProtectionRequest = { token: string; operation: ProtectionOperation; state: {
  dirty: boolean; provisional: boolean; pendingPublication: boolean; recovered: boolean;
  conflict: boolean; unresolvedJournal: boolean; activePublication: boolean } };
type ProfileMismatch = { slotName: string; slotEmail: string;
  profileName: string; profileEmail: string; editingBlocked: true };
type ManagedSlot = { slotId: string; identityName: string; identityEmail: string;
  canEdit: boolean; canAddPasswords: boolean; canRemovePasswords: boolean;
  mustBeChanged: boolean; slotIdKnown?: boolean; permissionsKnown?: boolean;
  mustBeChangedKnown?: boolean; identityKnown?: boolean };
type MergeDraft = { content: string; hasConflicts: boolean;
  ancestorRevision: string; localRevision: string; currentRevision: string };
type LeaseOperation = "edit" | "recovery" | "divergence" | "migration";
type LeaseDecision = { decisionRequired: "lease-takeover"; operation: LeaseOperation;
  holderName: string; authorization: string };
type DocumentOpened = { content: string; readOnly: boolean; canEdit: boolean;
  publicationState: PublicationState; recovery?: Recovery; lease?: Lease;
  targetName?: string;
  canAddPasswords?: boolean; canRemovePasswords?: boolean; invitationRequired?: false;
  recoverySlot?: boolean; slotId?: string; slotIdentityName?: string;
  slotIdentityEmail?: string;
  headMismatch?: HeadMismatch; profileMismatch?: ProfileMismatch;
  managedSlots?: ManagedSlot[]; provisional?: true; migrationRequired?: true;
  unreadableJournal?: true;
  migrationWarning?: string };
type Opened = DocumentOpened | { readOnly: true; invitationRequired: true;
  targetName?: string };
type DialogName = "profile" | "open" | "export"
  | "unlock" | "passwords" | "compaction" | null;
type OpenedDialogName = "claim" | "migration" | "profile-mismatch" | "head"
  | "recovery" | "unreadable" | "publication" | null;

function isDocumentOpened(value: Opened | null): value is DocumentOpened {
  return value !== null && value.invitationRequired !== true;
}

function openedDialogName(value: Opened | null): OpenedDialogName {
  if (value?.invitationRequired) return "claim";
  if (!isDocumentOpened(value)) return null;
  if (value.migrationRequired) return "migration";
  if (value.profileMismatch) return "profile-mismatch";
  return null;
}

function sessionAttentionNeedsDialog(kind: string | undefined): boolean {
  return kind === "head-mismatch" || kind === "unreadable-journal"
    || kind === "recovery-decision" || kind === "publication-decision";
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

function FocusedDialog({ title, children, close, initialFocus, returnFocus }: {
  title: string; children: React.ReactNode; close?: () => void;
  initialFocus?: React.RefObject<HTMLElement | null>; returnFocus?: HTMLElement | null }) {
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  const focus = useModalFocus({ scopeRef: dialog, initialFocusRef: initialFocus,
    returnFocus, onEscape: close,
    fallbackFocus: () => document.querySelector<HTMLElement>(
      '[role="menubar"] > .menu > [role="menuitem"]') });
  return <div className="dialog-backdrop" onKeyDown={focus.onKeyDown}>
    <section ref={dialog} className="app-dialog" role="dialog" tabIndex={-1} aria-modal="true"
    aria-labelledby={titleId}><h2 id={titleId}>{title}</h2>
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

type LockResult = { locked: true; journalSaved: boolean; warningCode: string | null };
declare global { interface Window { scpefe: {
  getProfile(): Promise<Profile | null>;
  saveProfile(profile: Profile): Promise<Profile>;
  reconcileProfile(): Promise<DocumentOpened | null>;
  getClientSettings(): Promise<ClientSettings>;
  saveClientSettings(settings: ClientSettings): Promise<ClientSettings>;
  getUnresolvedJournalSummary(): Promise<JournalSummary>;
  assessPasswordPolicy(password: string): Promise<
    "accepted" | "minimum-length" | "predictable" | "invalid">;
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
  cancelExternalOpen(request: ExternalOpenRequest): Promise<boolean>;
  enterEditMode(request?: { authorization?: string }): Promise<DocumentOpened | LeaseDecision>;
  saveDocument(content: string): Promise<{ saved: true; content: string;
    publicationState: PublicationState }>;
  reconnectPendingPublication(): Promise<{ content: string;
    publicationState: PublicationState }>;
  beginDivergenceResolution(request?: { authorization?: string }):
    Promise<MergeDraft | LeaseDecision>;
  saveDivergenceResolution(content: string): Promise<{ saved: true; content: string;
    publicationState: PublicationState }>;
  discardPendingPublication(): Promise<DocumentOpened>;
  backupDocument(): Promise<{ backedUp: true } | null>;
  compactDocument(request: { confirmed: true }): Promise<{ compacted: true; backupCreated: true;
    previousHead: string; head: string } | null>;
  migrateDocument(request?: { authorization?: string }): Promise<{
    migrated: true; backupCreated: true; compatibilityCode: string;
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
  removeSlot(slotId: string): Promise<{ removed: true; warningCode: string }>;
  exportPlaintext(request: { content: string; lineEndings: "lf" | "native" }):
    Promise<{ exported: true } | null>;
  updateWorkingCopy(value: { content: string; cursor: Cursor;
    journalScope?: string }): Promise<object>;
  activity(): Promise<object>;
  restoreRecoveredWork(request?: { authorization?: string }):
    Promise<(DocumentOpened & { recoveredUnsaved: true; cursor: Cursor }) | LeaseDecision>;
  cancelLeaseTakeover(authorization: string): Promise<boolean>;
  discardRecoveredWork(): Promise<DocumentOpened>;
  acceptHeadMismatch(): Promise<DocumentOpened>;
  discardUnreadableJournal(): Promise<DocumentOpened>;
  closeDocument(): Promise<boolean>;
  exitApplication(): Promise<boolean>;
  resolveProtection(request: { token: string; decision: "cancel" | "save" | "discard" }):
    Promise<{ completed: boolean; proceed: boolean; retryToken?: string; errorCode?: string }>;
  lock(): Promise<LockResult>;
  onLockStarted?(listener: () => void): () => void;
  onLocked(listener: (result: LockResult) => void): () => void;
  onJournalWarning(listener: (warningCode: string,
    journalScope: string | null) => void): () => void;
  onRegularSave(listener: (result: { published: true; provisional: true;
    content: string; journalScope: string; revision: number }) => void): () => void;
  onExternalOpenRequested(listener: (request: ExternalOpenRequest) => void): () => void;
  onUnresolvedJournalSummary(listener: (summary: JournalSummary) => void): () => void;
  onSwitchRetained(listener: (opened: DocumentOpened) => void): () => void;
  onProtectionRequested?(listener: (request: ProtectionRequest) => void): () => void;
  onDocumentClosed?(listener: () => void): () => void;
}; } }

function App() {
  const [sessionStore] = useState(() => {
    let journalSequence = 0;
    const journalPrefix = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const warningListeners = new Set<(code: string, scope: string | null) => void>();
    const journal: WorkingCopyJournalHost = {
      createJournalScope: () => `renderer-${journalPrefix}-${++journalSequence}`,
      updateWorkingCopy: (update) => window.scpefe.updateWorkingCopy(update),
      onJournalWarning: (listener) => {
        warningListeners.add(listener);
        return () => { warningListeners.delete(listener); };
      },
    };
    return {
      session: new DocumentSession<DocumentOpened, Extract<Opened,
        { invitationRequired: true }>>(window.scpefe, journal),
      forwardJournalWarning: (code: string, scope: string | null) => {
        for (const listener of warningListeners) listener(code, scope);
      },
    };
  });
  const session = sessionStore.session;
  const sessionSnapshot = useSessionSnapshot(session);
  const opened: Opened | null = sessionSnapshot.kind === "read-only"
    || sessionSnapshot.kind === "edit" ? sessionSnapshot.document : null;
  const targetName = sessionSnapshot.kind === "closed" ? null
    : sessionSnapshot.targetName;
  const lockedDocument = sessionSnapshot.kind === "locked";
  const working = sessionSnapshot.kind === "read-only" || sessionSnapshot.kind === "edit"
    ? sessionSnapshot.working : null;
  const workingText = working?.text ?? "";
  const dirty = working?.dirty ?? false;
  const attention = sessionSnapshot.kind === "read-only" || sessionSnapshot.kind === "edit"
    ? sessionSnapshot.attention : undefined;
  const leaseDecision = attention?.kind === "lease-takeover" ? attention : null;
  const editFailure = attention?.kind === "edit-unavailable"
    ? catalogText(attention.code) : null;
  const saveFailure = attention?.kind === "save-failed"
    ? catalogText(attention.code) : null;
  const publicationDecision = attention?.kind === "publication-decision"
    ? attention : null;
  const recoveryDecision = attention?.kind === "recovery-decision"
    ? attention : null;
  const headDecision = attention?.kind === "head-mismatch" ? attention : null;
  const unreadableDecision = attention?.kind === "unreadable-journal" ? attention : null;
  const publicationState = sessionSnapshot.kind === "closed" ? null
    : sessionSnapshot.publication.state;
  const publicationResolving = sessionSnapshot.kind === "read-only"
    || sessionSnapshot.kind === "edit" ? sessionSnapshot.publication.resolving : false;
  const leaseBusy = sessionSnapshot.pending === "lease-confirm"
    || sessionSnapshot.pending === "lease-cancel"
    || ((sessionSnapshot.kind === "read-only" || sessionSnapshot.kind === "edit")
      && sessionSnapshot.queued !== undefined);
  useEffect(() => () => session.dispose(), [session]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [clientSettings, setClientSettings] = useState<ClientSettings>({
    regularSaveEnabled: false, regularSaveIntervalMs: 120_000,
  });
  const [message, setMessage] = useState("");
  const [editorAdoption, setEditorAdoption] = useState(0);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [findStatus, setFindStatus] = useState("");
  const [lineEndings, setLineEndings] = useState<"lf" | "native">("lf");
  const [exportError, setExportError] = useState("");
  const journalSummary = sessionSnapshot.discovery ?? { total: 0,
    pendingPublications: 0 };
  const [externalOpenRequest, setExternalOpenRequest] =
    useState<ExternalOpenRequest | null>(null);
  const [queuedExternalOpenRequest, setQueuedExternalOpenRequest] =
    useState<ExternalOpenRequest | null>(null);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [creating, setCreating] = useState(false);
  const [openError, setOpenError] = useState("");
  const [pendingOpenName, setPendingOpenName] = useState("");
  const [invitationStaged, setInvitationStaged] = useState(false);
  const [decisionError, setDecisionError] = useState("");
  const [openedDialogError, setOpenedDialogError] = useState("");
  const [confirmDivergenceDiscard, setConfirmDivergenceDiscard] = useState(false);
  const [compactionError, setCompactionError] = useState("");
  const [pendingProfile, setPendingProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [invitationPassphrase, setInvitationPassphrase] = useState<string | null>(null);
  const [invitationError, setInvitationError] = useState("");
  const [invitationPasswordError, setInvitationPasswordError] = useState(false);
  const [claimError, setClaimError] = useState("");
  const [currentPasswordDraft, setCurrentPasswordDraft] = useState("");
  const [newPasswordDraft, setNewPasswordDraft] = useState("");
  const [newPasswordConfirmationDraft, setNewPasswordConfirmationDraft] = useState("");
  const [temporaryPasswordDraft, setTemporaryPasswordDraft] = useState("");
  const [claimPasswordDraft, setClaimPasswordDraft] = useState("");
  const [claimConfirmationDraft, setClaimConfirmationDraft] = useState("");
  const [protection, setProtection] = useState<ProtectionRequest | null>(null);
  const [protectionError, setProtectionError] = useState("");
  const editor = useRef<HTMLTextAreaElement>(null);
  const wasModalBusy = useRef(false);
  const replacementFocusPending = useRef(false);
  const findInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const suspendedFindFocus = useRef<"find" | "replace" | null>(null);
  const findReturnFocus = useRef<HTMLElement | null>(null);
  const exportAction = useRef<HTMLButtonElement>(null);
  const openPassword = useRef<HTMLInputElement>(null);
  const profileConfirmation = useRef<HTMLButtonElement>(null);
  const editRetryAction = useRef<HTMLButtonElement>(null);
  const recoveryRestoreAction = useRef<HTMLButtonElement>(null);
  const publicationRetryAction = useRef<HTMLButtonElement>(null);
  const migrationRetryAction = useRef<HTMLButtonElement>(null);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);
  const modalBusy = useRef(false);
  const openedDialog = opened?.invitationRequired ? "claim"
    : headDecision ? "head" : unreadableDecision ? "unreadable"
      : recoveryDecision ? "recovery" : publicationDecision ? "publication"
        : openedDialogName(opened);
  const visibleOpenedDialog = !creating && dialog === null && !confirmDivergenceDiscard
    && leaseDecision === null && saveFailure === null
    ? invitationStaged ? "claim" : openedDialog : null;
  modalBusy.current = protection !== null || creating || dialog !== null || visibleOpenedDialog !== null
    || invitationStaged || confirmDivergenceDiscard
    || editFailure !== null || leaseDecision !== null || saveFailure !== null;
  if (modalBusy.current && !wasModalBusy.current && findOpen) {
    suspendedFindFocus.current = document.activeElement === replaceInput.current
      ? "replace" : "find";
  }
  useEffect(() => {
    void rendererLifecycleCompletion.track(() => window.scpefe.getProfile().then((value) => {
      setProfile(value); if (!value) setDialog("profile");
    }).catch(showError));
    void rendererLifecycleCompletion.track(() =>
      window.scpefe.getClientSettings().then(setClientSettings).catch(showError));
    void rendererLifecycleCompletion.track(() =>
      window.scpefe.getUnresolvedJournalSummary().then((summary) => {
        session.observeRecoveryDiscovery(summary);
      }).catch(showError));
  }, []);
  const showError = (error: unknown) => setMessage(safeRendererErrorMessage(error));
  function reflectCurrent(update: (document: DocumentOpened) => DocumentOpened): void {
    const current = session.getSnapshot();
    if (current.kind === "read-only" || current.kind === "edit") {
      session.refreshDocument(update(current.document));
    }
  }
  useEffect(() => {
    const stopLockStarted = window.scpefe.onLockStarted?.(() => showLockedResult({
      locked: true, journalSaved: true, warningCode: null,
    })) ?? (() => {});
    const stopLocked = window.scpefe.onLocked(showLockedResult);
    const stopWarning = window.scpefe.onJournalWarning((code, scope) => {
      sessionStore.forwardJournalWarning(code, scope);
      setMessage(catalogText(code));
    });
    const stopRegularSave = window.scpefe.onRegularSave((result) => {
      if (session.regularSavePublished(result)) {
        setMessage("Regular save published provisionally; changes remain unsaved until manual save.");
      }
    });
    const stopExternalOpen = window.scpefe.onExternalOpenRequested((request) => {
      const current = session.getSnapshot();
      if (modalBusy.current || (current.kind === "read-only" || current.kind === "edit")
        && current.publication.resolving) {
        setQueuedExternalOpenRequest(request);
        setMessage("Another open request is waiting for the current dialog.");
      } else {
        dialogReturnFocus.current = document.activeElement as HTMLElement | null;
        setExternalOpenRequest(request); setDialog("open");
        setMessage("Another open request is waiting. Enter its document password to continue.");
      }
    });
    const stopJournalSummary = window.scpefe.onUnresolvedJournalSummary(
      (summary) => { session.observeRecoveryDiscovery(summary); });
    const stopSwitchRetained = window.scpefe.onSwitchRetained((result) => {
      showOpenedResult(result);
      setMessage("The current document remains open with its manual save pending publication.");
    });
    const stopProtection = window.scpefe.onProtectionRequested?.((request) => {
      dialogReturnFocus.current = document.activeElement as HTMLElement | null;
      setProtectionError(""); setProtection(request);
    }) ?? (() => {});
    const stopClosed = window.scpefe.onDocumentClosed?.(() => {
      showLockedResult({ locked: true, journalSaved: true, warningCode: null }, true);
    }) ?? (() => {});
    const activity = () => { void window.scpefe.activity(); };
    window.addEventListener("keydown", activity);
    window.addEventListener("pointerdown", activity);
    return () => {
      stopLockStarted(); stopLocked(); stopWarning(); stopRegularSave(); stopExternalOpen();
      stopJournalSummary();
      stopSwitchRetained(); stopProtection(); stopClosed();
      window.removeEventListener("keydown", activity);
      window.removeEventListener("pointerdown", activity);
    };
  }, []);
  useEffect(() => {
    if (!creating && dialog === null && openedDialog === null
      && !publicationResolving && queuedExternalOpenRequest) {
      dialogReturnFocus.current = document.activeElement as HTMLElement | null;
      setExternalOpenRequest(queuedExternalOpenRequest);
      setQueuedExternalOpenRequest(null);
      setDialog("open");
      setMessage("Another open request is waiting. Enter its document password to continue.");
    }
  }, [creating, dialog, openedDialog, publicationResolving, queuedExternalOpenRequest]);

  function showOpenedResult(result: DocumentOpened, alreadyAdopted = false) {
    if (!alreadyAdopted) session.adopt(result);
    const adopted = session.getSnapshot();
    if (adopted.kind === "read-only" || adopted.kind === "edit") {
      setEditorAdoption(adopted.adoption);
    }
    setDecisionError("");
    setOpenedDialogError("");
    setConfirmDivergenceDiscard(false);
    setFindOpen(false);
    setFindText("");
    setReplaceText("");
    setFindStatus("");
    if (result.recovery) {
      const source = [result.recovery.authorName, result.recovery.deviceName]
        .filter(Boolean).join(" on ");
      setMessage(`Recovered unsaved work${source ? ` from ${source}` : ""}. Restore or discard it before editing.`);
    } else if (result.lease?.active) {
      setMessage(`Editing lease held by ${result.lease.holderName || "another editor"} (${result.lease.holderEmail}) on ${result.lease.deviceName}.`);
    }
  }

  function showReplacementResult(result: Opened, alreadyAdopted = false) {
    if (result.invitationRequired) {
      setInvitationStaged(true);
      setMessage("Claim the invitation before its document replaces the current session.");
      return;
    }
    setInvitationStaged(false);
    showOpenedResult(result, alreadyAdopted);
  }

  function focusEditorAfterDialog() {
    replacementFocusPending.current = true;
  }

  const activeDocument = isDocumentOpened(opened)
    && (sessionSnapshot.kind === "read-only" || sessionSnapshot.kind === "edit")
    && sessionSnapshot.adoption === editorAdoption;
  useEffect(() => {
    const restoreSelection = wasModalBusy.current && !modalBusy.current && activeDocument;
    const restoreFindFocus = restoreSelection && findOpen && suspendedFindFocus.current !== null;
    wasModalBusy.current = modalBusy.current;
    if (!restoreSelection) return;
    const { start, end } = working?.selection ?? { start: 0, end: 0 };
    requestAnimationFrame(() => {
      editor.current?.setSelectionRange(
        Math.min(start, workingText.length), Math.min(end, workingText.length));
      if (restoreFindFocus) {
        (suspendedFindFocus.current === "replace" ? replaceInput.current : findInput.current)
          ?.focus();
        suspendedFindFocus.current = null;
      }
    });
  });
  useEffect(() => {
    if (!replacementFocusPending.current || creating || dialog !== null
        || visibleOpenedDialog !== null || protection !== null || !activeDocument) return;
    replacementFocusPending.current = false;
    requestAnimationFrame(() => requestAnimationFrame(() => editor.current?.focus()));
  }, [activeDocument, creating, dialog, protection, visibleOpenedDialog]);
  const enabled: Record<string, boolean> = {
    new: profile !== null, open: profile !== null,
    save: activeDocument && sessionSnapshot.kind === "edit"
      && sessionSnapshot.commands.save,
    backup: activeDocument && (sessionSnapshot.kind === "read-only"
      || sessionSnapshot.kind === "edit") && sessionSnapshot.commands.backup,
    export: activeDocument && (sessionSnapshot.kind === "read-only"
      || sessionSnapshot.kind === "edit") && sessionSnapshot.commands.export,
    close: activeDocument || lockedDocument, exit: true,
    edit: activeDocument && sessionSnapshot.kind === "read-only"
      && sessionSnapshot.commands.enterEdit,
    undo: activeDocument && sessionSnapshot.kind === "edit"
      && sessionSnapshot.commands.undo,
    redo: activeDocument && sessionSnapshot.kind === "edit"
      && sessionSnapshot.commands.redo,
    find: activeDocument, replace: activeDocument,
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
    } else if (command === "find" || command === "replace") {
      findReturnFocus.current = returnFocus?.isConnected
        ? returnFocus : document.activeElement as HTMLElement | null;
      setFindOpen(true);
      requestAnimationFrame(() => (command === "replace"
        ? replaceInput.current : findInput.current)?.focus());
    } else if (command === "export" || command === "passwords" || command === "profile") {
      if (command === "export") setExportError("");
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
    else if (command === "close") {
      const outcome = await session.close();
      if (outcome.status === "failed") setMessage(catalogText(outcome.code));
      else if (outcome.status === "closed") showLockedResult({
        locked: true, journalSaved: true, warningCode: null,
      }, true);
    }
    else if (command === "exit") {
      try { await window.scpefe.exitApplication(); }
      catch (error) { showError(error); }
    }
  }

  async function decideProtection(decision: "cancel" | "save" | "discard") {
    if (!protection) return;
    try {
      setProtectionError("");
      const result = await window.scpefe.resolveProtection(
        { token: protection.token, decision });
      if (!result.completed) {
        setProtection((current) => current && result.retryToken
          ? { ...current, token: result.retryToken } : current);
        setProtectionError(catalogText(result.errorCode ?? "LIFECYCLE_FAILED"));
        return;
      }
      setProtection(null);
      if (decision === "cancel") {
        setMessage("Action canceled; the current document remains open and usable.");
      }
    } catch (error) {
      setProtectionError(safeRendererErrorMessage(error));
    }
  }

  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || (!event.ctrlKey && !event.metaKey)
        || event.altKey || modalBusy.current) return;
      const commands: Record<string, string> = { n: "new", o: "open", s: "save",
        w: "close", z: "undo", y: "redo", f: "find", h: "replace" };
      const command = commands[event.key.toLowerCase()];
      if (command && enabled[command]) { event.preventDefault();
        void rendererLifecycleCompletion.track(() =>
          runCommand(command, document.activeElement as HTMLElement | null)); }
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
      if (authoritative) session.refreshDocument(authoritative);
      setDialog(null);
      setMessage("Local profile saved.");
    } catch (error) {
      setProfileError(safeRendererErrorMessage(error));
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
    let password = String(data.get("password"));
    data.delete("password");
    try {
      setOpenError("");
      const pending = dialog === "unlock"
        ? session.unlock(password) : session.openSelected(password);
      password = "";
      const outcome = await pending;
      if (outcome.status === "failed") {
        setOpenError(catalogText(outcome.code));
        requestAnimationFrame(() => openPassword.current?.focus());
        return;
      }
      if (outcome.status === "superseded") return;
      if (outcome.status === "invitation") {
        setInvitationStaged(true);
        setMessage("Claim the invitation before its document replaces the current session.");
      } else if (outcome.status === "opened") {
        const adopted = session.getSnapshot();
        if (adopted.kind !== "read-only" && adopted.kind !== "edit") return;
        showReplacementResult(adopted.document, true);
      } else return;
      setPendingOpenName(""); setDialog(null);
      const adopted = session.getSnapshot();
      if (outcome.status === "opened" && (adopted.kind === "read-only"
          || adopted.kind === "edit") && openedDialogName(adopted.document) === null
          && !sessionAttentionNeedsDialog(adopted.attention?.kind)) {
        focusEditorAfterDialog();
      }
    }
    catch (error) {
      setOpenError(safeRendererErrorMessage(error));
      requestAnimationFrame(() => openPassword.current?.focus());
    }
  }

  async function cancelOpen() {
    try {
      if (externalOpenRequest) await window.scpefe.cancelExternalOpen(externalOpenRequest);
      else if (dialog === "open") await window.scpefe.cancelOpenTarget();
    } catch (error) {
      setOpenError(safeRendererErrorMessage(error));
      requestAnimationFrame(() => openPassword.current?.focus());
      return;
    }
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
      if (result) {
        showReplacementResult(result); setDialog(null);
        const adopted = session.getSnapshot();
        if (!result.invitationRequired && openedDialogName(result) === null
          && (adopted.kind === "read-only" || adopted.kind === "edit")
          && !sessionAttentionNeedsDialog(adopted.attention?.kind)) {
          focusEditorAfterDialog();
        }
      }
      else { setDialog(null);
        setMessage("Open request canceled; the current document remains open."); }
      session.observeRecoveryDiscovery(await window.scpefe.getUnresolvedJournalSummary());
    } catch (error) {
      setOpenError(safeRendererErrorMessage(error));
      requestAnimationFrame(() => openPassword.current?.focus());
    }
  }

  async function enterEditMode() {
    const outcome = await session.enterEditMode();
    if (outcome.status === "attention") {
      setDecisionError("");
      setMessage("Editing requires a confirmed lease takeover.");
    } else if (outcome.status === "edit-mode") setMessage("Edit mode entered.");
  }

  function leaveConsumedTakeover(operation: LeaseOperation, value: string) {
    setDecisionError("");
    if (operation === "edit") {
      setMessage(`Editing needs attention: ${value}`);
      requestAnimationFrame(() => editRetryAction.current?.focus());
      return;
    }
    setOpenedDialogError(value);
    setMessage(`${operation === "migration" ? "Migration"
      : operation === "recovery" ? "Recovery restore"
      : "Divergence resolution"} needs attention: ${value}`);
    requestAnimationFrame(() => {
      if (operation === "migration") migrationRetryAction.current?.focus();
      else if (operation === "recovery") recoveryRestoreAction.current?.focus();
      else publicationRetryAction.current?.focus();
    });
  }

  function currentAdoption(): number | null {
    const current = session.getSnapshot();
    return current.kind === "read-only" || current.kind === "edit"
      ? current.adoption : null;
  }

  function stillAdopted(adoption: number | null): boolean {
    return adoption !== null && currentAdoption() === adoption;
  }

  async function migrate() {
    const adoption = currentAdoption();
    try {
      setDecisionError("");
      setOpenedDialogError("");
      const result = await window.scpefe.migrateDocument();
      if (!stillAdopted(adoption)) return;
      if (!result) {
        setOpenedDialogError("Migration was canceled before publication. Retry to acquire fresh lease authorization.");
        setMessage("Migration declined. The document remains read-only; saving requires migration.");
        requestAnimationFrame(() => migrationRetryAction.current?.focus());
        return;
      }
      if ("decisionRequired" in result) {
        session.stageLeaseDecision(result, adoption!);
        setMessage("Migration requires a confirmed lease takeover.");
        return;
      }
      session.refreshDocument(result.opened);
      session.adoptPublication(result.opened.content);
      setMessage(catalogText(result.compatibilityCode));
    } catch (error) {
      if (!stillAdopted(adoption)) return;
      const value = safeRendererErrorMessage(error);
      setOpenedDialogError(value);
      setMessage(`Migration needs attention: ${value}`);
      requestAnimationFrame(() => migrationRetryAction.current?.focus());
    }
  }

  async function confirmLeaseTakeover() {
    if (!leaseDecision) return;
    setDecisionError("");
    const outcome = await session.confirmLeaseTakeover();
    if (outcome.status === "attention") {
      setDecisionError("The lease changed. Review the current holder before trying again.");
    } else if (outcome.status === "recovery") {
      setMessage("Recovered work restored as unsaved changes.");
    } else if (outcome.status === "divergence") {
      showDivergenceDraft(outcome.hasConflicts);
    } else if (outcome.status === "migration") {
      session.refreshDocument(outcome.document);
      session.adoptPublication(outcome.document.content);
      setMessage(catalogText(outcome.compatibilityCode));
    } else if (outcome.status === "edit-mode") {
      setMessage("Edit mode entered after confirmed lease takeover.");
    } else if (outcome.status === "failed") {
      leaveConsumedTakeover(leaseDecision.operation, catalogText(outcome.code));
    } else if (outcome.status === "unavailable" && leaseDecision.operation === "migration") {
      setOpenedDialogError("Migration was canceled before publication. Retry to acquire fresh lease authorization.");
      requestAnimationFrame(() => migrationRetryAction.current?.focus());
    }
  }

  async function cancelLeaseDecision() {
    if (!leaseDecision) return;
    setDecisionError("");
    const outcome = await session.cancelLeaseTakeover();
    if (outcome.status === "canceled") {
      setMessage(outcome.revoked
        ? "Lease takeover canceled; the document session is unchanged."
        : "Lease takeover was already inactive; the document session is unchanged.");
    } else if (outcome.status === "failed") {
      const value = catalogText(outcome.code);
      setMessage(`Lease takeover cancellation needs attention: ${value}`);
    }
  }

  async function claimInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const assessed = await assessProposedPassword(String(data.get("newPassword")));
    if (assessed.status !== "accepted") {
      setClaimError(proposedPasswordRejectionMessage(assessed, "Replacement password"));
      requestAnimationFrame(() => (form.elements.namedItem(
        "newPassword") as HTMLElement | null)?.focus());
      return;
    }
    const password = assessed.password;
    if (password !== String(data.get("newPasswordConfirmation")).trim()) {
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
      setClaimPasswordDraft(""); setClaimConfirmationDraft("");
      setInvitationStaged(false); showOpenedResult(result);
      setMessage("Invitation claimed and replacement password safely published.");
    } catch (error) {
      const value = safeRendererErrorMessage(error);
      if (/current document remains open/i.test(value)) {
        setInvitationStaged(false);
        setMessage("Invitation claim canceled; the current session remains open.");
        return;
      }
      setClaimError(value);
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
      setClaimError(safeRendererErrorMessage(error));
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword"));
    const assessed = await assessProposedPassword(String(data.get("newPassword")));
    if (assessed.status !== "accepted") {
      setPasswordError(proposedPasswordRejectionMessage(assessed, "New password"));
      requestAnimationFrame(() => (form.elements.namedItem(
        "newPassword") as HTMLElement | null)?.focus());
      return;
    }
    const proposedPassword = assessed.password;
    const confirmation = String(data.get("newPasswordConfirmation")).trim();
    if (proposedPassword !== confirmation) {
      setPasswordError("New passwords do not match.");
      requestAnimationFrame(() => (form.elements.namedItem("newPasswordConfirmation") as HTMLElement)?.focus());
      return;
    }
    if (proposedPassword === currentPassword.trim()) {
      setPasswordError("New password must differ from the current password.");
      requestAnimationFrame(() => (form.elements.namedItem("newPassword") as HTMLElement)?.focus());
      return;
    }
    try {
      setPasswordError("");
      const result = await window.scpefe.changePassword({
        currentPassword, newPassword: proposedPassword,
        newPasswordConfirmation: confirmation,
      });
      form.reset();
      setCurrentPasswordDraft(""); setNewPasswordDraft("");
      setNewPasswordConfirmationDraft("");
      session.refreshDocument(result);
      setMessage("Password changed and the updated document was published safely.");
    } catch (error) {
      setPasswordError(safeRendererErrorMessage(error));
      requestAnimationFrame(() => {
        const field = (error as { code?: string })?.code === "WEAK_PASSWORD"
          || (error as { code?: string })?.code === "PASSWORD_ALREADY_IN_USE"
          ? "newPassword" : "currentPassword";
        (form.elements.namedItem(field) as HTMLElement | null)?.focus();
      });
    }
  }

  async function createInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const enteredTemporary = String(data.get("temporaryPassword"));
    const assessed = enteredTemporary
      ? await assessProposedPassword(enteredTemporary) : null;
    if (assessed && assessed.status !== "accepted") {
      setInvitationError(proposedPasswordRejectionMessage(
        assessed, "Temporary passphrase"));
      setInvitationPasswordError(true);
      requestAnimationFrame(() => (form.elements.namedItem(
        "temporaryPassword") as HTMLElement | null)?.focus());
      return;
    }
    try {
      const result = await window.scpefe.createInvitation({
        temporaryLabel: String(data.get("temporaryLabel")),
        temporaryPassword: assessed?.password,
        canEdit: data.get("canEdit") === "on",
        canAddPasswords: data.get("canAddPasswords") === "on",
        canRemovePasswords: data.get("canRemovePasswords") === "on",
      });
      setInvitationError("");
      setInvitationPasswordError(false);
      setInvitationPassphrase(result.temporaryPassword);
      form.reset();
      setTemporaryPasswordDraft("");
    } catch (error) {
      setInvitationError(safeRendererErrorMessage(error));
      const fieldAssignable = (error as { code?: string })?.code === "WEAK_PASSWORD"
        || (error as { code?: string })?.code === "PASSWORD_ALREADY_IN_USE";
      setInvitationPasswordError(fieldAssignable);
      if (fieldAssignable) {
        requestAnimationFrame(() => (form.elements.namedItem(
          "temporaryPassword") as HTMLElement | null)?.focus());
      }
    }
  }

  async function reconcileIdentity() {
    try {
      setPasswordError("");
      const result = await window.scpefe.reconcileIdentity();
      session.refreshDocument(result);
      setMessage("Password-slot identity reconciled through a sealed publication.");
    } catch (error) {
      setPasswordError(safeRendererErrorMessage(error));
    }
  }

  async function updateManagedSlot(slot: ManagedSlot, canEdit: boolean,
    canAddPasswords: boolean, canRemovePasswords: boolean) {
    try {
      setPasswordError("");
      const result = await window.scpefe.updateSlotPermissions({ slotId: slot.slotId,
        canEdit, canAddPasswords, canRemovePasswords });
      session.refreshDocument(result);
      setMessage("Slot permissions published.");
    } catch (error) {
      setPasswordError(safeRendererErrorMessage(error));
    }
  }

  async function removeManagedSlot(slot: ManagedSlot) {
    try {
      setPasswordError("");
      const result = await window.scpefe.removeSlot(slot.slotId);
      reflectCurrent((current) => ({ ...current,
        managedSlots: current.managedSlots?.filter(
          (candidate) => candidate.slotId !== slot.slotId) }));
      setMessage(catalogText(result.warningCode));
    } catch (error) {
      setPasswordError(safeRendererErrorMessage(error));
    }
  }

  function openedActionFailure(error: unknown, action: HTMLElement | null, prefix: string) {
    const value = safeRendererErrorMessage(error);
    setOpenedDialogError(value);
    setMessage(`${prefix}: ${value}`);
    requestAnimationFrame(() => action?.focus());
  }

  async function restoreRecovery() {
    const action = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    const outcome = await session.restoreRecovery();
    if (outcome.status === "attention") {
      setDecisionError("");
      setMessage("Restoring recovered work requires a confirmed lease takeover.");
    } else if (outcome.status === "recovery") {
      setMessage("Recovered work restored as unsaved changes.");
    } else if (outcome.status === "failed") {
      setMessage(`Recovery restore needs attention: ${catalogText(outcome.code)}`);
      requestAnimationFrame(() => action?.focus());
    }
  }

  async function discardRecovery() {
    const action = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    const outcome = await session.discardRecovery();
    if (outcome.status === "recovery-discarded") {
      setMessage("Recovered work discarded.");
    } else if (outcome.status === "failed") {
      setMessage(`Recovery discard needs attention: ${catalogText(outcome.code)}`);
      requestAnimationFrame(() => action?.focus());
    }
  }

  async function acceptHeadMismatch() {
    const action = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    const outcome = await session.acceptHeadMismatch();
    if (outcome.status === "head-accepted") {
      setMessage("Current authenticated head accepted. Editing may now be enabled.");
    } else if (outcome.status === "failed") {
      setMessage(`Authenticated-head acceptance needs attention: ${catalogText(outcome.code)}`);
      requestAnimationFrame(() => action?.focus());
    }
  }

  async function discardUnreadableJournal() {
    const action = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    const outcome = await session.discardUnreadableJournal();
    if (outcome.status === "unreadable-discarded") {
      setMessage("Unreadable recovery journal discarded. Editing may now be enabled.");
    } else if (outcome.status === "failed") {
      setMessage(`Unreadable journal discard needs attention: ${catalogText(outcome.code)}`);
      requestAnimationFrame(() => action?.focus());
    }
  }

  async function lock() {
    const outcome = await session.lock();
    if (outcome.status === "locked") showLockedResult({
      locked: true, journalSaved: true, warningCode: outcome.warningCode,
    });
    else if (outcome.status === "failed") setMessage(catalogText(outcome.code));
  }

  function showLockedResult(result: LockResult, closed = false) {
    document.querySelectorAll<HTMLInputElement>(
      "input[type='password'], input[readonly]").forEach((input) => { input.value = ""; });
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    flushSync(() => {
      if (closed) session.closed();
      else session.lockStarted();
      setEditorAdoption(0);
      setFindText("");
      setReplaceText("");
      setFindOpen(false);
      setFindStatus("");
      suspendedFindFocus.current = null;
      setPendingProfile(null);
      setProfileError("");
      setOpenError("");
      setPendingOpenName("");
      setPasswordError("");
      setCurrentPasswordDraft("");
      setNewPasswordDraft("");
      setNewPasswordConfirmationDraft("");
      setTemporaryPasswordDraft("");
      setClaimPasswordDraft("");
      setClaimConfirmationDraft("");
      setInvitationPassphrase(null);
      setInvitationError("");
      setClaimError("");
      setInvitationStaged(false);
      setExternalOpenRequest(null);
      setQueuedExternalOpenRequest(null);
      setCreating(false);
      setDialog(null);
      setDecisionError("");
      setOpenedDialogError("");
      setConfirmDivergenceDiscard(false);
      setCompactionError("");
      setProtection(null);
      setProtectionError("");
      setMessage(result.warningCode ? catalogText(result.warningCode)
        : "Document locked. Use Security → Unlock to continue.");
    });
    dialogReturnFocus.current = null;
  }

  function edit(content: string, cursor?: Cursor) {
    const nextCursor = cursor ?? { start: content.length, end: content.length };
    session.edit(content, nextCursor);
  }

  async function save() {
    const outcome = await session.save();
    if (outcome.status === "saved") {
      setMessage(outcome.publicationState === "pending-publication"
        ? "Manual save is pending publication; its exact candidate is stored locally."
        : outcome.publicationState === "conflict"
          ? "Manual save is local, but the target changed; divergence must be resolved."
          : "Manual save published and verified.");
    } else if (outcome.status === "failed") {
      setMessage(`Manual save failed; changes remain recoverable: ${catalogText(outcome.code)}`);
    }
  }

  function showDivergenceDraft(hasConflicts: boolean) {
    setOpenedDialogError("");
    setMessage(hasConflicts
      ? "Resolve every local/current marker, then save the merge."
      : "The three-way merge is clean. Review it, then save the merge.");
  }

  async function beginDivergenceResolution(discardUnsaved = false) {
    const action = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    setOpenedDialogError("");
    const outcome = await session.beginDivergenceResolution({ discardUnsaved });
    if (outcome.status === "attention") {
      setConfirmDivergenceDiscard(false);
      setDecisionError("");
      setMessage("Divergence resolution requires a confirmed lease takeover.");
    } else if (outcome.status === "divergence") {
      setConfirmDivergenceDiscard(false);
      showDivergenceDraft(outcome.hasConflicts);
    } else if (outcome.status === "unsaved-work") {
      setConfirmDivergenceDiscard(true);
    } else if (outcome.status === "failed") {
      setConfirmDivergenceDiscard(false);
      setMessage(`Divergence resolution needs attention: ${catalogText(outcome.code)}`);
      requestAnimationFrame(() => action?.focus());
    }
  }

  async function reconnectPublication() {
    const action = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    const outcome = await session.retryPublication();
    if (outcome.status === "divergence-required") {
      await beginDivergenceResolution();
    } else if (outcome.status === "publication") {
      setMessage(outcome.publicationState === "target-published"
        ? "Pending manual save published and verified."
        : outcome.publicationState === "conflict"
          ? "The target changed; divergence must be resolved without overwriting it."
          : "The target is still unavailable; publication remains pending.");
    } else if (outcome.status === "failed") {
      setMessage(`Publication retry needs attention: ${catalogText(outcome.code)}`);
      requestAnimationFrame(() => action?.focus());
    }
  }

  async function discardPublication() {
    const action = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    const outcome = await session.discardPublication();
    if (outcome.status === "publication-discarded") {
      setMessage("Pending manual save explicitly discarded.");
    } else if (outcome.status === "failed") {
      setMessage(`Publication discard needs attention: ${catalogText(outcome.code)}`);
      requestAnimationFrame(() => action?.focus());
    }
  }

  async function backup() {
    const outcome = await session.backup();
    if (outcome.status === "backup") setMessage(outcome.created
      ? "Verified byte-identical backup replica created."
      : "Backup canceled; the document and destination are unchanged.");
    else if (outcome.status === "failed") setMessage(catalogText(outcome.code));
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
      const value = safeRendererErrorMessage(error);
      setCompactionError(value); setMessage(`Compaction needs attention: ${value}`);
    }
  }

  function moveHistory(offset: number) {
    if (offset < 0) session.undo();
    else session.redo();
  }

  function findNext() {
    if (!findText || !editor.current) {
      setFindStatus("Enter text to find.");
      return;
    }
    session.setSelection({ start: editor.current.selectionStart,
      end: editor.current.selectionEnd });
    const found = session.findNext(findText);
    if (!found || found.status !== "selected") {
      setFindStatus("Text not found."); setMessage("Text not found."); return;
    }
    editor.current.focus();
    editor.current.setSelectionRange(found.selection.start, found.selection.end);
    const status = found.wrapped ? "Match selected after wrapping to the start."
      : "Match selected.";
    setFindStatus(status); setMessage(status);
  }

  function replaceSelection() {
    if (!findText || !editor.current || !activeDocument || opened.readOnly) return;
    const { selectionStart: start, selectionEnd: end } = editor.current;
    session.setSelection({ start, end });
    const result = session.replaceSelection(findText, replaceText);
    if (!result) return;
    if (result.status === "selected") {
      editor.current.focus();
      editor.current.setSelectionRange(result.selection.start, result.selection.end);
      const status = result.wrapped ? "Match selected after wrapping to the start."
        : "Match selected.";
      setFindStatus(status); setMessage(status);
      return;
    }
    if (result.status !== "replaced") {
      setFindStatus("Text not found."); setMessage("Text not found."); return;
    }
    const replaced = session.getSnapshot();
    const next = replaced.kind === "edit"
      ? replaced.working.selection.start : start + replaceText.length;
    setFindStatus("Selected match replaced.");
    setMessage("Selected match replaced.");
    requestAnimationFrame(() => {
      editor.current?.focus();
      editor.current?.setSelectionRange(next, next);
    });
  }

  function replaceAll() {
    if (!findText || !activeDocument || opened.readOnly) return;
    const result = session.replaceAll(findText, replaceText);
    const matches = result?.replacements ?? 0;
    if (!matches) {
      setFindStatus("Text not found."); setMessage("Text not found."); return;
    }
    const replaced = session.getSnapshot();
    const cursor = replaced.kind === "edit" ? replaced.working.selection.start : 0;
    const status = `${matches} match${matches === 1 ? "" : "es"} replaced.`;
    setFindStatus(status); setMessage(status);
    requestAnimationFrame(() => editor.current?.setSelectionRange(cursor, cursor));
  }

  function editorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "f") {
      event.preventDefault();
      dialogReturnFocus.current = editor.current;
      findReturnFocus.current = editor.current;
      setFindOpen(true);
      requestAnimationFrame(() => findInput.current?.focus());
    } else if (modifier && event.key.toLowerCase() === "z") {
      event.preventDefault(); moveHistory(event.shiftKey ? 1 : -1);
    } else if (modifier && event.key.toLowerCase() === "y") {
      event.preventDefault(); moveHistory(1);
    }
  }

  async function exportPlaintext() {
    setExportError("");
    const outcome = await session.exportPlaintext(lineEndings);
    if (outcome.status === "export") {
      setMessage(outcome.exported ? "Unprotected plaintext exported."
        : "Plaintext export canceled; the document and destination are unchanged.");
      setDialog(null);
    } else if (outcome.status === "failed") {
      const value = catalogText(outcome.code);
      setExportError(value);
      setMessage(`Plaintext export failed; the document and destination are unchanged: ${value}`);
      requestAnimationFrame(() => exportAction.current?.focus());
    }
  }

  const state = opened?.invitationRequired ? "Invitation" : lockedDocument ? "Locked"
    : !activeDocument ? "No document" : opened.readOnly ? "Read-only" : "Edit mode";
  const cleanliness = !activeDocument && !lockedDocument ? "—" : dirty ? "Dirty" : "Clean";
  const publication = !activeDocument && !lockedDocument ? "—"
    : publicationState === "pending-publication" ? "Pending publication"
      : publicationState === "conflict" ? "Publication conflict"
        : publicationState === "provisional" ? "Provisional publication" : "Published";
  const closeDialog = () => {
    setPendingProfile(null);
    setProfileError("");
    setPasswordError("");
    setInvitationPassphrase(null);
    setInvitationError("");
    setExportError("");
    setDialog(null);
  };

  useEffect(() => {
    document.title = targetName
      ? `${dirty ? "*" : ""}${targetName} — SCPEFE` : "SCPEFE";
  }, [targetName, dirty]);

  return <main className="app-shell"><div className="shell-chrome">
    <MenuBar enabled={enabled} run={(command, returnFocus) =>
      void rendererLifecycleCompletion.track(() => runCommand(command, returnFocus))} />
    <section className="editor-surface" aria-label="Document workspace">
      {!activeDocument && <p className="editor-placeholder" role="note">
        {lockedDocument ? "Document locked. Use Security → Unlock to continue."
          : "No document. Use File → New or File → Open."}</p>}
      <textarea ref={editor} aria-label="Document text"
        value={activeDocument && !modalBusy.current
          ? workingText : ""}
        disabled={!activeDocument} readOnly={!activeDocument
          || sessionSnapshot.kind !== "edit" || !sessionSnapshot.commands.write}
        onSelect={(event) => {
          const selection = { start: event.currentTarget.selectionStart,
            end: event.currentTarget.selectionEnd };
          if (working && (selection.start !== working.selection.start
              || selection.end !== working.selection.end)) session.setSelection(selection);
        }}
        onKeyDown={editorKeyDown} onChange={(event) => edit(event.target.value,
          { start: event.target.selectionStart, end: event.target.selectionEnd })} />
      {findOpen && activeDocument && !modalBusy.current
        && <section className="modeless-dialog" role="dialog"
        aria-modal="false" aria-labelledby="find-replace-title" onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault(); setFindOpen(false);
            requestAnimationFrame(() => (findReturnFocus.current?.isConnected
              ? findReturnFocus.current : editor.current)?.focus());
          }
        }}><h2 id="find-replace-title">Find and replace</h2>
        <label>Find<input ref={findInput} value={findText}
          onChange={(event) => { setFindText(event.target.value); setFindStatus(""); }} /></label>
        <label>Replace with<input ref={replaceInput} value={replaceText}
          onChange={(event) => setReplaceText(event.target.value)} /></label>
        <div className="dialog-actions"><button type="button" disabled={!findText}
          onClick={findNext}>Find next</button>
          <button type="button" disabled={opened.readOnly || !findText}
            onClick={replaceSelection}>Replace</button>
          <button type="button" disabled={opened.readOnly || !findText}
            onClick={replaceAll}>Replace all</button>
          <button type="button" onClick={() => {
            setFindOpen(false);
            requestAnimationFrame(() => (findReturnFocus.current?.isConnected
              ? findReturnFocus.current : editor.current)?.focus());
          }}>Close</button></div>
        <p className="modeless-status" role="status" aria-live="polite">{findStatus}</p>
      </section>}
    </section>
    <footer className="status-bar" role="status" aria-live="polite" aria-atomic="true">
      <span aria-label="Document state">{state}</span>
      <span aria-label="Working copy state">{cleanliness}</span>
      {activeDocument && <span aria-label="Recovery journal state">
        {working?.journal.failed ? "Checkpoint needs attention"
          : working?.journal.pending ? "Checkpoint pending" : "Checkpoint ready"}
      </span>}
      <span aria-label="Publication state">{publication}</span>
      <span>{journalSummary.total > 0 ? `${journalSummary.total} recovery item${journalSummary.total === 1 ? "" : "s"} need attention. ` : ""}{message}</span>
    </footer></div>
    {!protection && <>{editFailure && <FocusedDialog returnFocus={dialogReturnFocus.current}
      title="Editing unavailable" initialFocus={editRetryAction}
      close={() => session.dismissEditFailure()}>
      <div className="warning" role="alert"><p>{editFailure}</p>
        <p>The document remains read-only.</p></div>
      <div className="dialog-actions"><button onClick={() => session.dismissEditFailure()}>
        Continue read-only</button><button ref={editRetryAction} autoFocus onClick={() => {
          session.dismissEditFailure(); void enterEditMode();
        }}>Retry editing</button></div>
    </FocusedDialog>}
    {leaseDecision && <FocusedDialog returnFocus={dialogReturnFocus.current}
      title="Confirm editing-lease takeover">
      <div className="warning" role="alert"><p>The lease held by {leaseDecision.holderName} cannot be proved expired because the clocks disagree.</p>
        <p>Force takeover only after confirming that no other client is editing this document.</p></div>
      {decisionError && <p className="dialog-error" role="alert">{decisionError}</p>}
      <div className="dialog-actions"><button autoFocus disabled={leaseBusy}
        onClick={() => void cancelLeaseDecision()}>Cancel</button>
        <button disabled={leaseBusy} onClick={() => void confirmLeaseTakeover()}>
        {leaseDecision.operation === "migration" ? "Force takeover and migrate" : "Force takeover"}
      </button></div>
    </FocusedDialog>}
    {saveFailure && <FocusedDialog returnFocus={dialogReturnFocus.current}
      title="Manual save failed" close={() => session.dismissSaveFailure()}>
      <p className="dialog-error" role="alert">{saveFailure}</p>
      <p>The working copy and recovery journal remain available. No successful publication is being reported.</p>
      <div className="dialog-actions"><button onClick={() => session.dismissSaveFailure()}>Continue editing</button>
        <button autoFocus onClick={() => void save()}>Retry manual save</button></div>
    </FocusedDialog>}
    {confirmDivergenceDiscard && <FocusedDialog returnFocus={dialogReturnFocus.current}
      title="Discard newer unsaved edits?" close={() => setConfirmDivergenceDiscard(false)}>
      <p>The working copy has edits made after the locally saved candidate. Starting divergence resolution replaces those edits with a merge draft.</p>
      <div className="dialog-actions">
        <button onClick={() => setConfirmDivergenceDiscard(false)}>Keep newer edits</button>
        <button onClick={() => { setConfirmDivergenceDiscard(false); setDialog("export"); }}>
          Export newer edits…</button>
        <button autoFocus onClick={() => void beginDivergenceResolution(true)}>
          Discard newer edits and resolve</button>
      </div>
    </FocusedDialog>}
    {creating && <CreationSecurityDialog returnFocus={dialogReturnFocus.current} onCancel={() =>
      rendererLifecycleCompletion.track(async () => {
        await window.scpefe.cancelCreateTarget(); setCreating(false);
      })} onCreate={(request: object) => rendererLifecycleCompletion.track(async () => {
      const result = await window.scpefe.createDocument(request);
      if (result) {
        showOpenedResult({ ...result.opened, targetName: result.name });
        setCreating(false); setMessage("Encrypted blank document published successfully.");
        focusEditorAfterDialog();
      }
    })} />}
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
      close={() => { void rendererLifecycleCompletion.track(cancelOpen); }}
      initialFocus={openPassword}>
      {pendingOpenName && <p>Selected target: <strong>{pendingOpenName}</strong></p>}
      <form onSubmit={(event) => { void rendererLifecycleCompletion.track(() =>
        (externalOpenRequest ? openExternal : open)(event)); }}><label>Password
        <input ref={openPassword} name="password" type="password" required
          aria-describedby={openError ? "open-password-error" : undefined} /></label>
        {openError && <p id="open-password-error" className="dialog-error" role="alert">
          {openError}</p>}
        <div className="dialog-actions"><button type="button" onClick={() => {
          void rendererLifecycleCompletion.track(cancelOpen);
        }}>Cancel</button><button>{dialog === "unlock" ? "Unlock" : "Open"}</button>
        </div></form></FocusedDialog>}
    {dialog === "export" && activeDocument && <FocusedDialog returnFocus={dialogReturnFocus.current}
      title="Export plaintext" close={closeDialog}>
      <p className="warning"><strong>Not password protected:</strong> the exported text may persist in backups or storage history.</p>
      <label>Line endings<select value={lineEndings}
        onChange={(event) => setLineEndings(event.target.value as "lf" | "native")}>
        <option value="lf">Canonical LF</option><option value="native">Platform native</option></select></label>
      {exportError && <p className="dialog-error" role="alert">{exportError}</p>}
      <div className="dialog-actions"><button onClick={closeDialog}>Cancel</button>
        <button ref={exportAction} onClick={() => void exportPlaintext()}>
          Export current text…</button></div></FocusedDialog>}
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
            setInvitationError(safeRendererErrorMessage(error));
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
          <label>Current password<input name="currentPassword" type="password" required autoFocus
            value={currentPasswordDraft} onChange={(event) => setCurrentPasswordDraft(event.target.value)} /></label>
          <label>New password<input name="newPassword" type="password" required
            aria-describedby="change-password-policy" value={newPasswordDraft}
            onChange={(event) => setNewPasswordDraft(event.target.value)} /></label>
          <label>Confirm new password<input name="newPasswordConfirmation" type="password" required
            aria-describedby="change-password-policy" value={newPasswordConfirmationDraft}
            onChange={(event) => setNewPasswordConfirmationDraft(event.target.value)} /></label>
          <PasswordPolicyStatus id="change-password-policy" password={newPasswordDraft}
            confirmation={newPasswordConfirmationDraft} comparePassword={currentPasswordDraft}
            compareMessage="New password must differ from the current password." />
          {passwordError && <p className="dialog-error" role="alert">{passwordError}</p>}
          <button>Change password</button></form>
        {!opened.readOnly && opened.canAddPasswords && (opened.managedSlots?.length ?? 0) < 7
          && <form onSubmit={createInvitation}><h3>Invite another person</h3>
            <label>Temporary label<input name="temporaryLabel" required /></label>
            <label>Temporary passphrase (leave blank to generate)<input name="temporaryPassword" type="password"
              aria-describedby={`temporary-password-policy${invitationPasswordError
                ? " invitation-password-error" : ""}`}
              value={temporaryPasswordDraft}
              onChange={(event) => setTemporaryPasswordDraft(event.target.value)} /></label>
            <PasswordPolicyStatus id="temporary-password-policy" password={temporaryPasswordDraft}
              optionalBlankGenerates={true} />
            <label className="check"><input name="canEdit" type="checkbox" /> May edit</label>
            {opened.canAddPasswords && <label className="check"><input name="canAddPasswords" type="checkbox" /> May add passwords</label>}
            {opened.canRemovePasswords && <label className="check"><input name="canRemovePasswords" type="checkbox" /> May remove passwords</label>}
            {invitationError && <p id={invitationPasswordError
              ? "invitation-password-error" : undefined} className="dialog-error"
              role="alert">{invitationError}</p>}
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
        required autoFocus aria-describedby="claim-password-policy"
        value={claimPasswordDraft} onChange={(event) => setClaimPasswordDraft(event.target.value)} /></label>
        <label>Confirm new password<input name="newPasswordConfirmation" type="password"
          required aria-describedby="claim-password-policy"
          value={claimConfirmationDraft} onChange={(event) => setClaimConfirmationDraft(event.target.value)} /></label>
        <PasswordPolicyStatus id="claim-password-policy" password={claimPasswordDraft}
          confirmation={claimConfirmationDraft} />
        {claimError && <p className="dialog-error" role="alert">{claimError}</p>}
        <button>Replace password and claim identity</button></form>
      <button onClick={() => void cancelInvitationClaim()}>Cancel</button></FocusedDialog>}
    {visibleOpenedDialog === "migration" && activeDocument && <FocusedDialog
      returnFocus={dialogReturnFocus.current} title="Older container"
      initialFocus={openedDialogError ? migrationRetryAction : undefined}>
      <div className="warning" role="alert"><p>Migrating makes this container unreadable by older SCPEFE clients. A verified exact backup is required first.</p>
        <p>If you decline, this document stays read-only and any later save will still require migration.</p></div>
      <div className="dialog-actions"><button onClick={lock}>Keep read-only and close</button>
        {openedDialogError && <p className="dialog-error" role="alert">{openedDialogError}</p>}
        <button ref={migrationRetryAction} onClick={() => void migrate()}>
          Create verified backup and migrate…</button></div></FocusedDialog>}
    {visibleOpenedDialog === "profile-mismatch" && activeDocument && opened.profileMismatch && <FocusedDialog
      returnFocus={dialogReturnFocus.current} title="Profile mismatch">
      <div className="warning" role="alert"><p>This password slot is registered to {opened.profileMismatch.slotName} · {opened.profileMismatch.slotEmail}, while this client is configured as {opened.profileMismatch.profileName} · {opened.profileMismatch.profileEmail}.</p>
        <p>The document remains available read-only. Editing is blocked until you explicitly reconcile the slot identity.</p></div>
      <div className="dialog-actions"><button onClick={lock}>Lock now</button>
        <button onClick={() => setDialog("passwords")}>Open Passwords to reconcile</button></div></FocusedDialog>}
    {visibleOpenedDialog === "head" && activeDocument && headDecision && <FocusedDialog
      returnFocus={dialogReturnFocus.current} title={headDecision.mismatchKind === "rollback"
        ? "Authenticated rollback detected" : headDecision.mismatchKind === "divergence"
          ? "Authenticated divergence detected" : headDecision.mismatchKind === "replacement"
            ? "Document identity replacement detected" : "Authenticated witness needs attention"}>
      <p>{headDecision.mismatchKind === "rollback"
        ? "The authenticated head appears older than the last trusted observation."
        : headDecision.mismatchKind === "replacement"
          ? "The target has a different document identity."
          : headDecision.mismatchKind === "divergence"
            ? "The authenticated head diverged from the last trusted observation."
            : "The previous head observation could not be verified."}</p>
      {headDecision.failureCode && <p className="dialog-error" role="alert">
        {catalogText(headDecision.failureCode)}</p>}
      <button disabled={sessionSnapshot.kind !== "read-only"
        && sessionSnapshot.kind !== "edit" || !sessionSnapshot.commands.acceptHeadMismatch}
        onClick={acceptHeadMismatch}>Accept current authenticated head</button>
    </FocusedDialog>}
    {visibleOpenedDialog === "recovery" && activeDocument && recoveryDecision && <FocusedDialog
      returnFocus={dialogReturnFocus.current} title="Recovered work"
      initialFocus={recoveryDecision.failureCode ? recoveryRestoreAction : undefined}>
      <p>Recovered work from {new Date(recoveryDecision.updateTime).toLocaleString()} is available as unsaved changes.</p>
      {recoveryDecision.failureCode && <p className="dialog-error" role="alert">
        {catalogText(recoveryDecision.failureCode)}</p>}
      <div className="dialog-actions"><button disabled={sessionSnapshot.kind !== "read-only"
        && sessionSnapshot.kind !== "edit" || !sessionSnapshot.commands.recoveryDiscard}
        onClick={discardRecovery}>Discard recovered work</button>
        <button ref={recoveryRestoreAction} disabled={sessionSnapshot.kind !== "read-only"
          && sessionSnapshot.kind !== "edit" || !sessionSnapshot.commands.recoveryRestore}
          onClick={restoreRecovery}>Restore unsaved work</button></div></FocusedDialog>}
    {visibleOpenedDialog === "unreadable" && activeDocument && unreadableDecision
      && <FocusedDialog returnFocus={dialogReturnFocus.current}
        title="Unreadable recovery journal">
        <p>The recovery journal for this document could not be read. Keep the document read-only or explicitly discard that journal before editing.</p>
        {unreadableDecision.failureCode && <p className="dialog-error" role="alert">
          {catalogText(unreadableDecision.failureCode)}</p>}
        <div className="dialog-actions"><button onClick={lock}>Keep read-only and close</button>
          <button disabled={sessionSnapshot.kind !== "read-only"
            && sessionSnapshot.kind !== "edit" || !sessionSnapshot.commands.unreadableDiscard}
            onClick={discardUnreadableJournal}>Discard unreadable journal</button></div>
      </FocusedDialog>}
    {visibleOpenedDialog === "publication" && activeDocument && publicationDecision
      && <FocusedDialog returnFocus={dialogReturnFocus.current}
        initialFocus={publicationDecision.failureCode || openedDialogError
          ? publicationRetryAction : undefined}
        title={publicationDecision.state === "conflict" ? "Divergence needs resolution" : "Manual save pending publication"}>
        <p>{publicationDecision.state === "conflict" ? "The target changed. The locally saved candidate was preserved for divergence handling." : "This manual save is stored locally and has not reached its target."}</p>
        {(publicationDecision.failureCode || openedDialogError)
          && <p className="dialog-error" role="alert">
            {publicationDecision.failureCode
              ? catalogText(publicationDecision.failureCode) : openedDialogError}</p>}
        <div className="dialog-actions"><button disabled={sessionSnapshot.kind !== "read-only"
          && sessionSnapshot.kind !== "edit" || !sessionSnapshot.commands.publicationDiscard}
          onClick={discardPublication}>Discard pending save</button>
          <button ref={publicationRetryAction} disabled={sessionSnapshot.kind !== "read-only"
            && sessionSnapshot.kind !== "edit" || !sessionSnapshot.commands.publicationRetry}
            onClick={reconnectPublication}>Retry publication</button></div></FocusedDialog>}
    </>}
    {protection && <FocusedDialog returnFocus={dialogReturnFocus.current}
      title={protection.operation === "new" ? "Protect current document before New"
        : protection.operation === "open" || protection.operation === "external-open"
          ? "Protect current document before Open"
          : protection.operation === "close" ? "Protect current document before Close"
          : "Protect current document before Exit"}>
      <div className="warning" role="alert">
        <p>The current session has work or publication state that must not be silently lost.</p>
        <ul>
          {protection.state.dirty && <li>Unsaved working-copy changes</li>}
          {protection.state.provisional && <li>Provisional revision not manually sealed</li>}
          {protection.state.pendingPublication && <li>Pending publication</li>}
          {protection.state.recovered && <li>Recovered unsaved work</li>}
          {protection.state.conflict && <li>Unresolved publication conflict</li>}
          {protection.state.unresolvedJournal && <li>Unresolved recovery journal</li>}
          {protection.state.activePublication && <li>Publication or container maintenance in progress</li>}
        </ul>
        <p>Cancel keeps this document open. Save retries or seals recoverable work. Discard is permanent where policy permits it.</p>
      </div>
      {protectionError && <p className="dialog-error" role="alert">{protectionError}</p>}
      <div className="dialog-actions"><button ref={(node) => {
        if (node && !protectionError) node.focus();
      }}
        onClick={() => void rendererLifecycleCompletion.track(() =>
          decideProtection("cancel"))}>Keep current document open</button>
        <button onClick={() => void rendererLifecycleCompletion.track(() =>
          decideProtection("save"))}>
          {protection.state.pendingPublication ? "Retry publication and continue"
            : "Manual save and continue"}</button>
        <button onClick={() => void rendererLifecycleCompletion.track(() =>
          decideProtection("discard"))}>Discard and continue</button>
      </div>
    </FocusedDialog>}
  </main>;
}

export function mountApp(host: HTMLElement): Root {
  const root = createRoot(host);
  root.render(<App />);
  return root;
}

const applicationHost = document.getElementById("root");
if (applicationHost) {
  (window as unknown as Record<symbol, RendererLifecycleCompletion>)[
    RENDERER_LIFECYCLE_COMPLETION] = rendererLifecycleCompletion;
  const applicationRoot = mountApp(applicationHost);
  const mountObserver = (window as unknown as Record<symbol,
    ((root: Root) => void) | undefined>)[Symbol.for("scpefe.renderer.mount")];
  mountObserver?.(applicationRoot);
}
