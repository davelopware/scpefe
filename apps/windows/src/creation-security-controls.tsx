import React, { type ComponentProps } from "react";
import { PasswordField } from "@scpefe/react-ui";
import { PasswordPolicyStatus } from "./password-policy.ts";

const h = React.createElement;

interface PasswordConfirmationFieldsProps {
  kind: "owner" | "recovery";
  label: string;
  confirmationLabel: string;
  revealed: boolean;
  confirmationRevealed: boolean;
  required: boolean;
  onToggle(): void;
  onToggleConfirmation(): void;
  onGenerate(): void;
  generating?: boolean;
  input: ComponentProps<"input">;
  confirmation: ComponentProps<"input">;
  comparePassword?: string;
  compareMessage?: string;
  invalidPassword?: boolean;
  invalidConfirmation?: boolean;
  errorDescriptionId?: string;
  passwordError?: string;
}

/* Renders a password and confirmation pair with independent visibility controls. */
export function PasswordConfirmationFields({ kind, label, confirmationLabel,
  revealed, confirmationRevealed, required, onToggle, onToggleConfirmation,
  onGenerate, generating = false,
  input, confirmation,
  comparePassword = "", compareMessage = "", invalidPassword = false,
  invalidConfirmation = false, errorDescriptionId = "", passwordError = "" }:
  PasswordConfirmationFieldsProps): React.ReactElement {
  const passwordId = `${kind}-password`;
  const confirmationId = `${kind}-password-confirmation`;
  const statusId = `${kind}-password-policy`;
  return h("fieldset", { className: "password-confirmation" },
    h("legend", null, `${label} security`),
    h(PasswordField, { label, visibilityName: `${kind} password`, visible: revealed,
      onToggle, input: { ...input, id: passwordId, name: `${kind}Password`,
        required, autoComplete: "new-password",
        "aria-describedby": invalidPassword && errorDescriptionId
          ? `${statusId} ${errorDescriptionId}` : statusId,
        "aria-invalid": invalidPassword ? "true" : undefined,
      } }),
    h("button", { type: "button", onClick: onGenerate, disabled: generating,
      "aria-label": `Generate ${kind} passphrase` },
    generating ? "Generating…" : "Generate passphrase"),
    h(PasswordField, { label: confirmationLabel,
      visibilityName: `${kind} password confirmation`, visible: confirmationRevealed,
      onToggle: onToggleConfirmation,
      input: { ...confirmation, id: confirmationId, name: `${kind}PasswordConfirmation`,
        required, autoComplete: "new-password",
        "aria-describedby": invalidConfirmation && errorDescriptionId
          ? `${statusId} ${errorDescriptionId}` : statusId,
        "aria-invalid": invalidConfirmation ? "true" : undefined,
      } }),
    passwordError
      ? h("p", { id: statusId, className: "password-policy", "aria-live": "polite",
        "aria-atomic": "true" }, passwordError)
      : h(PasswordPolicyStatus, { id: statusId, password: String(input.value ?? ""),
        confirmation: String(confirmation.value ?? ""), comparePassword, compareMessage }));
}
