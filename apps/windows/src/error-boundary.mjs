const ENVELOPE_PREFIX = "SCPEFE_SAFE_ERROR:";
const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const PATH_OR_STACK = /(?:[a-z]:[\\/]|(?:^|[\s"'`])\/(?:[^\s/:]+\/)+|\\\\[^\\\s]+\\|\b(?:at|file:)\s+[^\n]*:\d+(?::\d+)?|\.(?:scpefe|tmp|node|dll|so)(?:\b|:))/i;

const OPERATIONS = Object.freeze({
  "profile:get": ["PROFILE_FAILED", "The local profile could not be loaded.", "Try again."],
  "profile:save": ["PROFILE_FAILED", "The local profile could not be saved.", "Review the fields and try again."],
  "document:create": ["CREATE_FAILED", "The encrypted document could not be created.", "Review the security details and try again, or cancel."],
  "document:open-selected": ["OPEN_FAILED", "The document could not be opened.", "Check the password and try again, or cancel."],
  "document:open-external": ["OPEN_FAILED", "The requested document could not be opened.", "Check the password and try again, or cancel."],
  "document:unlock": ["UNLOCK_FAILED", "The document could not be unlocked.", "Check the password and try again."],
  "document:save": ["SAVE_FAILED", "The document could not be saved.", "The working copy remains available; retry or cancel."],
  "document:save-divergence-resolution": ["SAVE_FAILED", "The conflict resolution could not be saved.", "Review the document and retry."],
  "document:reconnect-publication": ["PUBLICATION_FAILED", "The pending publication could not be completed.", "Keep the document open and retry when the target is available."],
  "document:backup": ["BACKUP_FAILED", "The verified backup could not be created.", "Choose another destination or cancel."],
  "document:compact": ["COMPACTION_FAILED", "Document compaction could not be completed.", "The document remains unchanged; retry or cancel."],
  "document:migrate": ["MIGRATION_FAILED", "Document migration could not be completed.", "The original document remains available; retry or cancel."],
  "document:export-plaintext": ["EXPORT_FAILED", "The plaintext copy could not be exported.", "Choose another destination or cancel."],
  "document:change-password": ["PASSWORD_CHANGE_FAILED", "The password could not be changed.", "Review the passwords and try again."],
  "document:create-invitation": ["INVITATION_FAILED", "The invitation could not be created.", "Review the invitation and try again."],
  "document:claim-invitation": ["INVITATION_FAILED", "The invitation could not be claimed.", "Review the password and try again, or cancel."],
  "document:resolve-protection": ["LIFECYCLE_FAILED", "The document protection choice could not be completed.", "The current session remains open; retry or cancel."],
  "document:close": ["LIFECYCLE_FAILED", "The document could not be closed safely.", "The current session remains open; retry or cancel."],
  "application:exit": ["LIFECYCLE_FAILED", "The application could not exit safely.", "The current session remains open; retry or cancel."],
});

function operationDetails(operation) {
  if (OPERATIONS[operation]) return OPERATIONS[operation];
  if (operation?.startsWith("profile:")) return OPERATIONS["profile:save"];
  if (operation?.includes("password") || operation?.includes("slot")) {
    return OPERATIONS["document:change-password"];
  }
  if (operation?.includes("invitation")) return OPERATIONS["document:create-invitation"];
  if (operation?.includes("open")) return OPERATIONS["document:open-selected"];
  return ["OPERATION_FAILED", "The operation could not be completed safely.",
    "Try again or cancel without changing the current document."];
}

function safeKnownCode(value) {
  if (typeof value !== "string" || !SAFE_CODE.test(value)) return null;
  if (/^(?:DOCUMENT|LEASE|CLOSE|MERGE|MIGRATION|PUBLICATION|SCPEFE)_/.test(value)) {
    return value;
  }
  return null;
}

export class SafeBoundaryError extends Error {
  constructor(code, userMessage, nextAction) {
    super(userMessage);
    this.name = "SafeBoundaryError";
    this.code = code;
    this.nextAction = nextAction;
  }
}

export function safeErrorDetails(error, operation = "operation") {
  const fallback = operationDetails(operation);
  const sourceCode = safeKnownCode(error?.code);
  return Object.freeze({ code: sourceCode ?? fallback[0], message: fallback[1],
    nextAction: fallback[2] });
}

export function boundaryError(error, operation) {
  const safe = safeErrorDetails(error, operation);
  return new SafeBoundaryError(safe.code, safe.message, safe.nextAction);
}

export function encodeBoundaryError(error, operation) {
  const safe = safeErrorDetails(error, operation);
  return new Error(`${ENVELOPE_PREFIX}${JSON.stringify(safe)}`);
}

export function decodeBoundaryError(error, operation = "operation") {
  const message = typeof error?.message === "string" ? error.message : "";
  const offset = message.indexOf(ENVELOPE_PREFIX);
  if (offset >= 0) {
    try {
      const value = JSON.parse(message.slice(offset + ENVELOPE_PREFIX.length));
      if (value && (safeKnownCode(value.code) || SAFE_CODE.test(value.code ?? ""))) {
        if (typeof value.message === "string" && value.message.length <= 512
            && typeof value.nextAction === "string" && value.nextAction.length <= 512
            && !PATH_OR_STACK.test(value.message) && !PATH_OR_STACK.test(value.nextAction)) {
          return new SafeBoundaryError(value.code, value.message, value.nextAction);
        }
      }
    } catch {}
  }
  return boundaryError(error, operation);
}

export function safeRendererErrorMessage(error) {
  if (error instanceof SafeBoundaryError) return `${error.message} ${error.nextAction}`;
  const message = typeof error?.message === "string" ? error.message
    : typeof error === "string" ? error : "";
  if (!message || message.length > 512 || /[\r\n]/.test(message) || PATH_OR_STACK.test(message)) {
    const safe = operationDetails("operation");
    return `${safe[1]} ${safe[2]}`;
  }
  return message.replace(/[\u0000-\u001f\u007f]/g, "");
}

export function safeEventWarning(error, operation = "operation") {
  const safe = safeErrorDetails(error, operation);
  return `${safe.message} ${safe.nextAction}`;
}

export function createSafeIpc(ipc) {
  return Object.freeze({ handle(channel, handler) {
    ipc.handle(channel, async (...args) => {
      try { return await handler(...args); }
      catch (error) { throw encodeBoundaryError(error, channel); }
    });
  } });
}
