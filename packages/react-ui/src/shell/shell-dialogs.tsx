import React, { type FormEvent, useEffect, useImperativeHandle, useRef,
  useState } from "react";
import type { DocumentSession, DocumentSessionSnapshot, SnapshotSource } from "@scpefe/frontend-core";
import { useSessionSnapshot } from "../use-session-snapshot.ts";
import { FocusedDialog } from "../dialogs/focused-dialog.tsx";
import { usePasswordEntry } from "../security/password-entry.ts";
import { PasswordField } from "../security/password-field.tsx";
import type { ClientSettings, DialogName, DocumentOpened, Opened,
  Profile, JournalSummary } from "../session/types.ts";
import type { SessionPresentation } from "../session/session-presentation.ts";

type FullSession = DocumentSession<DocumentOpened,
  Extract<Opened, { invitationRequired: true }>>;
type ShellSession = SnapshotSource<DocumentSessionSnapshot<DocumentOpened>>
  & Pick<FullSession, "getSnapshot" | "refreshDocumentForAdoption"
    | "openSelected" | "unlock" | "cancelExternalOpen" | "openExternal"
    | "observeRecoveryDiscovery" | "exportPlaintext">;

/** Profile, open, and plaintext-export host capabilities used by shell forms. */
export interface ShellHost {
  getProfile(): Promise<Profile | null>;
  saveProfile(profile: Profile): Promise<Profile>;
  reconcileProfile(): Promise<DocumentOpened | null>;
  getClientSettings(): Promise<ClientSettings>;
  saveClientSettings(settings: ClientSettings): Promise<ClientSettings>;
  chooseOpenTarget(): Promise<{ selected: true; name: string } | null>;
  cancelOpenTarget(): Promise<void>;
  getUnresolvedJournalSummary(): Promise<JournalSummary>;
}

/** Commands from the menu and lifecycle bridge into shell-owned forms. */
export interface ShellDialogsHandle {
  chooseOpen(): Promise<void>;
  showUnlock(): void;
  showExternalOpen(): void;
  showExport(): void;
  reset(): void;
}

/** Owns local profile, target-password, and plaintext-export form state. */
export function ShellDialogs({ session, presentation, host, completion, dialog, active,
  returnFocus, catalogText, safeRendererErrorMessage, closeWindow, sourceCommit,
  onDialog, onMessage: setMessage, onProfileReady, onAdopted, onFocusEditor,
  onClose, ref }: {
  session: ShellSession;
  presentation: Pick<SessionPresentation, "view" | "documentOpened"
    | "externalOpenCanceled" | "invitationStaged">;
  host: ShellHost;
  completion: { track<T>(operation: () => T | Promise<T>): Promise<T> };
  dialog: DialogName;
  active: boolean;
  returnFocus: HTMLElement | null;
  catalogText(code: string): string;
  safeRendererErrorMessage(error: unknown): string;
  closeWindow(): void;
  sourceCommit: string;
  onDialog(dialog: DialogName): void;
  onMessage(message: string): void;
  onProfileReady(ready: boolean): void;
  onAdopted(document: DocumentOpened): void;
  onFocusEditor(): void;
  onClose(): void;
  ref?: React.Ref<ShellDialogsHandle>;
}): React.ReactElement {
  const snapshot = useSessionSnapshot(session);
  const externalOpen = snapshot.externalOpen;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [clientSettings, setClientSettings] = useState<ClientSettings>({
    regularSaveEnabled: false, regularSaveIntervalMs: 120_000,
  });
  const [pendingProfile, setPendingProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState("");
  const [openError, setOpenError] = useState("");
  const [pendingOpenName, setPendingOpenName] = useState("");
  const [lineEndings, setLineEndings] = useState<"lf" | "native">("lf");
  const [exportError, setExportError] = useState("");
  const profileConfirmation = useRef<HTMLButtonElement>(null);
  const openPassword = useRef<HTMLInputElement>(null);
  const passwords = usePasswordEntry(["open"] as const);
  const exportAction = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    void completion.track(() => host.getProfile().then((value) => {
      setProfile(value); onProfileReady(value !== null);
      if (!value) onDialog("profile");
    }).catch((error: unknown) => setMessage(safeRendererErrorMessage(error))));
    void completion.track(() => host.getClientSettings().then(setClientSettings)
      .catch((error: unknown) => setMessage(safeRendererErrorMessage(error))));
  }, []);
  function reset() {
    passwords.reset();
    setPendingProfile(null); setProfileError(""); setOpenError("");
    setPendingOpenName(""); setExportError("");
  }
  function closeShellDialog() { reset(); onClose(); }
  async function chooseOpen() {
    try {
      const selected = await host.chooseOpenTarget();
      if (selected) {
        setPendingOpenName(selected.name); setOpenError(""); onDialog("open");
      }
    } catch (error) { setMessage(safeRendererErrorMessage(error)); }
  }
  function showUnlock() { setOpenError(""); onDialog("unlock"); }
  function showExternalOpen() {
    passwords.reset();
    setOpenError("");
    setPendingOpenName("");
    onDialog("open");
    const message = presentation.view().safeMessage;
    if (message !== null) setMessage(message);
  }
  function showExport() { setExportError(""); onDialog("export"); }
  useImperativeHandle(ref, () => ({ chooseOpen, showUnlock, showExternalOpen,
    showExport, reset }));
  function currentAdoption(): number | null {
    const current = session.getSnapshot();
    return current.kind === "read-only" || current.kind === "edit"
      ? current.adoption : null;
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
      onProfileReady(true);
      setPendingProfile(null);
      setProfileError("");
      if (authoritative && adoption !== null) {
        session.refreshDocumentForAdoption(authoritative, adoption);
      }
      onDialog(null);
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
    } catch (error) { setMessage(safeRendererErrorMessage(error)); }
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
        const message = presentation.invitationStaged().safeMessage;
        if (message !== null) setMessage(message);
      } else if (outcome.status === "opened") {
        const adopted = session.getSnapshot();
        if (adopted.kind !== "read-only" && adopted.kind !== "edit") return;
        onAdopted(adopted.document);
      } else return;
      passwords.reset(); setPendingOpenName(""); onDialog(null);
      if (outcome.status === "opened"
        && presentation.documentOpened().focusIntent === "return") onFocusEditor();
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
      const message = presentation.externalOpenCanceled().safeMessage;
      if (message !== null) setMessage(message);
    } else if (dialog === "open") {
      try { await host.cancelOpenTarget(); }
      catch (error) {
        setOpenError(safeRendererErrorMessage(error));
        requestAnimationFrame(() => openPassword.current?.focus());
        return;
      }
    }
    setPendingOpenName(""); setOpenError(""); closeShellDialog();
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
      onAdopted(adopted.document);
      passwords.reset();
      onDialog(null);
      if (presentation.documentOpened().focusIntent === "return") onFocusEditor();
    } else if (outcome.status === "invitation") {
      passwords.reset();
      onDialog(null);
      const message = presentation.invitationStaged().safeMessage;
      if (message !== null) setMessage(message);
    } else if (outcome.status === "external-canceled") {
      passwords.reset();
      onDialog(null);
      const message = presentation.externalOpenCanceled().safeMessage;
      if (message !== null) setMessage(message);
    }
    session.observeRecoveryDiscovery(await host.getUnresolvedJournalSummary());
  }

  async function exportPlaintext() {
    setExportError("");
    const outcome = await session.exportPlaintext(lineEndings);
    if (outcome.status === "export") {
      setMessage(outcome.exported ? "Unprotected plaintext exported."
        : "Plaintext export canceled; the document and destination are unchanged.");
      onDialog(null);
    } else if (outcome.status === "failed") {
      const value = catalogText(outcome.code);
      setExportError(value);
      setMessage(`Plaintext export failed; the document and destination are unchanged: ${value}`);
      requestAnimationFrame(() => exportAction.current?.focus());
    }
  }

  return <>
    {dialog === "about" && <FocusedDialog returnFocus={returnFocus}
      title="About SCPEFE" close={closeShellDialog}>
      <p>SCPEFE</p>
      <p>Source: <a href="https://github.com/davelopware/scpefe" target="_blank"
        rel="noopener noreferrer">github.com/davelopware/scpefe</a></p>
      <p>Source commit: <code>{sourceCommit}</code></p>
      <div className="dialog-actions"><button type="button" onClick={closeShellDialog}>
        Close</button></div>
    </FocusedDialog>}
    {dialog === "profile" && <FocusedDialog returnFocus={returnFocus}
      title={profile ? "Profile" : "Set up this client"}
      close={profile ? closeShellDialog : undefined}><p>Name, email, and device name identify this client locally. This profile is self-asserted and is not an authenticated account.</p>
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
            {profile && <button type="button" onClick={closeShellDialog}>Cancel</button>}
            <button>Save local profile</button></div></form>}
      {profile && <form onSubmit={saveClientSettings}><fieldset><legend>Regular saves</legend>
        <label className="check"><input name="regularSaveEnabled" type="checkbox"
          defaultChecked={clientSettings.regularSaveEnabled} /> Enable regular provisional saves</label>
        <label>Interval (seconds)<input name="regularSaveIntervalSeconds" type="number" min="10"
          max="86400" defaultValue={clientSettings.regularSaveIntervalMs / 1000} required /></label>
        <small>Regular saves update the target but remain unsaved until you manually save.</small></fieldset>
        <div className="dialog-actions"><button type="button" onClick={closeShellDialog}>Close</button>
          <button>Save client settings</button></div></form>}</FocusedDialog>}
    {(dialog === "open" || dialog === "unlock") && <FocusedDialog
      returnFocus={returnFocus}
      title={dialog === "unlock" ? "Unlock document"
        : externalOpen?.active ? "Open requested document" : "Open document"}
      close={() => { void completion.track(cancelOpen); }}
      initialFocus={openPassword}>
      {pendingOpenName && <p>Selected target: <strong>{pendingOpenName}</strong></p>}
      <form onSubmit={(event) => { void completion.track(() =>
        (externalOpen?.active ? openExternal : open)(event)); }}><PasswordField label="Password"
        visible={passwords.visible("open")} onToggle={() => passwords.toggle("open")}
        input={{ ...passwords.field("open", openPassword), id: "open-password",
          name: "password", required: true,
          "aria-describedby": openError ? "open-password-error" : undefined }} />
        {openError && <p id="open-password-error" className="dialog-error" role="alert">
          {openError}</p>}
        <div className="dialog-actions"><button type="button" onClick={() => {
          void completion.track(cancelOpen);
        }}>Cancel</button><button>{dialog === "unlock" ? "Unlock" : "Open"}</button>
        </div></form></FocusedDialog>}
    {dialog === "export" && active && <FocusedDialog returnFocus={returnFocus}
      title="Export plaintext" close={closeShellDialog}>
      <p className="warning"><strong>Not password protected:</strong> the exported text may persist in backups or storage history.</p>
      <label>Line endings<select value={lineEndings}
        onChange={(event) => setLineEndings(event.target.value as "lf" | "native")}>
        <option value="lf">Canonical LF</option><option value="native">Platform native</option></select></label>
      {exportError && <p className="dialog-error" role="alert">{exportError}</p>}
      <div className="dialog-actions"><button onClick={closeShellDialog}>Cancel</button>
        <button ref={exportAction} onClick={() => void exportPlaintext()}>
          Export current text…</button></div></FocusedDialog>}
  </>;
}
