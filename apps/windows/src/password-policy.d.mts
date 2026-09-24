import type React from "react";

export const PASSWORD_REQUIREMENTS: string;
export type ProposedPasswordOutcome =
  | Readonly<{ status: "empty" | "unavailable" }>
  | Readonly<{ status: "rejected"; reason: "invalid" | "minimum-length" |
      "maximum-size" | "native-policy" }>
  | Readonly<{ status: "accepted"; password: string }>;
export function assessProposedPassword(password: string): Promise<ProposedPasswordOutcome>;
export function proposedPasswordRejectionMessage(
  result: ProposedPasswordOutcome, label?: string): string;
export function PasswordPolicyStatus(props: {
  id: string;
  password: string;
  confirmation?: string;
  optionalBlankGenerates?: boolean;
  comparePassword?: string;
  compareMessage?: string;
}): React.ReactElement;
