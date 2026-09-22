import { contextBridge, ipcRenderer as rawIpcRenderer } from "electron";
import { validateCreateFormRequest, validateCreationResult,
  validateCreationTargetResult, validatePassword,
  validateOpenTargetResult,
  validateProfile, validateOpenedDocument, validateEditMode, validateSaveResult,
  validatePlaintextExportRequest, validatePlaintextExportResult, validateBackupResult,
  validateCompactionResult,
  validateMigrationResult,
  validateLeaseDecisionResult, validateTakeoverRequest, validateTakeoverCancellation,
  validateCompactionRequest,
  canonicalizeDocumentText, validateWorkingCopy, validateLockResult,
  validateClientSettings,
  validatePublicationResult, validateRecoveredWork, validateMergeDraft,
  validateUnresolvedJournalSummary, validateExternalOpenRequest,
  validatePasswordChangeRequest, validateInvitationCreateRequest,
  validateInvitationResult, validateInvitationClaimRequest,
  validateSlotPermissionsRequest,
  validateSlotId, validateRegularSaveResult, validateSlotRemovalResult } from "./contracts.mjs";
import { decodeBoundaryError, isCatalogCode } from "./error-boundary.mjs";

const ipcRenderer = Object.freeze({
  async invoke(channel, ...args) {
    try { return await rawIpcRenderer.invoke(channel, ...args); }
    catch (error) { throw decodeBoundaryError(error, channel); }
  },
  on: rawIpcRenderer.on.bind(rawIpcRenderer),
  removeListener: rawIpcRenderer.removeListener.bind(rawIpcRenderer),
});

contextBridge.exposeInMainWorld("scpefe", Object.freeze({
  getProfile: async () => {
    const value = await ipcRenderer.invoke("profile:get");
    return value === null ? null : validateProfile(value);
  },
  saveProfile: async (profile) => validateProfile(
    await ipcRenderer.invoke("profile:save", validateProfile(profile))),
  reconcileProfile: async () => {
    const value = await ipcRenderer.invoke("profile:reconcile-active");
    return value === null ? null : validateOpenedDocument(value);
  },
  getClientSettings: async () => validateClientSettings(
    await ipcRenderer.invoke("settings:get")),
  saveClientSettings: async (settings) => validateClientSettings(
    await ipcRenderer.invoke("settings:save", validateClientSettings(settings))),
  getUnresolvedJournalSummary: async () => validateUnresolvedJournalSummary(
    await ipcRenderer.invoke("journal:summary")),
  chooseCreateTarget: async () => {
    const value = await ipcRenderer.invoke("document:choose-create-target");
    return value === null ? null : validateCreationTargetResult(value);
  },
  cancelCreateTarget: async () => {
    await ipcRenderer.invoke("document:cancel-create-target");
  },
  createDocument: async (request) => {
    const value = await ipcRenderer.invoke(
      "document:create", validateCreateFormRequest(request));
    return value === null ? null : validateCreationResult(value);
  },
  chooseOpenTarget: async () => {
    const value = await ipcRenderer.invoke("document:choose-open-target");
    return value === null ? null : validateOpenTargetResult(value);
  },
  cancelOpenTarget: async () => {
    await ipcRenderer.invoke("document:cancel-open-target");
  },
  openSelectedDocument: async (password) => validateOpenedDocument(
    await ipcRenderer.invoke("document:open-selected", validatePassword(password))),
  unlockDocument: async (password) => validateOpenedDocument(
    await ipcRenderer.invoke("document:unlock", validatePassword(password))),
  openExternalDocument: async (request) => {
    const value = await ipcRenderer.invoke("document:open-external", {
      token: validateExternalOpenRequest(request).token,
      password: validatePassword(request?.password),
    });
    return value === null ? null : validateOpenedDocument(value);
  },
  cancelExternalOpen: async (request) => {
    const validated = validateExternalOpenRequest(request);
    const value = await ipcRenderer.invoke("document:cancel-external-open",
      { token: validated.token });
    if (value !== true) throw new TypeError("host did not cancel the external open request");
    return true;
  },
  enterEditMode: async (request = {}) => {
    const value = await ipcRenderer.invoke("document:enter-edit-mode",
      validateTakeoverRequest(request));
    return value?.decisionRequired === "lease-takeover"
      ? validateLeaseDecisionResult(value) : validateEditMode(value);
  },
  saveDocument: async (content) => validateSaveResult(
    await ipcRenderer.invoke("document:save", canonicalizeDocumentText(content))),
  reconnectPendingPublication: async () => validatePublicationResult(
    await ipcRenderer.invoke("document:reconnect-publication")),
  beginDivergenceResolution: async (request = {}) => {
    const value = await ipcRenderer.invoke("document:begin-divergence-resolution",
      validateTakeoverRequest(request));
    return value?.decisionRequired === "lease-takeover"
      ? validateLeaseDecisionResult(value) : validateMergeDraft(value);
  },
  saveDivergenceResolution: async (content) => validateSaveResult(
    await ipcRenderer.invoke("document:save-divergence-resolution",
      canonicalizeDocumentText(content))),
  discardPendingPublication: async () => validateOpenedDocument(
    await ipcRenderer.invoke("document:discard-publication")),
  backupDocument: async () => {
    const value = await ipcRenderer.invoke("document:backup");
    return value === null ? null : validateBackupResult(value);
  },
  compactDocument: async (request) => {
    const value = await ipcRenderer.invoke("document:compact",
      validateCompactionRequest(request));
    return value === null ? null : validateCompactionResult(value);
  },
  migrateDocument: async (request = {}) => {
    const value = await ipcRenderer.invoke("document:migrate",
      validateTakeoverRequest(request));
    return value === null ? null : value?.decisionRequired === "lease-takeover"
      ? validateLeaseDecisionResult(value) : validateMigrationResult(value);
  },
  changePassword: async (request) => validateOpenedDocument(
    await ipcRenderer.invoke("document:change-password",
      validatePasswordChangeRequest(request))),
  createInvitation: async (request) => validateInvitationResult(
    await ipcRenderer.invoke("document:create-invitation",
      validateInvitationCreateRequest(request))),
  copyInvitationPassphrase: async (password) => {
    const value = await ipcRenderer.invoke("document:copy-invitation-passphrase",
      validatePassword(password));
    if (value !== true) throw new TypeError("host did not copy the invitation passphrase");
    return true;
  },
  claimInvitation: async (request) => {
    const validated = validateInvitationClaimRequest(request);
    return validateOpenedDocument(await ipcRenderer.invoke(
      "document:claim-invitation", validated.newPassword));
  },
  cancelInvitationClaim: async () => {
    const value = await ipcRenderer.invoke("document:cancel-invitation-claim");
    if (typeof value !== "boolean") throw new TypeError("host returned invalid claim cancellation");
    return value;
  },
  reconcileIdentity: async () => validateOpenedDocument(
    await ipcRenderer.invoke("document:reconcile-identity")),
  updateSlotPermissions: async (request) => validateOpenedDocument(
    await ipcRenderer.invoke("document:update-slot-permissions",
      validateSlotPermissionsRequest(request))),
  removeSlot: async (slotId) => validateSlotRemovalResult(
    await ipcRenderer.invoke("document:remove-slot", validateSlotId(slotId))),
  exportPlaintext: async (request) => {
    const value = await ipcRenderer.invoke(
      "document:export-plaintext", validatePlaintextExportRequest(request));
    return value === null ? null : validatePlaintextExportResult(value);
  },
  updateWorkingCopy: async (working) => {
    await ipcRenderer.invoke("document:update-working-copy", validateWorkingCopy(working));
  },
  activity: async () => {
    await ipcRenderer.invoke("document:activity");
  },
  restoreRecoveredWork: async (request = {}) => {
    const value = await ipcRenderer.invoke("document:restore-recovery",
      validateTakeoverRequest(request));
    return value?.decisionRequired === "lease-takeover"
      ? validateLeaseDecisionResult(value) : validateRecoveredWork(value);
  },
  cancelLeaseTakeover: async (authorization) => {
    const value = await ipcRenderer.invoke("document:cancel-lease-takeover",
      validateTakeoverCancellation(authorization));
    if (typeof value !== "boolean") {
      throw new TypeError("host returned invalid lease takeover cancellation");
    }
    return value;
  },
  discardRecoveredWork: async () => validateOpenedDocument(
    await ipcRenderer.invoke("document:discard-recovery")),
  acceptHeadMismatch: async () => validateOpenedDocument(
    await ipcRenderer.invoke("document:accept-head-mismatch")),
  closeDocument: async () => {
    const value = await ipcRenderer.invoke("document:close");
    if (typeof value !== "boolean") throw new TypeError("host returned invalid close result");
    return value;
  },
  exitApplication: async () => {
    const value = await ipcRenderer.invoke("application:exit");
    if (typeof value !== "boolean") throw new TypeError("host returned invalid exit result");
    return value;
  },
  resolveProtection: async (request) => {
    if (!request || typeof request !== "object" || Array.isArray(request)
        || Object.keys(request).some((key) => !["token", "decision"].includes(key))
        || typeof request.token !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(request.token)
        || !["cancel", "save", "discard"].includes(request.decision)) {
      throw new TypeError("invalid protection decision");
    }
    const value = await ipcRenderer.invoke("document:resolve-protection",
      { token: request.token, decision: request.decision });
    if (!value || typeof value !== "object" || typeof value.proceed !== "boolean"
        || (value.completed !== true && (value.completed !== false
          || typeof value.retryToken !== "string" || !isCatalogCode(value.errorCode)))) {
      throw new TypeError("host returned invalid protection result");
    }
    return Object.freeze({ completed: value.completed, proceed: value.proceed,
      ...(value.completed === false ? { retryToken: value.retryToken,
        errorCode: value.errorCode } : {}) });
  },
  lock: async () => validateLockResult(await ipcRenderer.invoke("document:lock")),
  onLockStarted: (listener) => {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const handler = () => listener();
    ipcRenderer.on("document:lock-started", handler);
    return () => ipcRenderer.removeListener("document:lock-started", handler);
  },
  onLocked: (listener) => {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const handler = (_event, value) => listener(validateLockResult(value));
    ipcRenderer.on("document:locked", handler);
    return () => ipcRenderer.removeListener("document:locked", handler);
  },
  onJournalWarning: (listener) => {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const handler = (_event, value) => {
      if (value && typeof value === "object" && isCatalogCode(value.code)) {
        listener(value.code);
      } else listener("JOURNAL_WARNING");
    };
    ipcRenderer.on("document:journal-warning", handler);
    return () => ipcRenderer.removeListener("document:journal-warning", handler);
  },
  onRegularSave: (listener) => {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const handler = (_event, value) => listener(validateRegularSaveResult(value));
    ipcRenderer.on("document:regular-saved", handler);
    return () => ipcRenderer.removeListener("document:regular-saved", handler);
  },
  onExternalOpenRequested: (listener) => {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const handler = (_event, value) => {
      const request = validateExternalOpenRequest(value);
      listener(request);
      if (request.smokeCompleteAfterMs !== undefined) {
        setTimeout(() => {
          void ipcRenderer.invoke("document:open-external", {
            token: request.token, password: "single-instance-smoke",
          });
        }, request.smokeCompleteAfterMs);
      }
    };
    ipcRenderer.on("document:external-open-requested", handler);
    return () => ipcRenderer.removeListener("document:external-open-requested", handler);
  },
  onUnresolvedJournalSummary: (listener) => {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const handler = (_event, value) => listener(validateUnresolvedJournalSummary(value));
    ipcRenderer.on("journal:summary", handler);
    return () => ipcRenderer.removeListener("journal:summary", handler);
  },
  onSwitchRetained: (listener) => {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const handler = (_event, value) => listener(validateOpenedDocument(value));
    ipcRenderer.on("document:switch-retained", handler);
    return () => ipcRenderer.removeListener("document:switch-retained", handler);
  },
  onProtectionRequested: (listener) => {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const handler = (_event, value) => {
      const operations = ["new", "open", "external-open", "close", "exit"];
      const stateKeys = ["dirty", "provisional", "pendingPublication", "recovered",
        "conflict", "unresolvedJournal", "activePublication"];
      if (!value || typeof value !== "object" || typeof value.token !== "string"
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            .test(value.token)
          || !operations.includes(value.operation) || !value.state
          || stateKeys.some((key) => typeof value.state[key] !== "boolean")) {
        throw new TypeError("host sent invalid protection request");
      }
      listener(Object.freeze({ token: value.token, operation: value.operation,
        state: Object.freeze(Object.fromEntries(stateKeys.map((key) =>
          [key, value.state[key]]))) }));
    };
    ipcRenderer.on("document:protection-requested", handler);
    return () => ipcRenderer.removeListener("document:protection-requested", handler);
  },
  onDocumentClosed: (listener) => {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const handler = () => listener();
    ipcRenderer.on("document:closed", handler);
    return () => ipcRenderer.removeListener("document:closed", handler);
  },
}));
