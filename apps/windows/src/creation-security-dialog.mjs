import React, { useEffect, useRef, useState } from "react";
import { validateCreateFormRequest } from "./contracts.mjs";
import { PasswordConfirmationFields } from "./creation-security-controls.mjs";
import { safeRendererErrorMessage } from "./error-boundary.mjs";

const h = React.createElement;
const VALIDATION_MESSAGES = new Map([
  ["owner passwords do not match", "owner passwords do not match"],
  ["recovery passwords do not match", "recovery passwords do not match"],
  ["owner password must contain at least 12 characters",
    "owner password must contain at least 12 characters"],
  ["recovery password must contain at least 12 characters",
    "recovery password must contain at least 12 characters"],
  ["recovery password must be independent from the owner password",
    "recovery password must be independent from the owner password"],
  ["irrecoverability must be acknowledged",
    "irrecoverability must be acknowledged"],
  ["recovery password storage must be acknowledged",
    "recovery password storage must be acknowledged"],
]);

/* Collects and validates creation secrets after a target has been selected. */
export function CreationSecurityDialog({ onCreate, onCancel, returnFocus }) {
  const [ownerPassword, setOwnerPassword] = useState("");
  const [ownerConfirmation, setOwnerConfirmation] = useState("");
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryConfirmation, setRecoveryConfirmation] = useState("");
  const [ownerRevealed, setOwnerRevealed] = useState(false);
  const [recoveryRevealed, setRecoveryRevealed] = useState(false);
  const [understandsIrrecoverable, setUnderstandsIrrecoverable] = useState(false);
  const [storedRecoverySeparately, setStoredRecoverySeparately] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const ownerConfirmationRef = useRef(null);
  const recoveryConfirmationRef = useRef(null);
  const recoveryRef = useRef(null);
  const ownerRef = useRef(null);
  const dialogRef = useRef(null);
  const completedRef = useRef(false);
  const hasRecovery = recoveryPassword.length > 0 || recoveryConfirmation.length > 0;

  useEffect(() => {
    const prior = returnFocus ?? document.activeElement;
    const chrome = document.querySelector(".shell-chrome");
    chrome?.setAttribute("inert", "");
    ownerRef.current?.focus();
    return () => {
      if (completedRef.current) {
        chrome?.removeAttribute("inert");
        return;
      }
      globalThis.requestAnimationFrame?.(() => {
        if (document.querySelector('[aria-modal="true"]')) return;
        chrome?.removeAttribute("inert");
        if (prior?.isConnected) prior.focus();
      });
    };
  }, []);

  async function submit(event) {
    event.preventDefault();
    setError("");
    let request;
    try {
      request = validateCreateFormRequest({ ownerPassword,
        ownerPasswordConfirmation: ownerConfirmation,
        recoveryPassword, recoveryPasswordConfirmation: recoveryConfirmation,
        content: "", understandsIrrecoverable,
        storedRecoverySeparately: hasRecovery && storedRecoverySeparately });
    } catch (submissionError) {
      const source = submissionError instanceof Error ? submissionError.message : "";
      const message = VALIDATION_MESSAGES.get(source)
        ?? "The security details are invalid. Review the form and try again.";
      setError(message);
      if (source === "owner passwords do not match") {
        ownerConfirmationRef.current?.focus();
      } else if (source === "recovery passwords do not match") {
        recoveryConfirmationRef.current?.focus();
      } else if (source === "recovery password must be independent from the owner password") {
        recoveryRef.current?.focus();
      } else {
        ownerRef.current?.focus();
      }
      return;
    }
    setSubmitting(true);
    try {
      await onCreate(request);
      completedRef.current = true;
    } catch (submissionError) {
      setError(safeRendererErrorMessage(submissionError));
      if (submissionError?.code === "RECOVERY_PASSWORD_WEAK") recoveryRef.current?.focus();
      else ownerRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  }

  function cancel() {
    if (!submitting) void onCancel();
  }

  return h("div", { className: "dialog-backdrop",
    onKeyDown: (event) => {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        cancel();
      } else if (event.key === "Tab" && dialogRef.current) {
        const controls = [...dialogRef.current.querySelectorAll(
          "button:not(:disabled), input:not(:disabled)")];
        if (!controls.length) return;
        const at = controls.indexOf(document.activeElement);
        const next = event.shiftKey
          ? (at <= 0 ? controls.length - 1 : at - 1)
          : (at >= controls.length - 1 ? 0 : at + 1);
        event.preventDefault();
        controls[next].focus();
      }
    } },
  h("section", { ref: dialogRef, className: "security-dialog", role: "dialog", "aria-modal": "true",
    "aria-labelledby": "creation-security-title",
    "aria-describedby": "creation-security-warning", "aria-busy": submitting },
  h("h2", { id: "creation-security-title" }, "Secure new document"),
  h("p", { id: "creation-security-warning", className: "warning" },
    "There is no account reset: without a valid owner or recovery password, the document is permanently irrecoverable."),
  h("form", { onSubmit: submit, noValidate: true },
    h(PasswordConfirmationFields, { kind: "owner", label: "Owner password",
      confirmationLabel: "Confirm owner password", revealed: ownerRevealed,
      required: true, value: ownerPassword, confirmationValue: ownerConfirmation,
      inputRef: ownerRef, confirmationRef: ownerConfirmationRef,
      onValueChange: setOwnerPassword, onConfirmationChange: setOwnerConfirmation,
      onToggle: () => setOwnerRevealed((visible) => !visible), autoFocus: true }),
    h(PasswordConfirmationFields, { kind: "recovery",
      label: "Independent recovery password (strongly recommended)",
      confirmationLabel: "Confirm recovery password", revealed: recoveryRevealed,
      required: false, value: recoveryPassword,
      inputRef: recoveryRef,
      confirmationValue: recoveryConfirmation,
      confirmationRef: recoveryConfirmationRef,
      comparePassword: ownerPassword,
      compareMessage: "Recovery password must differ from the owner password.",
      onValueChange: setRecoveryPassword,
      onConfirmationChange: setRecoveryConfirmation,
      onToggle: () => setRecoveryRevealed((visible) => !visible) }),
    h("small", null, "Leave both recovery fields empty to create a document without a recovery password. Store a recovery password safely offline and separately from the owner password and document."),
    h("label", { className: "check" },
      h("input", { name: "understandsIrrecoverable", type: "checkbox",
        checked: understandsIrrecoverable,
        onChange: (event) => setUnderstandsIrrecoverable(event.target.checked) }),
      "I understand that lost passwords cannot be recovered."),
    hasRecovery && h("label", { className: "check" },
      h("input", { name: "storedRecoverySeparately", type: "checkbox",
        checked: storedRecoverySeparately,
        onChange: (event) => setStoredRecoverySeparately(event.target.checked) }),
      "I will store the recovery password independently."),
    error && h("p", { className: "dialog-error", role: "alert" }, error),
    h("div", { className: "toolbar dialog-actions" },
      h("button", { type: "button", disabled: submitting, onClick: cancel }, "Cancel"),
      h("button", { type: "submit", disabled: submitting },
        submitting ? "Creating…" : "Create")))));
}

/* Starts target selection and mounts the security dialog only after selection. */
export function CreateDocumentControl({ onCreated, onError }) {
  const [creating, setCreating] = useState(false);
  const launcherRef = useRef(null);

  function restoreLauncherFocus() {
    globalThis.requestAnimationFrame?.(() => launcherRef.current?.focus());
  }

  async function chooseTarget() {
    try {
      const result = await window.scpefe.chooseCreateTarget();
      if (result) setCreating(true);
    } catch (error) {
      onError(error);
    }
  }

  async function create(request) {
    const result = await window.scpefe.createDocument(request);
    if (result) {
      setCreating(false);
      onCreated();
      restoreLauncherFocus();
    }
  }

  async function cancel() {
    try {
      await window.scpefe.cancelCreateTarget();
      setCreating(false);
      restoreLauncherFocus();
    } catch (error) {
      onError(error);
    }
  }

  return h("section", null,
    h("h2", null, "Create"),
    h("p", null,
      "Choose where to save the encrypted document, then configure its password security."),
    h("button", { ref: launcherRef, type: "button", onClick: chooseTarget },
      "Create encrypted document…"),
    creating && h(CreationSecurityDialog, { onCreate: create, onCancel: cancel }));
}
