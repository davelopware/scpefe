import type { ReactElement } from "react";

export function PasswordConfirmationFields(props: {
  kind: "owner" | "recovery";
  label: string;
  confirmationLabel: string;
  revealed: boolean;
  required: boolean;
  onToggle(): void;
}): ReactElement;
