const MAX_TEXT_BYTES = 16 * 1024 * 1024;

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

export function canonicalizeDocumentText(value) {
  if (typeof value !== "string" || hasUnpairedSurrogate(value)) {
    throw new TypeError("content must be valid UTF-8 text");
  }
  const withoutBom = value.startsWith("\ufeff") ? value.slice(1) : value;
  const canonical = withoutBom.replace(/\r\n?/g, "\n");
  if (Buffer.byteLength(canonical, "utf8") > MAX_TEXT_BYTES) {
    throw new TypeError("content must be UTF-8 text within the size limit");
  }
  return canonical;
}

function requiredText(value, field, maximum = 512) {
  if (typeof value !== "string") throw new TypeError(`${field} must be text`);
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  if (Buffer.byteLength(normalized, "utf8") > maximum) {
    throw new TypeError(`${field} is too long`);
  }
  return normalized;
}

function canonicalCursorOffset(value, offset) {
  let prefix = value.slice(0, offset);
  if (prefix.startsWith("\ufeff")) prefix = prefix.slice(1);
  return prefix.replace(/\r\n?/g, "\n").length;
}

export function validateProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("profile must be an object");
  }
  const name = requiredText(value.name, "name");
  const email = requiredText(value.email, "email");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TypeError("email must be a valid address");
  }
  return { name, email, deviceName: requiredText(value.deviceName, "device name") };
}

export function validateCreateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("create request must be an object");
  }
  const ownerPassword = requiredText(value.ownerPassword, "owner password", 4096);
  if (ownerPassword.length < 12) {
    throw new TypeError("owner password must contain at least 12 characters");
  }
  const recoveryPassword = value.recoveryPassword
    ? requiredText(value.recoveryPassword, "recovery password", 4096) : null;
  if (recoveryPassword && recoveryPassword.length < 12) {
    throw new TypeError("recovery password must contain at least 12 characters");
  }
  if (recoveryPassword === ownerPassword) {
    throw new TypeError("recovery password must be independent from the owner password");
  }
  if (value.understandsIrrecoverable !== true) {
    throw new TypeError("irrecoverability must be acknowledged");
  }
  if (recoveryPassword && value.storedRecoverySeparately !== true) {
    throw new TypeError("recovery password storage must be acknowledged");
  }
  return { ownerPassword, recoveryPassword,
    content: canonicalizeDocumentText(value.content) };
}

export function validatePassword(value) {
  return requiredText(value, "password", 4096);
}

export function validateOpenedDocument(value) {
  if (!value || typeof value !== "object" || value.readOnly !== true
      || typeof value.content !== "string" || typeof value.canEdit !== "boolean") {
    throw new TypeError("native bridge returned an invalid document");
  }
  let recovery;
  if (value.recovery !== undefined) {
    if (!value.recovery || typeof value.recovery !== "object"
        || typeof value.recovery.content !== "string"
        || value.recovery.state !== "unsaved"
        || !Number.isSafeInteger(value.recovery.updateTime)
        || !value.recovery.cursor
        || !Number.isSafeInteger(value.recovery.cursor.start)
        || value.recovery.cursor.start < 0
        || !Number.isSafeInteger(value.recovery.cursor.end)
        || value.recovery.cursor.end < value.recovery.cursor.start
        || value.recovery.cursor.end > value.recovery.content.length) {
      throw new TypeError("host returned invalid recovered work");
    }
    recovery = Object.freeze({ content: value.recovery.content, state: "unsaved",
      updateTime: value.recovery.updateTime,
      cursor: Object.freeze({ start: value.recovery.cursor.start,
        end: value.recovery.cursor.end }) });
  }
  return Object.freeze({ content: value.content, readOnly: true,
    canEdit: value.canEdit, ...(recovery ? { recovery } : {}) });
}

export function validateEditMode(value) {
  if (!value || typeof value !== "object" || value.readOnly !== false
      || value.canEdit !== true || typeof value.content !== "string") {
    throw new TypeError("host did not enter edit mode");
  }
  return Object.freeze({ content: value.content, readOnly: false, canEdit: true });
}

export function validateRecoveredWork(value) {
  if (!value || typeof value !== "object" || value.readOnly !== false
      || value.canEdit !== true || value.recoveredUnsaved !== true
      || typeof value.content !== "string" || !value.cursor
      || !Number.isSafeInteger(value.cursor.start)
      || !Number.isSafeInteger(value.cursor.end)) {
    throw new TypeError("host did not restore recovered work");
  }
  return Object.freeze({ content: value.content, readOnly: false, canEdit: true,
    recoveredUnsaved: true, cursor: Object.freeze({ start: value.cursor.start,
      end: value.cursor.end }) });
}

export function validateSaveResult(value) {
  if (!value || typeof value !== "object" || value.saved !== true
      || typeof value.content !== "string" || Object.keys(value).length !== 2) {
    throw new TypeError("host returned an invalid save result");
  }
  return Object.freeze({ saved: true, content: value.content });
}

export function validateWorkingCopy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("working copy must be an object");
  }
  if (typeof value.content !== "string") {
    throw new TypeError("content must be valid UTF-8 text");
  }
  const start = value.cursor?.start;
  const end = value.cursor?.end;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || end > value.content.length) {
    throw new TypeError("cursor must be within the working copy");
  }
  const content = canonicalizeDocumentText(value.content);
  return { content, cursor: {
    start: canonicalCursorOffset(value.content, start),
    end: canonicalCursorOffset(value.content, end),
  } };
}

export function validateLockResult(value) {
  if (!value || typeof value !== "object" || value.locked !== true
      || typeof value.journalSaved !== "boolean"
      || (value.warning !== null && typeof value.warning !== "string")) {
    throw new TypeError("host returned an invalid lock result");
  }
  return Object.freeze({ locked: true, journalSaved: value.journalSaved,
    warning: value.warning });
}

export function validateCreationResult(value) {
  if (!value || typeof value !== "object" || value.created !== true
      || Object.keys(value).length !== 1) {
    throw new TypeError("host returned an invalid creation result");
  }
  return Object.freeze({ created: true });
}
