import React from "react";

const h = React.createElement;

/* Renders a password and confirmation pair with one accessible visibility control. */
export function PasswordConfirmationFields({ kind, label, confirmationLabel,
  revealed, required, onToggle, value, confirmationValue, onValueChange,
  onConfirmationChange, inputRef, confirmationRef, autoFocus = false }) {
  const passwordId = `${kind}-password`;
  const confirmationId = `${kind}-password-confirmation`;
  const fieldType = revealed ? "text" : "password";
  const action = revealed ? "Hide" : "Show";
  return h("fieldset", { className: "password-confirmation" },
    h("legend", null, `${label} security`),
    h("label", { htmlFor: passwordId }, label,
      h("input", { id: passwordId, name: `${kind}Password`, type: fieldType,
        minLength: 12, required, autoComplete: "new-password", value,
        ref: inputRef, autoFocus,
        onChange: onValueChange && ((event) => onValueChange(event.target.value)) })),
    h("label", { htmlFor: confirmationId }, confirmationLabel,
      h("input", { id: confirmationId, name: `${kind}PasswordConfirmation`,
        type: fieldType, minLength: 12, required, autoComplete: "new-password",
        value: confirmationValue, ref: confirmationRef,
        onChange: onConfirmationChange
          && ((event) => onConfirmationChange(event.target.value)) })),
    h("button", { type: "button", "aria-pressed": revealed,
      "aria-controls": `${passwordId} ${confirmationId}`,
      onClick: onToggle }, `${action} ${kind} passwords`));
}
