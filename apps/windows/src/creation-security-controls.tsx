import React, { type ComponentProps } from "react";
import { PasswordPolicyStatus } from "./password-policy.ts";

const h = React.createElement;

interface PasswordConfirmationFieldsProps {
  kind: "owner" | "recovery";
  label: string;
  confirmationLabel: string;
  revealed: boolean;
  required: boolean;
  onToggle(): void;
  input: ComponentProps<"input">;
  confirmation: ComponentProps<"input">;
  comparePassword?: string;
  compareMessage?: string;
  invalidPassword?: boolean;
  invalidConfirmation?: boolean;
  errorDescriptionId?: string;
  passwordError?: string;
}

/* Renders a password and confirmation pair with one accessible visibility control. */
export function PasswordConfirmationFields({ kind, label, confirmationLabel,
  revealed, required, onToggle, input, confirmation,
  comparePassword = "", compareMessage = "", invalidPassword = false,
  invalidConfirmation = false, errorDescriptionId = "", passwordError = "" }:
  PasswordConfirmationFieldsProps): React.ReactElement {
  const passwordId = `${kind}-password`;
  const confirmationId = `${kind}-password-confirmation`;
  const statusId = `${kind}-password-policy`;
  const action = revealed ? "Hide" : "Show";
  return h("fieldset", { className: "password-confirmation" },
    h("legend", null, `${label} security`),
    h("label", { htmlFor: passwordId }, label,
      h("input", { ...input, id: passwordId, name: `${kind}Password`,
        required, autoComplete: "new-password",
        "aria-describedby": invalidPassword && errorDescriptionId
          ? `${statusId} ${errorDescriptionId}` : statusId,
        "aria-invalid": invalidPassword ? "true" : undefined,
      })),
    h("label", { htmlFor: confirmationId }, confirmationLabel,
      h("input", { ...confirmation, id: confirmationId, name: `${kind}PasswordConfirmation`,
        required, autoComplete: "new-password",
        "aria-describedby": invalidConfirmation && errorDescriptionId
          ? `${statusId} ${errorDescriptionId}` : statusId,
        "aria-invalid": invalidConfirmation ? "true" : undefined,
      })),
    passwordError
      ? h("p", { id: statusId, className: "password-policy", "aria-live": "polite",
        "aria-atomic": "true" }, passwordError)
      : h(PasswordPolicyStatus, { id: statusId, password: String(input.value ?? ""),
        confirmation: String(confirmation.value ?? ""), comparePassword, compareMessage }),
    h("button", { type: "button", "aria-pressed": revealed,
      "aria-controls": `${passwordId} ${confirmationId}`,
      onClick: onToggle }, `${action} ${kind} passwords`));
}
