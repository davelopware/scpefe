import React, { FormEvent, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { DocumentSession, type WorkingCopyJournalHost } from "@scpefe/frontend-core";
import { useSessionSnapshot } from "../use-session-snapshot.ts";
import { MenuBar } from "../shell/menu-bar.tsx";
import { StatusBar } from "../shell/status-bar.tsx";
import { FocusedDialog } from "../dialogs/focused-dialog.tsx";
import { DialogHost, type DialogAction, type DialogHostHandle } from "../dialogs/dialog-host.tsx";
import { SlotAdministration } from "../security/slot-administration.tsx";
import { EditorView, type EditorViewHandle } from "../editor/editor-view.tsx";
import type { Profile, Cursor, Recovery, Lease, HeadMismatch, PublicationState,
  ClientSettings, JournalSummary, ExternalOpenRequest, ProtectionRequest,
  ProfileMismatch, ManagedSlot, MergeDraft, LeaseOperation, LeaseDecision,
  DocumentOpened, Opened, DialogName, OpenedDialogName } from "./types.ts";

function isDocumentOpened(value: Opened | null): value is DocumentOpened {
  return value !== null && value.invitationRequired !== true;
}

function openedDialogName(value: Opened | null): OpenedDialogName {
  if (value?.invitationRequired) return "claim";
  if (!isDocumentOpened(value)) return null;
  if (value.profileMismatch) return "profile-mismatch";
  return null;
}

function sessionAttentionNeedsDialog(kind: string | undefined): boolean {
  return kind === "head-mismatch" || kind === "unreadable-journal"
    || kind === "recovery-decision" || kind === "publication-decision"
    || kind === "migration-decision";
}

type LockResult = { locked: true; journalSaved: boolean; warningCode: string | null };
export interface SharedFrontendHost {
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
    previousHead: string; head: string; opened: DocumentOpened } | null>;
  migrateDocument(request?: { authorization?: string }): Promise<{
    migrated: true; backupCreated: true; compatibilityCode: string;
    opened: DocumentOpened } | LeaseDecision | null>;
  changePassword(request: { currentPassword: string; newPassword: string;
    newPasswordConfirmation: string }): Promise<DocumentOpened>;
  createInvitation(request: object): Promise<{ created: true; temporaryPassword: string;
    opened: DocumentOpened }>;
  copyInvitationPassphrase(password: string): Promise<boolean>;
  claimInvitation(request: { newPassword: string;
    newPasswordConfirmation: string }): Promise<DocumentOpened>;
  cancelInvitationClaim(): Promise<boolean>;
  reconcileIdentity(): Promise<DocumentOpened>;
  updateSlotPermissions(request: object): Promise<DocumentOpened>;
  removeSlot(slotId: string): Promise<{ removed: true; warningCode: "SLOT_REMOVED";
    opened: DocumentOpened }>;
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
}

/** Small platform capabilities required to mount the shared session view. */
export interface SharedAppProps {
  host: SharedFrontendHost;
  completion: {
    setSessionSource(source: { getPendingWorkCount(): number;
      subscribe(listener: () => void): () => void } | null): void;
    track<T>(operation: () => T | Promise<T>): Promise<T>;
  };
  catalogText(code: string, operation?: string): string;
  safeRendererErrorMessage(error: unknown): string;
  closeWindow(): void;
  assessProposedPassword(password: string): Promise<ProposedPasswordOutcome>;
  proposedPasswordRejectionMessage(result: ProposedPasswordOutcome, label?: string): string;
  CreationSecurityDialog: React.ComponentType<{ onCreate(request: CreationFormRequest): Promise<void>;
    onCancel(): void | Promise<void>; returnFocus?: HTMLElement | null }>;
  CompactionControls: React.ComponentType<{ onCompact(): Promise<void> }>;
  PasswordPolicyStatus: React.ComponentType<{ id: string; password: string;
    confirmation?: string; optionalBlankGenerates?: boolean;
    comparePassword?: string; compareMessage?: string }>;
}

/** Proposed password result supplied by the platform's native policy adapter. */
export type ProposedPasswordOutcome =
  | Readonly<{ status: "empty" | "unavailable" }>
  | Readonly<{ status: "rejected"; reason: "invalid" | "minimum-length"
    | "maximum-size" | "predictable" }>
  | Readonly<{ status: "accepted"; password: string }>;

/** Security fields passed to the platform's create target command. */
export type CreationFormRequest = {
  ownerPassword: string; ownerPasswordConfirmation: string;
  recoveryPassword: string; recoveryPasswordConfirmation: string;
  content: ""; understandsIrrecoverable: true; storedRecoverySeparately: boolean;
};

export function SharedApp({ host, completion: rendererLifecycleCompletion,
  catalogText, safeRendererErrorMessage, closeWindow, assessProposedPassword,
  proposedPasswordRejectionMessage, CreationSecurityDialog, CompactionControls,
  PasswordPolicyStatus }: SharedAppProps) {
  const [sessionStore] = useState(() => {
    let journalSequence = 0;
    const journalPrefix = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const warningListeners = new Set<(code: string, scope: string | null) => void>();
    const journal: WorkingCopyJournalHost = {
      createJournalScope: () => `renderer-${journalPrefix}-${++journalSequence}`,
      updateWorkingCopy: (update) => host.updateWorkingCopy(update),
      onJournalWarning: (listener) => {
        warningListeners.add(listener);
        return () => { warningListeners.delete(listener); };
      },
    };
    return {
      session: new DocumentSession<DocumentOpened, Extract<Opened,
        { invitationRequired: true }>>(host, journal),
      forwardJournalWarning: (code: string, scope: string | null) => {
        for (const listener of warningListeners) listener(code, scope);
      },
    };
  });
  const session = sessionStore.session;
  useEffect(() => {
    rendererLifecycleCompletion.setSessionSource({
      getPendingWorkCount: session.getPendingWorkCount,
      subscribe: session.subscribeWork,
    });
    return () => rendererLifecycleCompletion.setSessionSource(null);
  }, [session]);
  const sessionSnapshot = useSessionSnapshot(session);
  const opened: Opened | null = sessionSnapshot.kind === "read-only"
    || sessionSnapshot.kind === "edit" ? sessionSnapshot.document : null;
  const securityCommands = sessionSnapshot.kind === "read-only"
    || sessionSnapshot.kind === "edit" ? sessionSnapshot.commands : null;
  const targetName = sessionSnapshot.kind === "closed" ? null
    : sessionSnapshot.targetName;
  const lockedDocument = sessionSnapshot.kind === "locked";
  const working = sessionSnapshot.kind === "read-only" || sessionSnapshot.kind === "edit"
    ? sessionSnapshot.working : null;
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
  const migrationDecision = attention?.kind === "migration-decision" ? attention : null;
  const publicationResolving = sessionSnapshot.kind === "read-only"
    || sessionSnapshot.kind === "edit" ? sessionSnapshot.publication.resolving : false;
  const securityPresentationEpoch = useRef(0);
  const invitationSubmission = useRef<number | null>(null);
  const invitationSubmissionSequence = useRef(0);
  useEffect(() => () => {
    securityPresentationEpoch.current += 1;
    invitationSubmission.current = null;
    session.dispose();
  }, [session]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [clientSettings, setClientSettings] = useState<ClientSettings>({
    regularSaveEnabled: false, regularSaveIntervalMs: 120_000,
  });
  const [message, setMessage] = useState("");
  const [editorAdoption, setEditorAdoption] = useState(0);
  const [lineEndings, setLineEndings] = useState<"lf" | "native">("lf");
  const [exportError, setExportError] = useState("");
  const externalOpen = sessionSnapshot.externalOpen;
  const [dialog, setDialog] = useState<DialogName>(null);
  const [creating, setCreating] = useState(false);
  const [openError, setOpenError] = useState("");
  const [pendingOpenName, setPendingOpenName] = useState("");
  const invitationStaged = sessionSnapshot.invitationStaged === true;
  const [decisionError, setDecisionError] = useState("");
  const [openedDialogError, setOpenedDialogError] = useState("");
  const [confirmDivergenceDiscard, setConfirmDivergenceDiscard] = useState(false);
  const [pendingProfile, setPendingProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [invitationPassphrase, setInvitationPassphrase] = useState<string | null>(null);
  const [invitationError, setInvitationError] = useState("");
  const [invitationBusy, setInvitationBusy] = useState(false);
  const [invitationPasswordError, setInvitationPasswordError] = useState(false);
  const [claimError, setClaimError] = useState("");
  const [currentPasswordDraft, setCurrentPasswordDraft] = useState("");
  const [newPasswordDraft, setNewPasswordDraft] = useState("");
  const [newPasswordConfirmationDraft, setNewPasswordConfirmationDraft] = useState("");
  const [temporaryPasswordDraft, setTemporaryPasswordDraft] = useState("");
  const [claimPasswordDraft, setClaimPasswordDraft] = useState("");
  const [claimConfirmationDraft, setClaimConfirmationDraft] = useState("");
  const protection = sessionSnapshot.attention?.kind === "lifecycle-protection"
    ? sessionSnapshot.attention : null;
  const editorView = useRef<EditorViewHandle>(null);
  const replacementFocusPending = useRef(false);
  const exportAction = useRef<HTMLButtonElement>(null);
  const openPassword = useRef<HTMLInputElement>(null);
  const profileConfirmation = useRef<HTMLButtonElement>(null);
  const dialogHost = useRef<DialogHostHandle>(null);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);
  const modalBusy = useRef(false);
  const openedDialog = opened?.invitationRequired ? "claim"
    : headDecision ? "head" : unreadableDecision ? "unreadable"
      : recoveryDecision ? "recovery" : publicationDecision ? "publication"
        : isDocumentOpened(opened) && opened.profileMismatch ? "profile-mismatch"
        : migrationDecision ? "migration"
        : openedDialogName(opened);
  const visibleOpenedDialog = !creating && dialog === null && !confirmDivergenceDiscard
    && leaseDecision === null && saveFailure === null
    ? invitationStaged ? "claim" : openedDialog : null;
  modalBusy.current = protection !== null || creating || dialog !== null || visibleOpenedDialog !== null
    || invitationStaged || confirmDivergenceDiscard
    || editFailure !== null || leaseDecision !== null || saveFailure !== null;
  useEffect(() => {
    void rendererLifecycleCompletion.track(() => host.getProfile().then((value) => {
      setProfile(value); if (!value) setDialog("profile");
    }).catch(showError));
    void rendererLifecycleCompletion.track(() =>
      host.getClientSettings().then(setClientSettings).catch(showError));
    void rendererLifecycleCompletion.track(() =>
      host.getUnresolvedJournalSummary().then((summary) => {
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
    const stopLockStarted = host.onLockStarted?.(() => showLockedResult({
      locked: true, journalSaved: true, warningCode: null,
    })) ?? (() => {});
    const stopLocked = host.onLocked(showLockedResult);
    const stopWarning = host.onJournalWarning((code, scope) => {
      sessionStore.forwardJournalWarning(code, scope);
      setMessage(catalogText(code));
    });
    const stopRegularSave = host.onRegularSave((result) => {
      if (session.regularSavePublished(result)) {
        setMessage("Regular save published provisionally; changes remain unsaved until manual save.");
      }
    });
    const stopExternalOpen = host.onExternalOpenRequested((request) => {
      if (!session.queueExternalOpen(request)) return;
      const current = session.getSnapshot();
      if (modalBusy.current || (current.kind === "read-only" || current.kind === "edit")
        && current.publication.resolving) {
        setMessage("Another open request is waiting for the current dialog.");
      } else {
        dialogReturnFocus.current = document.activeElement as HTMLElement | null;
        session.activateExternalOpen(); setDialog("open");
        setMessage("Another open request is waiting. Enter its document password to continue.");
      }
    });
    const stopJournalSummary = host.onUnresolvedJournalSummary(
      (summary) => { session.observeRecoveryDiscovery(summary); });
    const stopSwitchRetained = host.onSwitchRetained((result) => {
      showOpenedResult(result);
      setMessage("The current document remains open with its manual save pending publication.");
    });
    const stopProtection = host.onProtectionRequested?.((request) => {
      dialogReturnFocus.current = document.activeElement as HTMLElement | null;
      session.stageProtection(request);
    }) ?? (() => {});
    const stopClosed = host.onDocumentClosed?.(() => {
      showLockedResult({ locked: true, journalSaved: true, warningCode: null }, true);
    }) ?? (() => {});
    const activity = () => { void host.activity(); };
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
    if (!modalBusy.current && !creating && dialog === null && openedDialog === null
      && !publicationResolving && !externalOpen?.active && externalOpen?.queued) {
      dialogReturnFocus.current = document.activeElement as HTMLElement | null;
      session.activateExternalOpen();
      setDialog("open");
      setMessage("Another open request is waiting. Enter its document password to continue.");
    }
  }, [creating, dialog, openedDialog, modalBusy.current, publicationResolving,
    externalOpen?.active, externalOpen?.queued, session]);

  function showOpenedResult(result: DocumentOpened, alreadyAdopted = false) {
    securityPresentationEpoch.current += 1;
    invitationSubmission.current = null;
    setInvitationBusy(false);
    if (!alreadyAdopted) session.adopt(result);
    const adopted = session.getSnapshot();
    if (adopted.kind === "read-only" || adopted.kind === "edit") {
      setEditorAdoption(adopted.adoption);
    }
    setDecisionError("");
    setOpenedDialogError("");
    setConfirmDivergenceDiscard(false);
    editorView.current?.reset();
    setCurrentPasswordDraft(""); setNewPasswordDraft("");
    setNewPasswordConfirmationDraft(""); setTemporaryPasswordDraft("");
    setClaimPasswordDraft(""); setClaimConfirmationDraft("");
    setInvitationPassphrase(null);
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
      securityPresentationEpoch.current += 1;
      invitationSubmission.current = null;
      setInvitationBusy(false);
      setInvitationPassphrase(null);
      setCurrentPasswordDraft(""); setNewPasswordDraft("");
      setNewPasswordConfirmationDraft(""); setTemporaryPasswordDraft("");
      setClaimPasswordDraft(""); setClaimConfirmationDraft("");
      session.adopt(result);
      setMessage("Claim the invitation before its document replaces the current session.");
      return;
    }
    showOpenedResult(result, alreadyAdopted);
  }

  function focusEditorAfterDialog() {
    replacementFocusPending.current = true;
  }

  const activeDocument = isDocumentOpened(opened)
    && (sessionSnapshot.kind === "read-only" || sessionSnapshot.kind === "edit")
    && sessionSnapshot.adoption === editorAdoption;
  useEffect(() => {
    if (!replacementFocusPending.current || creating || dialog !== null
        || visibleOpenedDialog !== null || protection !== null || !activeDocument) return;
    replacementFocusPending.current = false;
    requestAnimationFrame(() => requestAnimationFrame(() => editorView.current?.focus()));
  }, [activeDocument, creating, dialog, protection, visibleOpenedDialog]);
  async function runCommand(command: string, returnFocus?: HTMLElement | null) {
    if (modalBusy.current) return;
    if (returnFocus?.isConnected) dialogReturnFocus.current = returnFocus;
    if (command === "new") {
      try { if (await host.chooseCreateTarget()) setCreating(true); }
      catch (error) { showError(error); }
    } else if (command === "open") {
      try {
        const selected = await host.chooseOpenTarget();
        if (selected) {
          setPendingOpenName(selected.name); setOpenError(""); setDialog("open");
        }
      } catch (error) { showError(error); }
    } else if (command === "find" || command === "replace") {
      editorView.current?.openFind(command,
        returnFocus?.isConnected ? returnFocus : document.activeElement as HTMLElement | null);
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
      const outcome = await session.exit();
      if (outcome.status === "failed") setMessage(catalogText(outcome.code));
    }
  }

  async function decideProtection(decision: "cancel" | "save" | "discard") {
    if (!protection) return;
    const outcome = await session.decideProtection(decision);
    if (outcome.status === "protection-canceled") {
      setMessage("Action canceled; the current document remains open and usable.");
    }
  }

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
      const saved = await host.saveProfile(candidate);
      const adoption = currentAdoption();
      const authoritative = identityChanged ? await host.reconcileProfile() : null;
      setProfile(saved);
      setPendingProfile(null);
      setProfileError("");
      if (authoritative && adoption !== null) {
        session.refreshDocumentForAdoption(authoritative, adoption);
      }
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
      const result = await host.saveClientSettings({
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
    if (externalOpen?.active) {
      const outcome = await session.cancelExternalOpen();
      if (outcome.status !== "external-canceled") {
        if (outcome.status === "failed") setOpenError(catalogText(outcome.code));
        requestAnimationFrame(() => openPassword.current?.focus());
        return;
      }
    } else if (dialog === "open") {
      try { await host.cancelOpenTarget(); }
      catch (error) {
        setOpenError(safeRendererErrorMessage(error));
        requestAnimationFrame(() => openPassword.current?.focus());
        return;
      }
    }
    setPendingOpenName(""); setOpenError(""); closeDialog();
  }

  async function openExternal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!externalOpen?.active) return;
    const data = new FormData(event.currentTarget);
    const outcome = await session.openExternal(String(data.get("password")));
    if (outcome.status === "failed") {
      setOpenError(catalogText(outcome.code));
      requestAnimationFrame(() => openPassword.current?.focus());
      return;
    }
    if (outcome.status === "superseded") return;
    if (outcome.status === "opened") {
      const adopted = session.getSnapshot();
      if (adopted.kind !== "read-only" && adopted.kind !== "edit") return;
      showReplacementResult(adopted.document, true);
      setDialog(null);
      if (openedDialogName(adopted.document) === null
        && !sessionAttentionNeedsDialog(adopted.attention?.kind)) focusEditorAfterDialog();
    } else if (outcome.status === "invitation") {
      setDialog(null);
      setMessage("Claim the invitation before its document replaces the current session.");
    } else if (outcome.status === "external-canceled") {
      setDialog(null);
      setMessage("Open request canceled; the current document remains open.");
    }
    session.observeRecoveryDiscovery(await host.getUnresolvedJournalSummary());
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
      requestAnimationFrame(() => dialogHost.current?.focus("edit"));
      return;
    }
    setOpenedDialogError(value);
    setMessage(`${operation === "migration" ? "Migration"
      : operation === "recovery" ? "Recovery restore"
      : "Divergence resolution"} needs attention: ${value}`);
    requestAnimationFrame(() => {
      dialogHost.current?.focus(operation === "migration" ? "migration"
        : operation === "recovery" ? "recovery" : "publication");
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
    setDecisionError("");
    const outcome = await session.migrate();
    if (outcome.status === "migration") setMessage(catalogText(outcome.compatibilityCode));
    else if (outcome.status === "attention")
      setMessage("Migration requires a confirmed lease takeover.");
    else if (outcome.status === "migration-canceled")
      setMessage("Migration was canceled before publication. Retry to acquire fresh lease authorization.");
    else if (outcome.status === "failed") setMessage(catalogText(outcome.code));
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
      setMessage(catalogText(outcome.compatibilityCode));
    } else if (outcome.status === "edit-mode") {
      setMessage("Edit mode entered after confirmed lease takeover.");
    } else if (outcome.status === "failed") {
      leaveConsumedTakeover(leaseDecision.operation, catalogText(outcome.code));
    } else if (outcome.status === "migration-canceled") {
      setMessage("Migration was canceled before publication. Retry to acquire fresh lease authorization.");
      requestAnimationFrame(() => dialogHost.current?.focus("migration"));
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
    const startingSnapshot = session.getSnapshot();
    const assessed = await assessProposedPassword(String(data.get("newPassword")));
    if (session.getSnapshot() !== startingSnapshot) return;
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
      const outcome = await session.claimInvitation({ newPassword: password,
        newPasswordConfirmation: String(data.get("newPasswordConfirmation")) });
      if (outcome.status === "invitation-claimed") {
        form.reset();
        const adopted = session.getSnapshot();
        if (adopted.kind === "read-only" || adopted.kind === "edit") {
          showOpenedResult(adopted.document, true);
        }
        setMessage("Invitation claimed and replacement password safely published.");
      } else if (outcome.status === "failed") {
        setClaimError(catalogText(outcome.code));
      }
    } catch (error) {
      setClaimError(safeRendererErrorMessage(error));
      requestAnimationFrame(() => (form.elements.namedItem(
        "newPassword") as HTMLElement | null)?.focus());
    }
  }

  async function cancelInvitationClaim() {
    try {
      const outcome = await session.cancelInvitationClaim();
      if (outcome.status === "claim-canceled") {
        setClaimError("");
        setClaimPasswordDraft(""); setClaimConfirmationDraft("");
        setMessage("Invitation claim canceled; the current session is unchanged.");
      } else if (outcome.status === "failed") {
        setClaimError(catalogText(outcome.code));
      }
    } catch (error) {
      setClaimError(safeRendererErrorMessage(error));
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword"));
    const startingSnapshot = session.getSnapshot();
    const assessed = await assessProposedPassword(String(data.get("newPassword")));
    if (session.getSnapshot() !== startingSnapshot) return;
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
      const outcome = await session.changePassword({
        currentPassword, newPassword: proposedPassword,
        newPasswordConfirmation: confirmation,
      });
      if (outcome.status === "password-changed") {
        form.reset();
        setCurrentPasswordDraft(""); setNewPasswordDraft("");
        setNewPasswordConfirmationDraft("");
        setMessage("Password changed and the updated document was published safely.");
      } else if (outcome.status === "failed") {
        setPasswordError(catalogText(outcome.code));
        if (outcome.code === "WEAK_PASSWORD"
          || outcome.code === "PASSWORD_ALREADY_IN_USE") {
          requestAnimationFrame(() => (form.elements.namedItem(
            "newPassword") as HTMLElement | null)?.focus());
        }
      }
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
    if (invitationSubmission.current !== null) return;
    const form = event.currentTarget;
    const submission = ++invitationSubmissionSequence.current;
    const presentationEpoch = securityPresentationEpoch.current;
    invitationSubmission.current = submission;
    setInvitationBusy(true);
    try {
      await publishInvitation(form, presentationEpoch);
    } catch (error) {
      if (securityPresentationEpoch.current === presentationEpoch) {
        setInvitationError(safeRendererErrorMessage(error));
      }
    } finally {
      if (invitationSubmission.current === submission) {
        invitationSubmission.current = null;
        setInvitationBusy(false);
      }
    }
  }

  async function publishInvitation(form: HTMLFormElement, presentationEpoch: number) {
    const data = new FormData(form);
    const enteredTemporary = String(data.get("temporaryPassword"));
    const startingSnapshot = session.getSnapshot();
    const assessed = enteredTemporary
      ? await assessProposedPassword(enteredTemporary) : null;
    if (session.getSnapshot() !== startingSnapshot) return;
    if (assessed && assessed.status !== "accepted") {
      setInvitationError(proposedPasswordRejectionMessage(
        assessed, "Temporary passphrase"));
      setInvitationPasswordError(true);
      requestAnimationFrame(() => (form.elements.namedItem(
        "temporaryPassword") as HTMLElement | null)?.focus());
      return;
    }
    try {
      const outcome = await session.createInvitation({
        temporaryLabel: String(data.get("temporaryLabel")),
        temporaryPassword: assessed?.password,
        canEdit: data.get("canEdit") === "on",
        canAddPasswords: data.get("canAddPasswords") === "on",
        canRemovePasswords: data.get("canRemovePasswords") === "on",
      }, (passphrase) => {
        if (securityPresentationEpoch.current === presentationEpoch) {
          setInvitationPassphrase(passphrase);
        }
      });
      if (outcome.status === "invitation-created") {
        setInvitationError("");
        setInvitationPasswordError(false);
        form.reset();
        setTemporaryPasswordDraft("");
      } else if (outcome.status === "failed") {
        setInvitationError(catalogText(outcome.code));
        const fieldAssignable = outcome.code === "WEAK_PASSWORD"
          || outcome.code === "PASSWORD_ALREADY_IN_USE";
        setInvitationPasswordError(fieldAssignable);
        if (fieldAssignable) requestAnimationFrame(() => (form.elements.namedItem(
          "temporaryPassword") as HTMLElement | null)?.focus());
      }
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
      const outcome = await session.reconcileIdentity();
      if (outcome.status === "identity-reconciled") {
        setMessage("Password-slot identity reconciled through a sealed publication.");
      } else if (outcome.status === "failed") setPasswordError(catalogText(outcome.code));
    } catch (error) {
      setPasswordError(safeRendererErrorMessage(error));
    }
  }

  async function updateManagedSlot(slot: ManagedSlot, canEdit: boolean,
    canAddPasswords: boolean, canRemovePasswords: boolean) {
    try {
      setPasswordError("");
      const outcome = await session.updateSlotPermissions({ slotId: slot.slotId,
        canEdit, canAddPasswords, canRemovePasswords });
      if (outcome.status === "permissions-updated") setMessage("Slot permissions published.");
      else if (outcome.status === "failed") setPasswordError(catalogText(outcome.code));
    } catch (error) {
      setPasswordError(safeRendererErrorMessage(error));
    }
  }

  async function removeManagedSlot(slot: ManagedSlot) {
    try {
      setPasswordError("");
      const outcome = await session.removeSlot(slot.slotId);
      if (outcome.status === "slot-removed") setMessage(catalogText(outcome.warningCode));
      else if (outcome.status === "failed") setPasswordError(catalogText(outcome.code));
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
    securityPresentationEpoch.current += 1;
    invitationSubmission.current = null;
    document.querySelectorAll<HTMLInputElement>(
      "input[type='password'], input[readonly]").forEach((input) => { input.value = ""; });
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    flushSync(() => {
      if (closed) session.closed();
      else session.lockStarted();
      setEditorAdoption(0);
      editorView.current?.reset();
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
      setInvitationBusy(false);
      setInvitationError("");
      setClaimError("");
      setCreating(false);
      setDialog(null);
      setDecisionError("");
      setOpenedDialogError("");
      setConfirmDivergenceDiscard(false);
      setMessage(result.warningCode ? catalogText(result.warningCode)
        : "Document locked. Use Security → Unlock to continue.");
    });
    dialogReturnFocus.current = null;
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
    const outcome = await session.confirmCompaction();
    if (outcome.status === "compaction") {
      setDialog("passwords");
      setMessage("Verified backup created and document history compacted.");
    } else if (outcome.status === "compaction-canceled") {
      setMessage("Compaction canceled; document history is unchanged.");
    } else if (outcome.status === "failed") setMessage(catalogText(outcome.code));
  }

  function moveHistory(offset: number) {
    if (offset < 0) session.undo();
    else session.redo();
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

  function handleDialogAction(action: DialogAction): void | Promise<void> {
    switch (action) {
      case "retry-edit": return enterEditMode();
      case "cancel-lease": return cancelLeaseDecision();
      case "confirm-lease": return confirmLeaseTakeover();
      case "retry-save": return save();
      case "lock": lock(); return;
      case "migrate": return migrate();
      case "open-passwords": setDialog("passwords"); return;
      case "accept-head": return acceptHeadMismatch();
      case "discard-recovery": return discardRecovery();
      case "restore-recovery": return restoreRecovery();
      case "discard-unreadable": return discardUnreadableJournal();
      case "discard-publication": return discardPublication();
      case "reconnect-publication": return reconnectPublication();
      case "compact": return compact();
      case "compaction-canceled": setMessage("Compaction canceled; document history is unchanged."); return;
      case "protection-cancel": return rendererLifecycleCompletion.track(() => decideProtection("cancel"));
      case "protection-save": return rendererLifecycleCompletion.track(() => decideProtection("save"));
      case "protection-discard": return rendererLifecycleCompletion.track(() => decideProtection("discard"));
    }
  }
  const closeDialog = () => {
    if (invitationSubmission.current !== null) return;
    securityPresentationEpoch.current += 1;
    setPendingProfile(null);
    setProfileError("");
    setPasswordError("");
    setInvitationPassphrase(null);
    setCurrentPasswordDraft(""); setNewPasswordDraft("");
    setNewPasswordConfirmationDraft(""); setTemporaryPasswordDraft("");
    setClaimPasswordDraft(""); setClaimConfirmationDraft("");
    setInvitationError("");
    setExportError("");
    setDialog(null);
  };

  useEffect(() => {
    document.title = targetName
      ? `${dirty ? "*" : ""}${targetName} — SCPEFE` : "SCPEFE";
  }, [targetName, dirty]);

  return <main className="app-shell"><div className="shell-chrome">
    <MenuBar session={session} active={activeDocument} profileReady={profile !== null}
      blocked={modalBusy.current}
      run={(command, returnFocus) =>
      void rendererLifecycleCompletion.track(() => runCommand(command, returnFocus))} />
    <EditorView ref={editorView} session={session} active={activeDocument}
      locked={lockedDocument} blocked={modalBusy.current} onMessage={setMessage}
      onReturnFocus={(element) => { dialogReturnFocus.current = element; }} />
    <StatusBar session={session} active={activeDocument} message={message} /></div>
    {!protection && <>    {confirmDivergenceDiscard && <FocusedDialog returnFocus={dialogReturnFocus.current}
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
        await host.cancelCreateTarget(); setCreating(false);
      })} onCreate={(request: object) => rendererLifecycleCompletion.track(async () => {
      const outcome = await session.create(request);
      if (outcome.status === "created") {
        const current = session.getSnapshot();
        if (current.kind !== "read-only" && current.kind !== "edit") return;
        showOpenedResult(current.document, true);
        setCreating(false); setMessage("Encrypted blank document published successfully.");
        focusEditorAfterDialog();
      } else if (outcome.status === "failed") throw new Error(catalogText(outcome.code));
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
            onClick={closeWindow}>Exit application</button>}
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
        : externalOpen?.active ? "Open requested document" : "Open document"}
      close={() => { void rendererLifecycleCompletion.track(cancelOpen); }}
      initialFocus={openPassword}>
      {pendingOpenName && <p>Selected target: <strong>{pendingOpenName}</strong></p>}
      <form onSubmit={(event) => { void rendererLifecycleCompletion.track(() =>
        (externalOpen?.active ? openExternal : open)(event)); }}><label>Password
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
            await host.copyInvitationPassphrase(invitationPassphrase);
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
          <button disabled={!securityCommands?.changePassword}>Change password</button></form>
        {(securityCommands?.createInvitation || sessionSnapshot.pending === "invitation-create")
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
            {invitationBusy && <p role="status">Finishing invitation publication…</p>}
            <button disabled={invitationBusy}>
              Create invitation</button></form>}
        {!opened.readOnly && opened.canAddPasswords && (opened.managedSlots?.length ?? 0) >= 7
          && <p role="note">The limit of eight ordinary password slots has been reached.</p>}
        <SlotAdministration opened={opened} commands={securityCommands ?? {
          updateSlotPermissions: false, removeSlot: false, compact: false }} onUpdate={updateManagedSlot}
          onRemove={removeManagedSlot} CompactionControls={CompactionControls} onCompact={async () => {
            if (session.requestCompaction().status === "attention") {
              setDialog("compaction");
            }
          }} />
        <div className="dialog-actions"><button onClick={closeDialog}
          disabled={invitationBusy}>Close</button></div></>}
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
    </>}
    <DialogHost ref={dialogHost} session={session} visibleOpenedDialog={visibleOpenedDialog}
      activeDocument={activeDocument} dialog={dialog} decisionError={decisionError}
      openedDialogError={openedDialogError} returnFocus={dialogReturnFocus.current}
      catalogText={catalogText} onAction={handleDialogAction} />
  </main>;
}
