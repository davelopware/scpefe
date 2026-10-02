import React, { useId, useRef } from "react";
import { useModalFocus } from "../use-modal-focus.ts";

export function FocusedDialog({ title, children, close, initialFocus, returnFocus }: {
  title: string; children: React.ReactNode; close?: () => void;
  initialFocus?: React.RefObject<HTMLElement | null>; returnFocus?: HTMLElement | null }) {
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  const focus = useModalFocus({ scopeRef: dialog, initialFocusRef: initialFocus,
    returnFocus, onEscape: close,
    fallbackFocus: () => document.querySelector<HTMLElement>(
      '[role="menubar"] > .menu > [role="menuitem"]') });
  return <div className="dialog-backdrop" onKeyDown={focus.onKeyDown}>
    <section ref={dialog} className="app-dialog" role="dialog" tabIndex={-1} aria-modal="true"
    aria-labelledby={titleId}><h2 id={titleId}>{title}</h2>
    {children}</section></div>;
}
