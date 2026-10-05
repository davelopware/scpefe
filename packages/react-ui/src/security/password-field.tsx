import type { ComponentProps, ReactElement } from "react";

/** Renders a password input with an independent, accessible eye control. */
export function PasswordField({ label, visibilityName, visible, onToggle, input }:
  { label: string; visibilityName?: string; visible: boolean; onToggle(): void;
    input: ComponentProps<"input"> }): ReactElement {
  const action = visible ? "Hide" : "Show";
  const name = visibilityName ?? label.toLowerCase();
  return <div className="password-entry"><label htmlFor={input.id}>{label}</label>
    <span className="password-field">
    <input {...input} />
    <button type="button" className="password-visibility" aria-label={`${action} ${name}`}
      aria-pressed={visible} aria-controls={input.id}
      onMouseDown={(event) => event.preventDefault()} onClick={onToggle}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
        strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
        {!visible && <path d="M3 21 21 3" />}
      </svg>
    </button>
  </span></div>;
}
