/** Shared React presentation entry point. */
export type { SnapshotSource } from "@scpefe/frontend-core";
export { FocusManager } from "./focus-manager.ts";
export type { FocusDomCapability, FocusKeyEvent, FocusScope,
  FocusScopeOptions } from "./focus-manager.ts";
export { browserFocusDom, browserFocusManager } from "./browser-focus-dom.ts";
export { useModalFocus } from "./use-modal-focus.ts";
export { DialogSuspensionContext } from "./dialogs/focused-dialog.tsx";
export type { ModalFocusOptions } from "./use-modal-focus.ts";
export { useSessionSnapshot } from "./use-session-snapshot.ts";
export { SharedApp } from "./session/session-app.tsx";
export { usePasswordEntry, clearMountedPasswordFields } from "./security/password-entry.ts";
export type { SharedAppProps } from "./session/session-app.tsx";
export type { SessionHost, JournalTransportHost, SessionEventsHost,
  SecurityClipboardHost } from "./session/host-roles.ts";
export type { ShellHost } from "./shell/shell-dialogs.tsx";
export type { CreationTargetHost } from "./security/creation-flow.tsx";
