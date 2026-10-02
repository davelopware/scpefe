import React, { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { DocumentSession, type WorkingCopyJournalHost } from "@scpefe/frontend-core";
import { useSessionSnapshot } from "../use-session-snapshot.ts";
import { MenuBar } from "../shell/menu-bar.tsx";
import { StatusBar } from "../shell/status-bar.tsx";
import { ShellDialogs, type ShellDialogsHandle } from "../shell/shell-dialogs.tsx";
import { FocusedDialog } from "../dialogs/focused-dialog.tsx";
import { DialogHost, type DialogHostHandle } from "../dialogs/dialog-host.tsx";
import { SecurityDialogs, type SecurityDialogsHandle } from "../security/security-dialogs.tsx";
import { CreationFlow, type CreationFlowHandle } from "../security/creation-flow.tsx";
import { EditorView, type EditorViewHandle } from "../editor/editor-view.tsx";
import { useAttentionActions } from "./use-attention-actions.ts";
import { SessionPresentation } from "./session-presentation.ts";
import type { DialogAction } from "../dialogs/dialog-host.tsx";
import { useSessionEvents } from "./use-session-events.ts";
import type { DocumentOpened, Opened, DialogName, OpenedDialogName } from "./types.ts";
import type { SessionHost, JournalTransportHost, SessionEventsHost,
  SecurityClipboardHost } from "./host-roles.ts";
import type { ShellHost } from "../shell/shell-dialogs.tsx";
import type { CreationTargetHost } from "../security/creation-flow.tsx";
import type { CreationFormRequest, ProposedPasswordOutcome } from "../security/types.ts";

function isDocumentOpened(value: Opened | null): value is DocumentOpened {
  return value !== null && value.invitationRequired !== true;
}

function openedDialogName(value: Opened | null): OpenedDialogName {
  if (value?.invitationRequired) return "claim";
  if (!isDocumentOpened(value)) return null;
  if (value.profileMismatch) return "profile-mismatch";
  return null;
}

type LockResult = { locked: true; journalSaved: boolean; warningCode: string | null };
/** Small platform capabilities required to mount the shared session view. */
export interface SharedAppProps {
  sessionHost: SessionHost;
  journalTransport: JournalTransportHost;
  events: SessionEventsHost;
  shellHost: ShellHost;
  creationTargetHost: CreationTargetHost;
  securityClipboard: SecurityClipboardHost;
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

export function SharedApp({ sessionHost, journalTransport, events,
  shellHost, creationTargetHost, securityClipboard,
  completion: rendererLifecycleCompletion,
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
      updateWorkingCopy: (update) => journalTransport.updateWorkingCopy(update),
      onJournalWarning: (listener) => {
        warningListeners.add(listener);
        return () => { warningListeners.delete(listener); };
      },
    };
    return {
      session: new DocumentSession<DocumentOpened, Extract<Opened,
        { invitationRequired: true }>>(sessionHost, journal),
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
  const targetName = sessionSnapshot.kind === "closed" ? null
    : sessionSnapshot.targetName;
  const lockedDocument = sessionSnapshot.kind === "locked";
  const working = sessionSnapshot.kind === "read-only" || sessionSnapshot.kind === "edit"
    ? sessionSnapshot.working : null;
  const dirty = working?.dirty ?? false;
  const attention = sessionSnapshot.kind === "read-only" || sessionSnapshot.kind === "edit"
    ? sessionSnapshot.attention : undefined;
  const saveFailure = attention?.kind === "save-failed"
    ? catalogText(attention.code) : null;
  const publicationDecision = attention?.kind === "publication-decision"
    ? attention : null;
  const publicationResolving = sessionSnapshot.kind === "read-only"
    || sessionSnapshot.kind === "edit" ? sessionSnapshot.publication.resolving : false;
  useEffect(() => () => {
    session.dispose();
  }, [session]);
  const [message, setMessage] = useState("");
  const [presentation] = useState(() => new SessionPresentation(session, catalogText));
  const [, refreshPresentation] = useState(0);
  const [profileReady, setProfileReady] = useState(false);
  const [editorAdoption, setEditorAdoption] = useState(0);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [creating, setCreating] = useState(false);
  const invitationStaged = sessionSnapshot.invitationStaged === true;
  const protection = sessionSnapshot.attention?.kind === "lifecycle-protection"
    ? sessionSnapshot.attention : null;
  const creationFlow = useRef<CreationFlowHandle>(null);
  const shellDialogs = useRef<ShellDialogsHandle>(null);
  const securityDialogs = useRef<SecurityDialogsHandle>(null);
  const editorView = useRef<EditorViewHandle>(null);
  const replacementFocusPending = useRef(false);
  const dialogHost = useRef<DialogHostHandle>(null);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);
  const modalBusy = useRef(false);
  const attentionActions = useAttentionActions({ session,
    completion: rendererLifecycleCompletion, catalogText, onMessage: setMessage,
    onDialog: setDialog, onExport: () => shellDialogs.current?.showExport(),
    onLocked: showLockedResult });
  const { openedDialogError, confirmDivergenceDiscard } = attentionActions;
  const presentationView = presentation.view({ formActive: creating
    || (dialog !== null && dialog !== "compaction") });
  const selected = presentationView.selectedDecision;
  const leaseDecision = selected?.kind === "lease-takeover" ? selected : null;
  const migrationDecision = selected?.kind === "migration-decision" ? selected : null;
  const recoveryDecision = selected?.kind === "recovery-decision" ? selected : null;
  const headDecision = selected?.kind === "head-mismatch" ? selected : null;
  const unreadableDecision = selected?.kind === "unreadable-journal" ? selected : null;
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
    || presentationView.blocked || leaseDecision !== null || saveFailure !== null;
  useSessionEvents({ session, events, shellHost,
    completion: rendererLifecycleCompletion,
    forwardJournalWarning: sessionStore.forwardJournalWarning,
    catalogText, safeRendererErrorMessage, modalBusy,
    returnFocus: dialogReturnFocus,
    canPresentQueued: !modalBusy.current && !creating && dialog === null
      && openedDialog === null && !publicationResolving,
    onLocked: showLockedResult,
    onRetained: (document) => showOpenedResult(document),
    onPresentExternal: () => shellDialogs.current?.showExternalOpen(),
    onMessage: setMessage,
  });

  function showOpenedResult(result: DocumentOpened, alreadyAdopted = false) {
    securityDialogs.current?.reset();
    if (!alreadyAdopted) session.adopt(result);
    const adopted = session.getSnapshot();
    if (adopted.kind === "read-only" || adopted.kind === "edit") {
      setEditorAdoption(adopted.adoption);
    }
    attentionActions.reset();
    editorView.current?.reset();
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
      securityDialogs.current?.reset();
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
      await creationFlow.current?.open();
    } else if (command === "open") {
      await shellDialogs.current?.chooseOpen();
    } else if (command === "find" || command === "replace") {
      editorView.current?.openFind(command,
        returnFocus?.isConnected ? returnFocus : document.activeElement as HTMLElement | null);
    } else if (command === "export") {
      shellDialogs.current?.showExport();
    } else if (command === "passwords" || command === "profile") {
      setDialog(command as DialogName);
    } else if (command === "save") await attentionActions.save();
    else if (command === "backup") await attentionActions.backup();
    else if (command === "edit") await attentionActions.enterEditMode();
    else if (command === "undo") attentionActions.moveHistory(-1);
    else if (command === "redo") attentionActions.moveHistory(1);
    else if (command === "lock") await attentionActions.lock();
    else if (command === "unlock") shellDialogs.current?.showUnlock();
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

  function showLockedResult(result: LockResult, closed = false) {
    document.querySelectorAll<HTMLInputElement>(
      "input[type='password'], input[readonly]").forEach((input) => { input.value = ""; });
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    flushSync(() => {
      if (closed) session.closed();
      else session.lockStarted();
      setEditorAdoption(0);
      editorView.current?.reset();
      shellDialogs.current?.reset();
      securityDialogs.current?.reset();
      creationFlow.current?.reset();
      setDialog(null);
      attentionActions.reset();
      setMessage(result.warningCode ? catalogText(result.warningCode)
        : "Document locked. Use Security → Unlock to continue.");
    });
    dialogReturnFocus.current = null;
  }

  const closeDialog = () => {
    shellDialogs.current?.reset();
    securityDialogs.current?.reset();
    setDialog(null);
  };

  async function runDialogAction(action: DialogAction) {
    if (action === "continue-read-only" || action === "retry-edit"
      || action === "restore-recovery" || action === "discard-recovery"
      || action === "accept-head" || action === "discard-unreadable"
      || action === "confirm-lease" || action === "cancel-lease"
      || action === "migrate" || action === "compact"
      || action === "compaction-canceled") {
      const actionElement = document.activeElement instanceof HTMLElement
        ? document.activeElement : null;
      await presentation.act(action);
      refreshPresentation((revision) => revision + 1);
      const result = presentation.view();
      if (action === "compact" && result.safeMessage ===
        "Verified backup created and document history compacted."
        || action === "compaction-canceled") setDialog("passwords");
      const safeMessage = result.safeMessage;
      if (safeMessage !== null) setMessage(safeMessage);
      if (result.focusIntent === "decision-action") {
        requestAnimationFrame(() => actionElement?.focus());
      } else if (result.focusIntent === "migration-retry"
        || result.focusIntent === "edit-retry"
        || result.focusIntent === "recovery-restore"
        || result.focusIntent === "publication-retry") {
        const target = result.focusIntent === "migration-retry" ? "migration"
          : result.focusIntent === "edit-retry" ? "edit"
            : result.focusIntent === "recovery-restore" ? "recovery" : "publication";
        requestAnimationFrame(() => dialogHost.current?.focus(target));
      }
      return;
    }
    await attentionActions.run(action);
  }

  useEffect(() => {
    document.title = targetName
      ? `${dirty ? "*" : ""}${targetName} — SCPEFE` : "SCPEFE";
  }, [targetName, dirty]);

  return <main className="app-shell"><div className="shell-chrome">
    <MenuBar session={session} active={activeDocument} profileReady={profileReady}
      blocked={modalBusy.current}
      run={(command, returnFocus) =>
      void rendererLifecycleCompletion.track(() => runCommand(command, returnFocus))} />
    <EditorView ref={editorView} session={session} active={activeDocument}
      locked={lockedDocument} blocked={modalBusy.current} onMessage={setMessage}
      onReturnFocus={(element) => { dialogReturnFocus.current = element; }} />
    <StatusBar session={session} active={activeDocument} message={message} /></div>
    <CreationFlow ref={creationFlow} session={session} targetHost={creationTargetHost}
      completion={rendererLifecycleCompletion} Dialog={CreationSecurityDialog}
      catalogText={catalogText} safeRendererErrorMessage={safeRendererErrorMessage}
      onAdopted={(document) => showOpenedResult(document, true)}
      onMessage={setMessage} onFocusEditor={focusEditorAfterDialog}
      onVisibilityChange={setCreating} suppressed={protection !== null}
      returnFocus={dialogReturnFocus.current} />
    <ShellDialogs ref={shellDialogs} session={session} host={shellHost}
      completion={rendererLifecycleCompletion} dialog={protection ? null : dialog}
      active={activeDocument} returnFocus={dialogReturnFocus.current}
      catalogText={catalogText} safeRendererErrorMessage={safeRendererErrorMessage}
      closeWindow={closeWindow} onDialog={setDialog} onMessage={setMessage}
      onProfileReady={setProfileReady} onAdopted={(document) => showReplacementResult(document, true)}
      onFocusEditor={focusEditorAfterDialog} onClose={closeDialog} />
    <SecurityDialogs ref={securityDialogs} session={session}
      clipboard={securityClipboard} assessProposedPassword={assessProposedPassword}
      proposedPasswordRejectionMessage={proposedPasswordRejectionMessage}
      PasswordPolicyStatus={PasswordPolicyStatus} CompactionControls={CompactionControls}
      catalogText={catalogText} safeRendererErrorMessage={safeRendererErrorMessage}
      onMessage={setMessage} onAdopted={(document) => showOpenedResult(document, true)}
      onClose={closeDialog} onOpenCompaction={() => setDialog("compaction")}
      passwordsOpen={!protection && dialog === "passwords"}
      claimVisible={!protection && visibleOpenedDialog === "claim"}
      activeDocument={activeDocument} returnFocus={dialogReturnFocus.current} />
    <DialogHost ref={dialogHost} session={session} visibleOpenedDialog={visibleOpenedDialog}
      activeDocument={activeDocument} dialog={dialog}
      openedDialogError={openedDialogError}
      confirmDivergenceDiscard={confirmDivergenceDiscard}
      selectedDecision={presentationView.selectedDecision}
      focusIntent={presentationView.focusIntent}
      returnFocus={dialogReturnFocus.current} catalogText={catalogText}
      onAction={runDialogAction} />
  </main>;
}
