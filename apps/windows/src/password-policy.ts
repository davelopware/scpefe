import React, { useEffect, useState } from "react";
import { validatePassword } from "./contracts.mjs";

const h = React.createElement;

export type ProposedPasswordOutcome =
  | Readonly<{ status: "empty" | "unavailable" }>
  | Readonly<{ status: "rejected"; reason: "invalid" | "minimum-length" |
      "maximum-size" | "predictable" }>
  | Readonly<{ status: "accepted"; password: string }>;

export interface PasswordPolicyHost {
  assessPasswordPolicy(password: string): Promise<unknown>;
}

interface PasswordPolicyStatusProps {
  id: string;
  password: string;
  confirmation?: string;
  optionalBlankGenerates?: boolean;
  comparePassword?: string;
  compareMessage?: string;
}

export const PASSWORD_REQUIREMENTS = "Use a sufficiently long passphrase resistant to guessing. Canonical UUIDv4 values are allowed; obtain UUIDs from a trusted random generator.";

const outcome = <T extends ProposedPasswordOutcome>(result: T): Readonly<T> =>
  Object.freeze(result);

/* Returns the canonical proposed password and the authoritative native policy outcome. */
export async function assessProposedPassword(password: string): Promise<ProposedPasswordOutcome> {
  if (typeof password !== "string") {
    return outcome({ status: "rejected", reason: "invalid" });
  }
  if (!password.trim()) return outcome({ status: "empty" });
  let canonicalPassword;
  try {
    canonicalPassword = validatePassword(password);
  } catch {
    return outcome({ status: "rejected", reason: "maximum-size" });
  }
  const assess = window.scpefe?.assessPasswordPolicy;
  if (!assess) return outcome({ status: "unavailable" });
  try {
    const nativeAssessment = await assess(canonicalPassword);
    if (nativeAssessment === "accepted") {
      return outcome({ status: "accepted", password: canonicalPassword });
    }
    if (nativeAssessment === "minimum-length" || nativeAssessment === "predictable"
        || nativeAssessment === "invalid") {
      return outcome({ status: "rejected", reason: nativeAssessment });
    }
    return outcome({ status: "unavailable" });
  } catch {
    return outcome({ status: "unavailable" });
  }
}

/* Gives a field-specific safe explanation for a rejected proposed password. */
export function proposedPasswordRejectionMessage(
  result: ProposedPasswordOutcome, label = "Password"): string {
  if (result.status === "empty") return `${label} is required.`;
  if (result.status === "unavailable") {
    return `${label} requirements could not be checked. Try again.`;
  }
  if (result.status === "rejected" && result.reason === "minimum-length") {
    return `${label} is too short. Add more characters.`;
  }
  if (result.status === "rejected" && result.reason === "maximum-size") {
    return `${label} is too long.`;
  }
  if (result.status === "rejected" && result.reason === "invalid") {
    return `${label} is invalid.`;
  }
  return `${label} is too predictable. Choose a passphrase that is harder to guess.`;
}

/* Reports the shared native password policy and workflow-specific comparison result. */
export function PasswordPolicyStatus({ id, password = "", confirmation,
  optionalBlankGenerates = false, comparePassword = "", compareMessage = "" }:
  PasswordPolicyStatusProps): React.ReactElement {
  const [assessment, setAssessment] = useState<ProposedPasswordOutcome>(
    () => outcome({ status: "empty" }));
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let current = true;
    if (!password.trim()) {
      setAssessment(outcome({ status: "empty" })); setChecking(false);
      return () => { current = false; };
    }
    setChecking(true);
    const timer = setTimeout(() => {
      if (!current) return;
      void assessProposedPassword(password).then((result) => {
        if (current) { setAssessment(result); setChecking(false); }
      });
    }, 120);
    return () => { current = false; clearTimeout(timer); };
  }, [password]);

  let message = PASSWORD_REQUIREMENTS;
  let passes = false;
  if (assessment.status === "empty" && optionalBlankGenerates) {
    message = "Leave blank and SCPEFE will generate a passphrase that meets the policy.";
    passes = true;
  } else if (password) {
    if (checking) message = "Checking password requirements…";
    else if (assessment.status !== "accepted") {
      message = proposedPasswordRejectionMessage(assessment);
    } else if (comparePassword
        && assessment.password === comparePassword.trim()) message = compareMessage;
    else if (confirmation !== undefined
        && confirmation.trim() !== assessment.password) {
      message = confirmation ? "Confirmation does not match the proposed password."
        : "Confirm the proposed password.";
    } else { message = "Meets password requirements"; passes = true; }
  }
  return h("p", { id, className: passes ? "password-policy pass" : "password-policy",
    "aria-live": "polite", "aria-atomic": "true" }, message);
}
