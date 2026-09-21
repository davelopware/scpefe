import type { ReactElement } from "react";
import type { RefObject } from "react";

export function PasswordConfirmationFields(props: {
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
  autoFocus?: boolean;
}): ReactElement;
