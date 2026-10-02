import React, { useImperativeHandle, useRef } from "react";
import { useSessionSnapshot } from "../use-session-snapshot.ts";
import { FocusedDialog } from "./focused-dialog.tsx";
import type { DocumentSessionSnapshot, SnapshotSource } from "@scpefe/frontend-core";
import type { DocumentOpened, OpenedDialogName } from "../session/types.ts";
import type { SessionPresentationView } from "../session/session-presentation.ts";

/** Dialog-only view of the external session seam. */
type DialogSession = SnapshotSource<DocumentSessionSnapshot<DocumentOpened>> & {
  dismissSaveFailure(): void;
};

/** User gestures emitted by semantic attention dialogs. */
export type DialogAction = "retry-edit" | "continue-read-only"
  | "cancel-lease" | "confirm-lease"
  | "retry-save" | "lock" | "migrate" | "open-passwords" | "accept-head"
  | "discard-recovery" | "restore-recovery" | "discard-unreadable"
  | "discard-publication" | "reconnect-publication" | "compact"
  | "compaction-canceled" | "protection-cancel" | "protection-save"
  | "protection-discard" | "keep-newer-edits" | "export-newer-edits"
  | "discard-newer-edits";

/** Focus targets used after a host command leaves an attention dialog open. */
export interface DialogHostHandle {
  focus(action: "edit" | "recovery" | "publication" | "migration"): void;
}

/** Renders every portable session attention as an accessible platform dialog. */
export function DialogHost({ session, visibleOpenedDialog, activeDocument, dialog,
  openedDialogError, confirmDivergenceDiscard, returnFocus, catalogText,
  selectedDecision, focusIntent, onAction, ref }: {
  session: DialogSession;
  visibleOpenedDialog: OpenedDialogName;
  activeDocument: boolean;
  dialog: string | null;
  openedDialogError: string;
  confirmDivergenceDiscard: boolean;
  returnFocus: HTMLElement | null;
  catalogText(code: string): string;
  selectedDecision: SessionPresentationView["selectedDecision"];
  focusIntent: SessionPresentationView["focusIntent"];
  onAction(action: DialogAction): void | Promise<void>;
  ref?: React.Ref<DialogHostHandle>;
}): React.ReactElement {
  const snapshot = useSessionSnapshot(session);
  const opened = snapshot.kind === "read-only" || snapshot.kind === "edit"
    ? snapshot.document : null;
  const attention = snapshot.kind === "read-only" || snapshot.kind === "edit"
    ? snapshot.attention : undefined;
  const protection = snapshot.attention?.kind === "lifecycle-protection"
    ? snapshot.attention : null;
  const leaseDecision = selectedDecision?.kind === "lease-takeover" ? selectedDecision : null;
  const editFailure = selectedDecision?.kind === "edit-unavailable"
    ? selectedDecision.message : null;
  const saveFailure = attention?.kind === "save-failed"
    ? catalogText(attention.code) : null;
  const publicationDecision = attention?.kind === "publication-decision" ? attention : null;
  const recoveryDecision = selectedDecision?.kind === "recovery-decision"
    ? selectedDecision : null;
  const headDecision = selectedDecision?.kind === "head-mismatch" ? selectedDecision : null;
  const unreadableDecision = selectedDecision?.kind === "unreadable-journal"
    ? selectedDecision : null;
  const migrationDecision = selectedDecision?.kind === "migration-decision"
    ? selectedDecision : null;
  const compactionDecision = selectedDecision?.kind === "compaction-decision"
    ? selectedDecision : null;
  const leaseBusy = snapshot.pending === "lease-confirm" || snapshot.pending === "lease-cancel"
    || ((snapshot.kind === "read-only" || snapshot.kind === "edit")
      && snapshot.queued !== undefined);
  const editRetryAction = useRef<HTMLButtonElement>(null);
  const recoveryRestoreAction = useRef<HTMLButtonElement>(null);
  const publicationRetryAction = useRef<HTMLButtonElement>(null);
  const migrationRetryAction = useRef<HTMLButtonElement>(null);
  useImperativeHandle(ref, () => ({ focus: (action) => {
    const target = action === "edit" ? editRetryAction
      : action === "recovery" ? recoveryRestoreAction
        : action === "migration" ? migrationRetryAction : publicationRetryAction;
    target.current?.focus();
  } }), []);
  return <>
    {!protection && <>
    {confirmDivergenceDiscard && <FocusedDialog returnFocus={returnFocus}
      title="Discard newer unsaved edits?" close={() => void onAction("keep-newer-edits")}>
      <p>The working copy has edits made after the locally saved candidate. Starting divergence resolution replaces those edits with a merge draft.</p>
      <div className="dialog-actions">
        <button onClick={() => void onAction("keep-newer-edits")}>Keep newer edits</button>
        <button onClick={() => { void onAction("export-newer-edits"); }}>
          Export newer edits…</button>
        <button autoFocus onClick={() => void onAction("discard-newer-edits")}>
          Discard newer edits and resolve</button>
      </div>
    </FocusedDialog>}
    {editFailure && <FocusedDialog returnFocus={returnFocus}
      title="Editing unavailable"
      initialFocus={focusIntent === "edit-retry" ? editRetryAction : undefined}
      close={() => void onAction("continue-read-only")}>
      <div className="warning" role="alert"><p>{editFailure}</p>
        <p>The document remains read-only.</p></div>
      <div className="dialog-actions"><button onClick={() => void onAction("continue-read-only")}>
        Continue read-only</button><button ref={editRetryAction} autoFocus
        onClick={() => void onAction("retry-edit")}>Retry editing</button></div>
    </FocusedDialog>}
    {leaseDecision && <FocusedDialog returnFocus={returnFocus}
      title="Confirm editing-lease takeover">
      <div className="warning" role="alert"><p>The lease held by {leaseDecision.holderName} cannot be proved expired because the clocks disagree.</p>
        <p>Force takeover only after confirming that no other client is editing this document.</p></div>
      {leaseDecision.errorMessage && <p className="dialog-error" role="alert">
        {leaseDecision.errorMessage}</p>}
      <div className="dialog-actions"><button autoFocus disabled={leaseBusy}
        onClick={() => void onAction("cancel-lease")}>Cancel</button>
        <button disabled={leaseBusy} onClick={() => void onAction("confirm-lease")}>
        {leaseDecision.operation === "migration" ? "Force takeover and migrate" : "Force takeover"}
      </button></div>
    </FocusedDialog>}
    {saveFailure && <FocusedDialog returnFocus={returnFocus}
      title="Manual save failed" close={() => session.dismissSaveFailure()}>
      <p className="dialog-error" role="alert">{saveFailure}</p>
      <p>The working copy and recovery journal remain available. No successful publication is being reported.</p>
      <div className="dialog-actions"><button onClick={() => session.dismissSaveFailure()}>Continue editing</button>
        <button autoFocus onClick={() => void onAction("retry-save")}>Retry manual save</button></div>
    </FocusedDialog>}
    {dialog === "compaction" && activeDocument && compactionDecision && <FocusedDialog
      returnFocus={returnFocus} title="Permanently compact document history?"
      close={snapshot.pending === "compaction" ? undefined
        : () => void onAction("compaction-canceled")}>
      <div className="warning" role="alert"><p>Compaction irreversibly removes older embedded history from this container.</p>
        <p>SCPEFE creates and verifies an exact backup first. Compaction cannot delete copies held by backups, sync tools, caches, or storage providers.</p></div>
      {compactionDecision.failureMessage && <p className="dialog-error"
        role="alert">{compactionDecision.failureMessage}</p>}
      <div className="dialog-actions"><button autoFocus onClick={() =>
        void onAction("compaction-canceled")}
        disabled={snapshot.pending === "compaction"}>Cancel</button><button
        disabled={snapshot.pending === "compaction"}
        onClick={() => void onAction("compact")}>
        Create verified backup and compact</button></div>
    </FocusedDialog>}
    {visibleOpenedDialog === "migration" && activeDocument && <FocusedDialog
      returnFocus={returnFocus} title="Older container"
      initialFocus={focusIntent === "migration-retry"
        ? migrationRetryAction : undefined}>
      <div className="warning" role="alert"><p>Migrating makes this container unreadable by older SCPEFE clients. A verified exact backup is required first.</p>
        <p>If you decline, this document stays read-only and any later save will still require migration.</p></div>
      <div className="dialog-actions"><button onClick={() => void onAction("lock")}
        disabled={snapshot.pending === "migration"}>Keep read-only and close</button>
        {migrationDecision?.failureMessage && <p className="dialog-error" role="alert">
          {migrationDecision.failureMessage}</p>}
        {migrationDecision?.canceled && <p className="dialog-error" role="alert">
          Migration was canceled before publication. Retry to acquire fresh lease authorization.</p>}
        {!migrationDecision?.canMigrate && snapshot.pending === undefined
          && <p role="note">This password slot cannot migrate this document until its edit permission and recovery decisions allow it.</p>}
        <button ref={migrationRetryAction} disabled={!migrationDecision?.canMigrate}
          onClick={() => void onAction("migrate")}>
          Create verified backup and migrate…</button></div></FocusedDialog>}
    {visibleOpenedDialog === "profile-mismatch" && activeDocument && opened && !opened.invitationRequired && opened.profileMismatch && <FocusedDialog
      returnFocus={returnFocus} title="Profile mismatch">
      <div className="warning" role="alert"><p>This password slot is registered to {opened.profileMismatch.slotName} · {opened.profileMismatch.slotEmail}, while this client is configured as {opened.profileMismatch.profileName} · {opened.profileMismatch.profileEmail}.</p>
        <p>The document remains available read-only. Editing is blocked until you explicitly reconcile the slot identity.</p></div>
      <div className="dialog-actions"><button onClick={() => void onAction("lock")}>Lock now</button>
        <button onClick={() => void onAction("open-passwords")}>Open Passwords to reconcile</button></div></FocusedDialog>}
    {visibleOpenedDialog === "head" && activeDocument && headDecision && <FocusedDialog
      returnFocus={returnFocus} title={headDecision.mismatchKind === "rollback"
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
      {headDecision.failureMessage && <p className="dialog-error" role="alert">
        {headDecision.failureMessage}</p>}
      <button disabled={snapshot.kind !== "read-only"
        && snapshot.kind !== "edit" || !snapshot.commands.acceptHeadMismatch}
        onClick={() => void onAction("accept-head")}>Accept current authenticated head</button>
    </FocusedDialog>}
    {visibleOpenedDialog === "recovery" && activeDocument && recoveryDecision && <FocusedDialog
      returnFocus={returnFocus} title="Recovered work"
      initialFocus={focusIntent === "recovery-restore" ? recoveryRestoreAction : undefined}>
      <p>Recovered work from {new Date(recoveryDecision.updateTime).toLocaleString()} is available as unsaved changes.</p>
      {recoveryDecision.failureMessage && <p className="dialog-error" role="alert">
        {recoveryDecision.failureMessage}</p>}
      <div className="dialog-actions"><button disabled={snapshot.kind !== "read-only"
        && snapshot.kind !== "edit" || !snapshot.commands.recoveryDiscard}
        onClick={() => void onAction("discard-recovery")}>Discard recovered work</button>
        <button ref={recoveryRestoreAction} disabled={snapshot.kind !== "read-only"
          && snapshot.kind !== "edit" || !snapshot.commands.recoveryRestore}
          onClick={() => void onAction("restore-recovery")}>Restore unsaved work</button></div></FocusedDialog>}
    {visibleOpenedDialog === "unreadable" && activeDocument && unreadableDecision
      && <FocusedDialog returnFocus={returnFocus}
        title="Unreadable recovery journal">
        <p>The recovery journal for this document could not be read. Keep the document read-only or explicitly discard that journal before editing.</p>
        {unreadableDecision.failureMessage && <p className="dialog-error" role="alert">
          {unreadableDecision.failureMessage}</p>}
        <div className="dialog-actions"><button onClick={() => void onAction("lock")}>Keep read-only and close</button>
          <button disabled={snapshot.kind !== "read-only"
            && snapshot.kind !== "edit" || !snapshot.commands.unreadableDiscard}
            onClick={() => void onAction("discard-unreadable")}>Discard unreadable journal</button></div>
      </FocusedDialog>}
    {visibleOpenedDialog === "publication" && activeDocument && publicationDecision
      && <FocusedDialog returnFocus={returnFocus}
        initialFocus={publicationDecision.failureCode || openedDialogError
          ? publicationRetryAction : undefined}
        title={publicationDecision.state === "conflict" ? "Divergence needs resolution" : "Manual save pending publication"}>
        <p>{publicationDecision.state === "conflict" ? "The target changed. The locally saved candidate was preserved for divergence handling." : "This manual save is stored locally and has not reached its target."}</p>
        {(publicationDecision.failureCode || openedDialogError)
          && <p className="dialog-error" role="alert">
            {publicationDecision.failureCode
              ? catalogText(publicationDecision.failureCode) : openedDialogError}</p>}
        <div className="dialog-actions"><button disabled={snapshot.kind !== "read-only"
          && snapshot.kind !== "edit" || !snapshot.commands.publicationDiscard}
          onClick={() => void onAction("discard-publication")}>Discard pending save</button>
          <button ref={publicationRetryAction} disabled={snapshot.kind !== "read-only"
            && snapshot.kind !== "edit" || !snapshot.commands.publicationRetry}
            onClick={() => void onAction("reconnect-publication")}>Retry publication</button></div></FocusedDialog>}
    </>}
    {protection && <FocusedDialog returnFocus={returnFocus}
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
      {protection.failureCode && <p className="dialog-error" role="alert">
        {catalogText(protection.failureCode)}</p>}
      <div className="dialog-actions"><button ref={(node) => {
        if (node && !protection.failureCode) node.focus();
      }}
        disabled={protection.resolving} onClick={() => void onAction("protection-cancel")}>Keep current document open</button>
        <button disabled={protection.resolving} onClick={() => void onAction("protection-save")}>
          {protection.state.pendingPublication ? "Retry publication and continue"
            : "Manual save and continue"}</button>
        <button disabled={protection.resolving} onClick={() => void onAction("protection-discard")}>Discard and continue</button>
      </div>
    </FocusedDialog>}
  </>;
}
