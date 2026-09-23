import React, { useEffect, useRef, useState } from "react";
import { validateCreateFormRequest } from "./contracts.mjs";
import { PasswordConfirmationFields } from "./creation-security-controls.mjs";
import { safeRendererErrorMessage } from "./error-boundary.mjs";

const h = React.createElement;
const ERROR_ID = "creation-security-error";
const ATTRIBUTED_BOUNDARY_FIELDS = Object.freeze({
  OWNER_PASSWORD_WEAK: "owner",
  RECOVERY_PASSWORD_WEAK: "recovery",
});
const SAFE_BOUNDARY_DIAGNOSTICS = new Set([
  "OWNER_PASSWORD_WEAK", "RECOVERY_PASSWORD_WEAK", "CREATE_FAILED",
]);
const VALIDATION_DETAILS = new Map([
  ["owner password must be text", ["Owner password is invalid.", "owner", "OWNER_TYPE"]],
  ["owner password is required", ["Owner password is required.", "owner", "OWNER_REQUIRED"]],
  ["owner password is too long", ["Owner password is too long.", "owner", "OWNER_LENGTH"]],
  ["owner password must contain at least 12 characters",
    ["Owner password must contain at least 12 characters.", "owner", "OWNER_LENGTH"]],
  ["owner password confirmation must be text",
    ["Owner password confirmation is invalid.", "ownerConfirmation", "OWNER_CONFIRM_TYPE"]],
  ["owner password confirmation is required",
    ["Owner password confirmation is required.", "ownerConfirmation",
      "OWNER_CONFIRM_REQUIRED"]],
  ["owner password confirmation is too long",
    ["Owner password confirmation is too long.", "ownerConfirmation",
      "OWNER_CONFIRM_LENGTH"]],
  ["owner passwords do not match",
    ["owner passwords do not match.", "ownerConfirmation", "OWNER_CONFIRM_MISMATCH"]],
  ["recovery password must be text",
    ["Recovery password is invalid.", "recovery", "RECOVERY_TYPE"]],
  ["recovery password is required",
    ["Recovery password is required.", "recovery", "RECOVERY_REQUIRED"]],
  ["recovery password is too long",
    ["Recovery password is too long.", "recovery", "RECOVERY_LENGTH"]],
  ["recovery password must contain at least 12 characters",
    ["Recovery password must contain at least 12 characters.", "recovery",
      "RECOVERY_LENGTH"]],
  ["recovery password confirmation must be text",
    ["Recovery password confirmation is invalid.", "recoveryConfirmation",
      "RECOVERY_CONFIRM_TYPE"]],
  ["recovery password confirmation is required",
    ["Recovery password confirmation is required.", "recoveryConfirmation",
      "RECOVERY_CONFIRM_REQUIRED"]],
  ["recovery password confirmation is too long",
    ["Recovery password confirmation is too long.", "recoveryConfirmation",
      "RECOVERY_CONFIRM_LENGTH"]],
  ["recovery passwords do not match",
    ["recovery passwords do not match.", "recoveryConfirmation",
      "RECOVERY_CONFIRM_MISMATCH"]],
  ["recovery password must be independent from the owner password",
    ["Recovery password must be independent from the owner password.", "recovery",
      "RECOVERY_NOT_INDEPENDENT"]],
  ["irrecoverability must be acknowledged",
    ["Confirm that lost passwords cannot be recovered.", "irrecoverability",
      "IRRECOVERABILITY_ACK"]],
  ["recovery password storage must be acknowledged",
    ["Confirm that the recovery password will be stored independently.",
      "recoveryStorage", "RECOVERY_STORAGE_ACK"]],
]);

function reportCreationDiagnostic(layer, rule) {
  globalThis.console?.warn?.("SCPEFE creation rejection", Object.freeze({ layer, rule }));
}

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
  const [errorDiagnostic, setErrorDiagnostic] = useState(null);
  const [invalidField, setInvalidField] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const ownerConfirmationRef = useRef(null);
  const recoveryConfirmationRef = useRef(null);
  const recoveryRef = useRef(null);
  const ownerRef = useRef(null);
  const irrecoverabilityRef = useRef(null);
  const recoveryStorageRef = useRef(null);
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

  function updateField(field, setter, value) {
    setter(value);
    if (invalidField === field) {
      setInvalidField("");
      setError("");
      setErrorDiagnostic(null);
    }
  }

  async function submit(event) {
    event.preventDefault();
    setError("");
    setErrorDiagnostic(null);
    setInvalidField("");
    let request;
    try {
      request = validateCreateFormRequest({ ownerPassword,
        ownerPasswordConfirmation: ownerConfirmation,
        recoveryPassword, recoveryPasswordConfirmation: recoveryConfirmation,
        content: "", understandsIrrecoverable,
        storedRecoverySeparately: hasRecovery && storedRecoverySeparately });
    } catch (submissionError) {
      const source = submissionError instanceof Error ? submissionError.message : "";
      const details = VALIDATION_DETAILS.get(source);
      const [message, field, rule] = details
        ?? ["The security details are invalid. Review the form and try again.",
          "", "FORM_UNATTRIBUTED"];
      setError(message);
      setInvalidField(field);
      setErrorDiagnostic({ layer: "renderer-form", rule });
      reportCreationDiagnostic("renderer-form", rule);
      const fieldRef = { owner: ownerRef, ownerConfirmation: ownerConfirmationRef,
        recovery: recoveryRef, recoveryConfirmation: recoveryConfirmationRef,
        irrecoverability: irrecoverabilityRef,
        recoveryStorage: recoveryStorageRef }[field];
      fieldRef?.current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      await onCreate(request);
      completedRef.current = true;
    } catch (submissionError) {
      setError(safeRendererErrorMessage(submissionError));
      const safeCode = SAFE_BOUNDARY_DIAGNOSTICS.has(submissionError?.code)
        ? submissionError.code : "OPERATION_UNATTRIBUTED";
      const field = ATTRIBUTED_BOUNDARY_FIELDS[safeCode] ?? "";
      setInvalidField(field);
      setErrorDiagnostic({ layer: "creation-boundary", rule: safeCode });
      reportCreationDiagnostic("creation-boundary", safeCode);
      if (field) (field === "recovery" ? recoveryRef : ownerRef).current?.focus();
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
      invalidPassword: invalidField === "owner",
      invalidConfirmation: invalidField === "ownerConfirmation",
      errorDescriptionId: ERROR_ID,
      onValueChange: (value) => updateField("owner", setOwnerPassword, value),
      onConfirmationChange: (value) => updateField(
        "ownerConfirmation", setOwnerConfirmation, value),
      onToggle: () => setOwnerRevealed((visible) => !visible), autoFocus: true }),
    h(PasswordConfirmationFields, { kind: "recovery",
      label: "Independent recovery password (strongly recommended)",
      confirmationLabel: "Confirm recovery password", revealed: recoveryRevealed,
      required: false, value: recoveryPassword,
      inputRef: recoveryRef,
      confirmationValue: recoveryConfirmation,
      confirmationRef: recoveryConfirmationRef,
      invalidPassword: invalidField === "recovery",
      invalidConfirmation: invalidField === "recoveryConfirmation",
      errorDescriptionId: ERROR_ID,
      comparePassword: ownerPassword,
      compareMessage: "Recovery password must differ from the owner password.",
      onValueChange: (value) => updateField("recovery", setRecoveryPassword, value),
      onConfirmationChange: (value) => updateField(
        "recoveryConfirmation", setRecoveryConfirmation, value),
      onToggle: () => setRecoveryRevealed((visible) => !visible) }),
    h("small", null, "Leave both recovery fields empty to create a document without a recovery password. Store a recovery password safely offline and separately from the owner password and document."),
    h("label", { className: "check" },
      h("input", { name: "understandsIrrecoverable", type: "checkbox",
        ref: irrecoverabilityRef,
        "aria-invalid": invalidField === "irrecoverability" ? "true" : undefined,
        "aria-describedby": invalidField === "irrecoverability" ? ERROR_ID : undefined,
        checked: understandsIrrecoverable,
        onChange: (event) => updateField("irrecoverability",
          setUnderstandsIrrecoverable, event.target.checked) }),
      "I understand that lost passwords cannot be recovered."),
    hasRecovery && h("label", { className: "check" },
      h("input", { name: "storedRecoverySeparately", type: "checkbox",
        ref: recoveryStorageRef,
        "aria-invalid": invalidField === "recoveryStorage" ? "true" : undefined,
        "aria-describedby": invalidField === "recoveryStorage" ? ERROR_ID : undefined,
        checked: storedRecoverySeparately,
        onChange: (event) => updateField("recoveryStorage",
          setStoredRecoverySeparately, event.target.checked) }),
      "I will store the recovery password independently."),
    error && h("p", { id: ERROR_ID, className: "dialog-error", role: "alert",
      "data-error-layer": errorDiagnostic?.layer,
      "data-error-rule": errorDiagnostic?.rule }, error),
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
