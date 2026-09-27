/** Shared React presentation entry point; rendering modules are added here as migrated. */
export type { SnapshotSource } from "@scpefe/frontend-core";
export { FocusManager } from "./focus-manager.ts";
export type { FocusDomCapability, FocusKeyEvent, FocusScope,
  FocusScopeOptions } from "./focus-manager.ts";
export { browserFocusDom, browserFocusManager } from "./browser-focus-dom.ts";
export { useModalFocus } from "./use-modal-focus.ts";
export type { ModalFocusOptions } from "./use-modal-focus.ts";
export { useSessionSnapshot } from "./use-session-snapshot.ts";
