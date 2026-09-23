import type React from "react";

export const PASSWORD_REQUIREMENTS: string;
export function passwordMeetsPolicy(password: string): Promise<boolean>;
export function PasswordPolicyStatus(props: {
  id: string;
  password: string;
  confirmation?: string;
  optionalBlankGenerates?: boolean;
  comparePassword?: string;
  compareMessage?: string;
}): React.ReactElement;
