import React, { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { DocumentSession, type WorkingCopyJournalHost } from "@scpefe/frontend-core";
import { useSessionSnapshot } from "../use-session-snapshot.ts";
import { MenuBar } from "../shell/menu-bar.tsx";
import { StatusBar } from "../shell/status-bar.tsx";
import { createShellCommands, type ShellCommand } from "../shell/shell-commands.ts";
import { ShellDialogs, type ShellDialogsHandle } from "../shell/shell-dialogs.tsx";
import { DialogSuspensionContext } from "../dialogs/focused-dialog.tsx";
import { DialogHost, type DialogHostHandle } from "../dialogs/dialog-host.tsx";
import { SecurityDialogs, type SecurityDialogsHandle } from "../security/security-dialogs.tsx";
import { CreationFlow, type CreationFlowHandle } from "../security/creation-flow.tsx";
import { clearMountedPasswordFields } from "../security/password-entry.ts";
import { EditorView, type EditorViewHandle } from "../editor/editor-view.tsx";
import { SessionPresentation } from "./session-presentation.ts";
import type { DialogAction } from "../dialogs/dialog-host.tsx";
import { useSessionEvents } from "./use-session-events.ts";
import type { DocumentOpened, Opened, DialogName } from "./types.ts";
import type { SessionHost, JournalTransportHost, SessionEventsHost,
  SecurityClipboardHost } from "./host-roles.ts";
import type { ShellHost } from "../shell/shell-dialogs.tsx";
import type { CreationTargetHost } from "../security/creation-flow.tsx";
import type { CreationFormRequest, ProposedPasswordOutcome } from "../security/types.ts";

function isDocumentOpened(value: Opened | null): value is DocumentOpened {
  return value !== null && value.invitationRequired !== true;
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
  sourceCommit: string;
  assessProposedPassword(password: string): Promise<ProposedPasswordOutcome>;
  proposedPasswordRejectionMessage(result: ProposedPasswordOutcome, label?: string): string;
  CreationSecurityDialog: React.ComponentType<{ onCreate(request: CreationFormRequest): Promise<void>;
    onCancel(): void | Promise<void>; returnFocus?: HTMLElement | null }>;
  PasswordPolicyStatus: React.ComponentType<{ id: string; password: string;
    confirmation?: string; optionalBlankGenerates?: boolean;
    comparePassword?: string; compareMessage?: string }>;
}

export function SharedApp({ sessionHost, journalTransport, events,
  shellHost, creationTargetHost, securityClipboard,
  completion: rendererLifecycleCompletion,
  catalogText, safeRendererErrorMessage, closeWindow, sourceCommit, assessProposedPassword,
  proposedPasswordRejectionMessage, CreationSecurityDialog,
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
  const presentationMounted = useRef(true);
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
  const publicationResolving = sessionSnapshot.kind === "read-only"
    || sessionSnapshot.kind === "edit" ? sessionSnapshot.publication.resolving : false;
  useEffect(() => () => {
    presentationMounted.current = false;
    presentation.dispose();
    session.dispose();
  }, [session]);
  const [message, setMessage] = useState("");
  const [presentation] = useState(() => new SessionPresentation(session, catalogText));
  const [, refreshPresentation] = useState(0);
  const [profileReady, setProfileReady] = useState(false);
  const [editorAdoption, setEditorAdoption] = useState(0);
  const [dialog, setDialogState] = useState<DialogName>(null);
  function setDialog(next: DialogName) {
    setDialogState(next);
  }
  const [creating, setCreating] = useState(false);
  const creationFlow = useRef<CreationFlowHandle>(null);
  const shellDialogs = useRef<ShellDialogsHandle>(null);
  const securityDialogs = useRef<SecurityDialogsHandle>(null);
  const editorView = useRef<EditorViewHandle>(null);
  const replacementFocusPending = useRef(false);
  const dialogHost = useRef<DialogHostHandle>(null);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);
  const modalBusy = useRef(false);
  const presentationView = presentation.view({ formActive: creating
    || (dialog !== null && dialog !== "compaction") });
  const selected = presentationView.selectedDecision;
  const protection = selected?.kind === "lifecycle-protection" ? selected : null;
  const visibleOpenedDialog = dialog === null ? presentationView.openedDialog : null;
  modalBusy.current = protection !== null || creating || dialog !== null || visibleOpenedDialog !== null
    || presentationView.blocked;
  useSessionEvents({ session, presentation, events, shellHost,
    completion: rendererLifecycleCompletion,
    forwardJournalWarning: sessionStore.forwardJournalWarning,
    catalogText, safeRendererErrorMessage, modalBusy,
    returnFocus: dialogReturnFocus,
    onLocked: showLockedResult,
    onRetained: (document) => showOpenedResult(document),
    onMessage: setMessage,
  });
  useEffect(() => {
    if (!sessionSnapshot.externalOpen?.queued
      || sessionSnapshot.externalOpen.active
      || !presentation.activateQueuedExternalOpen({ formActive: creating || dialog !== null
        || visibleOpenedDialog !== null })) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body
      && active.isConnected) dialogReturnFocus.current = active;
    shellDialogs.current?.showExternalOpen();
  }, [sessionSnapshot.externalOpen?.active, sessionSnapshot.externalOpen?.queued,
    presentationView.blocked, creating, dialog, publicationResolving]);

  function showOpenedResult(result: DocumentOpened, alreadyAdopted = false) {
    setDialog(null);
    creationFlow.current?.reset();
    shellDialogs.current?.reset();
    securityDialogs.current?.reset();
    if (!alreadyAdopted) session.adopt(result);
    const adopted = session.getSnapshot();
    if (adopted.kind === "read-only" || adopted.kind === "edit") {
      setEditorAdoption(adopted.adoption);
    }
    editorView.current?.reset();
    if (result.recovery) {
      const source = [result.recovery.authorName, result.recovery.deviceName]
        .filter(Boolean).join(" on ");
      setMessage(`Recovered unsaved work${source ? ` from ${source}` : ""}. Restore or discard it before editing.`);
    } else if (result.lease?.active) {
      setMessage(`Editing lease held by ${result.lease.holderName || "another editor"} (${result.lease.holderEmail}) on ${result.lease.deviceName}.`);
    } else setMessage("");
  }

  function showReplacementResult(result: Opened, alreadyAdopted = false) {
    setDialog(null);
    creationFlow.current?.reset();
    shellDialogs.current?.reset();
    if (result.invitationRequired) {
      securityDialogs.current?.reset();
      session.adopt(result);
      const message = presentation.invitationStaged().safeMessage;
      if (message !== null) setMessage(message);
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
  const shellCommands = createShellCommands({ session,
    facts: () => ({ activeAdoption: activeDocument && (sessionSnapshot.kind === "read-only"
      || sessionSnapshot.kind === "edit") ? sessionSnapshot.adoption : null, profileReady,
      modalBusy: modalBusy.current }),
    run: runCommand,
    track: (operation) => rendererLifecycleCompletion.track(operation),
  });
  useEffect(() => {
    if (!replacementFocusPending.current || creating || dialog !== null
        || visibleOpenedDialog !== null || protection !== null || !activeDocument) return;
    replacementFocusPending.current = false;
    requestAnimationFrame(() => requestAnimationFrame(() => editorView.current?.focus()));
  }, [activeDocument, creating, dialog, protection, visibleOpenedDialog]);
  async function runCommand(command: ShellCommand, returnFocus: HTMLElement | null) {
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
    } else if (command === "passwords" || command === "profile" || command === "about") {
      setDialog(command as DialogName);
    } else if (command === "save") await runSave();
    else if (command === "backup") {
      const started = session.getSnapshot();
      const adoption = started.kind === "read-only" || started.kind === "edit"
        ? started.adoption : null;
      const outcome = await session.backup();
      const current = session.getSnapshot();
      if (!presentationMounted.current || (current.kind === "read-only"
        || current.kind === "edit" ? current.adoption : null) !== adoption) return;
      if (outcome.status === "backup") setMessage(outcome.created
        ? "Verified byte-identical backup replica created."
        : "Backup canceled; the document and destination are unchanged.");
      else if (outcome.status === "failed") setMessage(catalogText(outcome.code));
    }
    else if (command === "edit") {
      await presentation.enterEditMode();
      refreshPresentation((revision) => revision + 1);
      const safeMessage = presentation.view().safeMessage;
      if (safeMessage !== null) setMessage(safeMessage);
    }
    else if (command === "undo") session.undo();
    else if (command === "redo") session.redo();
    else if (command === "compact") {
      if (session.requestCompaction().status === "attention") setDialog("compaction");
    }
    else if (command === "lock") await lockDocument();
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

  async function lockDocument() {
    const outcome = await session.lock();
    if (!presentationMounted.current) return;
    if (outcome.status === "locked") showLockedResult({
      locked: true, journalSaved: true, warningCode: outcome.warningCode,
    });
    else if (outcome.status === "failed") setMessage(catalogText(outcome.code));
  }

  function showLockedResult(result: LockResult, closed = false) {
    clearMountedPasswordFields();
    document.querySelectorAll<HTMLInputElement>("input[readonly]")
      .forEach((input) => { input.value = ""; });
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    flushSync(() => {
      presentation.lockStarted();
      if (closed) session.closed();
      else session.lockStarted();
      setEditorAdoption(0);
      editorView.current?.reset();
      shellDialogs.current?.reset();
      securityDialogs.current?.reset();
      creationFlow.current?.reset();
      setDialog(null);
      setMessage(closed ? "" : result.warningCode ? catalogText(result.warningCode)
        : "Document locked. Use Security → Unlock to continue.");
    });
    dialogReturnFocus.current = null;
  }

  const closeDialog = () => {
    shellDialogs.current?.reset();
    securityDialogs.current?.reset();
    setDialog(null);
  };

  async function runSave() {
    await presentation.save();
    if (!presentationMounted.current) return;
    refreshPresentation((revision) => revision + 1);
    const result = presentation.view();
    if (result.safeMessage !== null) setMessage(result.safeMessage);
  }

  async function runDialogAction(action: DialogAction) {
    if (action === "lock") { await lockDocument(); return; }
    if (action === "open-passwords") { setDialog("passwords"); return; }
    const actionElement = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    const started = session.getSnapshot();
    const adoption = started.kind === "read-only" || started.kind === "edit"
      ? started.adoption : null;
    const nextDialog = action === "protection-cancel" || action === "protection-save"
      || action === "protection-discard"
      ? await rendererLifecycleCompletion.track(() => presentation.act(action))
      : await presentation.act(action);
    if (!presentationMounted.current) return;
    const current = session.getSnapshot();
    if ((current.kind === "read-only" || current.kind === "edit"
      ? current.adoption : null) !== adoption) return;
    refreshPresentation((revision) => revision + 1);
    const result = presentation.view();
    if ((action === "compact" || action === "compaction-canceled")
      && result.selectedDecision?.kind !== "compaction-decision") setDialog(null);
    if (nextDialog === "export") shellDialogs.current?.showExport();
    const safeMessage = result.safeMessage;
    if (safeMessage !== null) setMessage(safeMessage);
    else if (action === "continue-editing") setMessage("");
    const focusIfCurrent = (focus: () => void) => requestAnimationFrame(() => {
      const latest = session.getSnapshot();
      if (!presentationMounted.current || (latest.kind === "read-only"
        || latest.kind === "edit" ? latest.adoption : null) !== adoption) return;
      focus();
    });
    if (result.focusIntent === "decision-action") {
      focusIfCurrent(() => { if (actionElement?.isConnected) actionElement.focus(); });
    } else if (result.focusIntent === "migration-retry"
      || result.focusIntent === "edit-retry"
      || result.focusIntent === "recovery-restore"
      || result.focusIntent === "publication-retry"
      || result.focusIntent === "save-retry") {
      const intent = result.focusIntent;
      focusIfCurrent(() => dialogHost.current?.focus(intent));
    }
  }

  useEffect(() => {
    document.title = targetName
      ? `${dirty ? "*" : ""}${targetName} — SCPEFE` : "SCPEFE";
  }, [targetName, dirty]);

  return <main className="app-shell"><div className="shell-chrome">
    <MenuBar snapshot={sessionSnapshot} commands={shellCommands} />
    <EditorView ref={editorView} session={session} active={activeDocument}
      locked={lockedDocument} blocked={modalBusy.current} onMessage={setMessage}
      onReturnFocus={(element) => { dialogReturnFocus.current = element; }} />
    <StatusBar session={session} active={activeDocument} commands={shellCommands}
      message={presentation.statusMessage(message)} /></div>
    <div hidden={protection !== null} inert={protection !== null}>
    <DialogSuspensionContext.Provider value={protection !== null}>
    <CreationFlow ref={creationFlow} session={session} targetHost={creationTargetHost}
      completion={rendererLifecycleCompletion} Dialog={CreationSecurityDialog}
      catalogText={catalogText} safeRendererErrorMessage={safeRendererErrorMessage}
      onAdopted={(document) => showOpenedResult(document, true)}
      onMessage={setMessage} onFocusEditor={focusEditorAfterDialog}
      onVisibilityChange={setCreating}
      returnFocus={dialogReturnFocus.current} />
    <ShellDialogs ref={shellDialogs} session={session} presentation={presentation} host={shellHost}
      completion={rendererLifecycleCompletion} dialog={dialog}
      active={activeDocument} returnFocus={dialogReturnFocus.current}
      catalogText={catalogText} safeRendererErrorMessage={safeRendererErrorMessage}
      closeWindow={closeWindow} sourceCommit={sourceCommit}
      onDialog={setDialog} onMessage={setMessage}
      onProfileReady={setProfileReady} onAdopted={(document) => showReplacementResult(document, true)}
      onFocusEditor={focusEditorAfterDialog} onClose={closeDialog} />
    <SecurityDialogs ref={securityDialogs} session={session}
      clipboard={securityClipboard} assessProposedPassword={assessProposedPassword}
      proposedPasswordRejectionMessage={proposedPasswordRejectionMessage}
      PasswordPolicyStatus={PasswordPolicyStatus}
      catalogText={catalogText} safeRendererErrorMessage={safeRendererErrorMessage}
      onMessage={setMessage} onAdopted={(document) => showOpenedResult(document, true)}
      onClose={closeDialog}
      passwordsOpen={dialog === "passwords"}
      claimVisible={!protection && visibleOpenedDialog === "claim"}
      activeDocument={activeDocument} returnFocus={dialogReturnFocus.current} />
    </DialogSuspensionContext.Provider></div>
    <DialogHost ref={dialogHost} session={session} visibleOpenedDialog={visibleOpenedDialog}
      activeDocument={activeDocument} dialog={dialog}
      selectedDecision={presentationView.selectedDecision}
      focusIntent={presentationView.focusIntent}
      returnFocus={dialogReturnFocus.current}
      onAction={runDialogAction} />
  </main>;
}
