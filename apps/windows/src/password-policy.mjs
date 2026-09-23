import React, { useEffect, useState } from "react";

const h = React.createElement;

export const PASSWORD_REQUIREMENTS = "Use at least 12 characters and a passphrase resistant to guessing. Canonical UUIDv4 values are allowed; obtain UUIDs from a trusted random generator.";

/* Requests the native estimator; the fallback supports isolated component harnesses. */
export async function passwordMeetsPolicy(password) {
  const assess = window.scpefe?.passwordMeetsPolicy;
  return assess ? assess(password) : password.length >= 12;
}

/* Reports the shared native password policy and confirmation result without exposing the secret. */
export function PasswordPolicyStatus({ id, password, confirmation,
  optionalBlankGenerates = false, comparePassword = "", compareMessage = "" }) {
  const [nativePass, setNativePass] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let current = true;
    if (!password || password.length < 12) {
      setNativePass(false); setChecking(false); return () => { current = false; };
    }
    setChecking(true);
    const timer = setTimeout(() => {
      void passwordMeetsPolicy(password).then((accepted) => {
        if (current) { setNativePass(accepted); setChecking(false); }
      }, () => { if (current) { setNativePass(false); setChecking(false); } });
    }, 120);
    return () => { current = false; clearTimeout(timer); };
  }, [password]);

  let message = PASSWORD_REQUIREMENTS;
  let passes = false;
  if (!password && optionalBlankGenerates) {
    message = "Leave blank and SCPEFE will generate a passphrase that meets the policy.";
    passes = true;
  } else if (password) {
    if (password.length < 12) message = "Add more characters; at least 12 are required.";
    else if (checking) message = "Checking password requirements…";
    else if (!nativePass) message = "Choose a less predictable passphrase that is harder to guess.";
    else if (comparePassword && password === comparePassword) message = compareMessage;
    else if (confirmation !== undefined && confirmation !== password) {
      message = confirmation ? "Confirmation does not match the proposed password."
        : "Confirm the proposed password.";
    } else { message = "Meets password requirements"; passes = true; }
  }
  return h("p", { id, className: passes ? "password-policy pass" : "password-policy",
    "aria-live": "polite", "aria-atomic": "true" }, message);
}
