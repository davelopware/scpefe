import React, { createContext, useContext, useId, useRef } from "react";
import { useModalFocus } from "../use-modal-focus.ts";

/** Suspends a mounted form's modal focus while protection takes precedence. */
export const DialogSuspensionContext = createContext(false);

export function FocusedDialog({ title, children, close, initialFocus, returnFocus,
  describedBy, busy, shouldRestoreFocus, className }: {
  title: string; children?: React.ReactNode; close?: () => void;
  initialFocus?: React.RefObject<HTMLElement | null>; returnFocus?: HTMLElement | null;
  describedBy?: string; busy?: boolean; shouldRestoreFocus?: () => boolean;
  className?: string }) {
  const dialog = useRef<HTMLElement>(null);
  const suspended = useContext(DialogSuspensionContext);
  const titleId = useId();
  const focus = useModalFocus({ scopeRef: dialog, initialFocusRef: initialFocus,
    active: !suspended,
    returnFocus, onEscape: close, shouldRestoreFocus,
    fallbackFocus: () => document.querySelector<HTMLElement>(
      '[role="menubar"] > .menu > [role="menuitem"]') });
  return <div className="dialog-backdrop" onKeyDown={focus.onKeyDown}>
    <section ref={dialog} className={`app-dialog${className ? ` ${className}` : ""}`}
      role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby={titleId}
      aria-describedby={describedBy} aria-busy={busy}>
      <div className="app-dialog-header"><h2 id={titleId}>{title}</h2></div>
      <div className="app-dialog-body">{children}</div>
    </section></div>;
}
