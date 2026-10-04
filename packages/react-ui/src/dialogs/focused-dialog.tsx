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
  const firstBodyControl = useRef<HTMLElement>(null);
  const suspended = useContext(DialogSuspensionContext);
  const titleId = useId();
  const focus = useModalFocus({ scopeRef: dialog,
    initialFocusRef: initialFocus ?? firstBodyControl,
    active: !suspended,
    returnFocus, onEscape: close, shouldRestoreFocus,
    fallbackFocus: () => document.querySelector<HTMLElement>(
      '[role="menubar"] > .menu > [role="menuitem"]') });
  return <div className="dialog-backdrop" onKeyDown={focus.onKeyDown}>
    <section ref={dialog} className={`app-dialog${className ? ` ${className}` : ""}`}
      role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby={titleId}
      aria-describedby={describedBy} aria-busy={busy}>
      <div className="app-dialog-header"><h2 id={titleId}>{title}</h2>
        {close && <button type="button" className="dialog-close"
          aria-label={`Close ${title}`} onClick={close}>×</button>}
      </div>
      <div className="app-dialog-body" ref={(body) => {
        firstBodyControl.current = body?.querySelector<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]") ?? null;
      }}>{children}</div>
    </section></div>;
}
