import React, { useEffect, useState } from "react";
import { validatePassword } from "./contracts.mjs";

const h = React.createElement;

export const PASSWORD_REQUIREMENTS = "Use at least 12 characters and a passphrase resistant to guessing. Canonical UUIDv4 values are allowed; obtain UUIDs from a trusted random generator.";

const outcome = (status, details = {}) => Object.freeze({ status, ...details });

/* Returns the canonical proposed password and the authoritative native policy outcome. */
export async function assessProposedPassword(password) {
  if (typeof password !== "string") {
    return outcome("rejected", { reason: "invalid" });
  }
  if (!password.trim()) return outcome("empty");
  let canonicalPassword;
  try {
    canonicalPassword = validatePassword(password);
  } catch {
    return outcome("rejected", { reason: "maximum-size" });
  }
  const assess = window.scpefe?.passwordMeetsPolicy;
  if (!assess) return outcome("unavailable");
  try {
    if (await assess(canonicalPassword)) {
      return outcome("accepted", { password: canonicalPassword });
    }
    const reason = new TextEncoder().encode(canonicalPassword).byteLength < 12
      ? "minimum-length" : "native-policy";
    return outcome("rejected", { reason });
  } catch {
    return outcome("unavailable");
  }
}

/* Gives a field-specific safe explanation for a rejected proposed password. */
export function proposedPasswordRejectionMessage(result, label = "Password") {
  if (result.status === "empty") return `${label} is required.`;
  if (result.status === "unavailable") {
    return `${label} requirements could not be checked. Try again.`;
  }
  if (result.reason === "minimum-length") {
    return `${label} must contain at least 12 UTF-8 bytes.`;
  }
  if (result.reason === "maximum-size") return `${label} is too long.`;
  if (result.reason === "invalid") return `${label} is invalid.`;
  return `${label} is too predictable. Choose a passphrase that is harder to guess.`;
}

/* Reports the shared native password policy and workflow-specific comparison result. */
export function PasswordPolicyStatus({ id, password = "", confirmation,
  optionalBlankGenerates = false, comparePassword = "", compareMessage = "" }) {
  const [assessment, setAssessment] = useState(() => outcome("empty"));
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let current = true;
    if (!password.trim()) {
      setAssessment(outcome("empty")); setChecking(false);
      return () => { current = false; };
    }
    setChecking(true);
    const timer = setTimeout(() => {
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
