import React, { type ChangeEvent, type RefObject } from "react";
import { PasswordPolicyStatus } from "./password-policy.ts";

const h = React.createElement;

interface PasswordConfirmationFieldsProps {
  kind: "owner" | "recovery";
  label: string;
  confirmationLabel: string;
  revealed: boolean;
  required: boolean;
  onToggle(): void;
  value?: string;
  confirmationValue?: string;
  onValueChange?(value: string): void;
  onConfirmationChange?(value: string): void;
  inputRef?: RefObject<HTMLInputElement | null>;
  confirmationRef?: RefObject<HTMLInputElement | null>;
  comparePassword?: string;
  compareMessage?: string;
  invalidPassword?: boolean;
  invalidConfirmation?: boolean;
  errorDescriptionId?: string;
  passwordError?: string;
}

/* Renders a password and confirmation pair with one accessible visibility control. */
export function PasswordConfirmationFields({ kind, label, confirmationLabel,
  revealed, required, onToggle, value, confirmationValue, onValueChange,
  onConfirmationChange, inputRef, confirmationRef,
  comparePassword = "", compareMessage = "", invalidPassword = false,
  invalidConfirmation = false, errorDescriptionId = "", passwordError = "" }:
  PasswordConfirmationFieldsProps): React.ReactElement {
  const passwordId = `${kind}-password`;
  const confirmationId = `${kind}-password-confirmation`;
  const fieldType = revealed ? "text" : "password";
  const statusId = `${kind}-password-policy`;
  const action = revealed ? "Hide" : "Show";
  return h("fieldset", { className: "password-confirmation" },
    h("legend", null, `${label} security`),
    h("label", { htmlFor: passwordId }, label,
      h("input", { id: passwordId, name: `${kind}Password`, type: fieldType,
        required, autoComplete: "new-password", value,
        "aria-describedby": invalidPassword && errorDescriptionId
          ? `${statusId} ${errorDescriptionId}` : statusId,
        "aria-invalid": invalidPassword ? "true" : undefined,
        ref: inputRef,
        onChange: onValueChange && ((event: ChangeEvent<HTMLInputElement>) =>
          onValueChange(event.target.value)) })),
    h("label", { htmlFor: confirmationId }, confirmationLabel,
      h("input", { id: confirmationId, name: `${kind}PasswordConfirmation`,
        type: fieldType, required, autoComplete: "new-password",
        value: confirmationValue, ref: confirmationRef,
        "aria-describedby": invalidConfirmation && errorDescriptionId
          ? `${statusId} ${errorDescriptionId}` : statusId,
        "aria-invalid": invalidConfirmation ? "true" : undefined,
        onChange: onConfirmationChange
          && ((event: ChangeEvent<HTMLInputElement>) =>
            onConfirmationChange(event.target.value)) })),
    passwordError
      ? h("p", { id: statusId, className: "password-policy", "aria-live": "polite",
        "aria-atomic": "true" }, passwordError)
      : h(PasswordPolicyStatus, { id: statusId, password: value ?? "",
        confirmation: confirmationValue, comparePassword, compareMessage }),
    h("button", { type: "button", "aria-pressed": revealed,
      "aria-controls": `${passwordId} ${confirmationId}`,
      onClick: onToggle }, `${action} ${kind} passwords`));
}
