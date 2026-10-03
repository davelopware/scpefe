import React, { type FormEvent, useEffect, useImperativeHandle, useRef,
  useState } from "react";
import type { DocumentSession, DocumentSessionSnapshot, SnapshotSource } from "@scpefe/frontend-core";
import { useSessionSnapshot } from "../use-session-snapshot.ts";
import { FocusedDialog } from "../dialogs/focused-dialog.tsx";
import { SlotAdministration } from "./slot-administration.tsx";
import type { DocumentOpened, ManagedSlot, Opened } from "../session/types.ts";
import type { ProposedPasswordOutcome } from "./types.ts";

type FullSession = DocumentSession<DocumentOpened,
  Extract<Opened, { invitationRequired: true }>>;
type SecuritySession = SnapshotSource<DocumentSessionSnapshot<DocumentOpened>>
  & Pick<FullSession, "getSnapshot" | "claimInvitation" | "cancelInvitationClaim"
    | "changePassword" | "createInvitation" | "reconcileIdentity"
    | "updateSlotPermissions" | "removeSlot" | "requestCompaction">;

/** Synchronous clearing of controlled secret drafts at a lifecycle boundary. */
export interface SecurityDialogsHandle { reset(): void }

/** Owns password, invitation, and slot administration presentation for one session. */
export function SecurityDialogs({ session, clipboard, assessProposedPassword,
  proposedPasswordRejectionMessage, PasswordPolicyStatus, CompactionControls,
  catalogText, safeRendererErrorMessage, onMessage: setMessage, onAdopted,
  onClose, onOpenCompaction, passwordsOpen, claimVisible, activeDocument,
  returnFocus, ref }: {
  session: SecuritySession;
  clipboard: { copyInvitationPassphrase(password: string): Promise<boolean> };
  assessProposedPassword(password: string): Promise<ProposedPasswordOutcome>;
  proposedPasswordRejectionMessage(result: ProposedPasswordOutcome, label?: string): string;
  PasswordPolicyStatus: React.ComponentType<{ id: string; password: string;
    confirmation?: string; optionalBlankGenerates?: boolean;
    comparePassword?: string; compareMessage?: string }>;
  CompactionControls: React.ComponentType<{ onCompact(): Promise<void> }>;
  catalogText(code: string): string;
  safeRendererErrorMessage(error: unknown): string;
  onMessage(message: string): void;
  onAdopted(document: DocumentOpened): void;
  onClose(): void;
  onOpenCompaction(): void;
  passwordsOpen: boolean;
  claimVisible: boolean;
  activeDocument: boolean;
  returnFocus: HTMLElement | null;
  ref?: React.Ref<SecurityDialogsHandle>;
}): React.ReactElement {
  const snapshot = useSessionSnapshot(session);
  const opened = snapshot.kind === "read-only" || snapshot.kind === "edit"
    ? snapshot.document : null;
  const securityCommands = snapshot.kind === "read-only" || snapshot.kind === "edit"
    ? snapshot.commands : null;
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
  const securityPresentationEpoch = useRef(0);
  const invitationSubmission = useRef<number | null>(null);
  const invitationSubmissionSequence = useRef(0);
  function reset() {
    securityPresentationEpoch.current += 1;
    invitationSubmission.current = null;
    setPasswordError(""); setInvitationPassphrase(null); setInvitationError("");
    setInvitationBusy(false); setInvitationPasswordError(false); setClaimError("");
    setCurrentPasswordDraft(""); setNewPasswordDraft("");
    setNewPasswordConfirmationDraft(""); setTemporaryPasswordDraft("");
    setClaimPasswordDraft(""); setClaimConfirmationDraft("");
  }
  useImperativeHandle(ref, () => ({ reset }));
  useEffect(() => () => { securityPresentationEpoch.current += 1;
    invitationSubmission.current = null; }, []);
  function closePasswords() {
    if (invitationSubmission.current !== null) return;
    reset(); onClose();
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
          onAdopted(adopted.document);
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

  return <>    {passwordsOpen && activeDocument && opened && <FocusedDialog returnFocus={returnFocus}
      title="Passwords" close={closePasswords}>
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
            await clipboard.copyInvitationPassphrase(invitationPassphrase);
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
        <div className="dialog-actions"><button onClick={closePasswords}>Close</button></div></> : <>
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
        {(securityCommands?.createInvitation || snapshot.pending === "invitation-create")
          && <form onSubmit={createInvitation}><h3>Invite another person</h3>
            <label>Temporary label (required)<input name="temporaryLabel" required /></label>
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
              onOpenCompaction();
            }
          }} />
        <div className="dialog-actions"><button onClick={closePasswords}
          disabled={invitationBusy}>Close</button></div></>}
      </FocusedDialog>}
    {claimVisible && <FocusedDialog returnFocus={returnFocus}
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
  </>;
}
