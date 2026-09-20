const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const DEFAULT_REGULAR_SAVE_INTERVAL_MS = 120_000;
const MIN_REGULAR_SAVE_INTERVAL_MS = 10_000;
const MAX_REGULAR_SAVE_INTERVAL_MS = 86_400_000;

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

export function validateClientSettings(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("client settings must be an object");
  }
  const regularSaveEnabled = value.regularSaveEnabled ?? false;
  const regularSaveIntervalMs = value.regularSaveIntervalMs
    ?? DEFAULT_REGULAR_SAVE_INTERVAL_MS;
  if (typeof regularSaveEnabled !== "boolean"
      || !Number.isSafeInteger(regularSaveIntervalMs)
      || regularSaveIntervalMs < MIN_REGULAR_SAVE_INTERVAL_MS
      || regularSaveIntervalMs > MAX_REGULAR_SAVE_INTERVAL_MS) {
    throw new TypeError("regular save interval must be between 10 seconds and 24 hours");
  }
  return Object.freeze({ regularSaveEnabled, regularSaveIntervalMs });
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
    content: canonicalizeDocumentText(value.content),
    understandsIrrecoverable: true,
    storedRecoverySeparately: recoveryPassword !== null };
}

export function validatePassword(value) {
  return requiredText(value, "password", 4096);
}

export function validateOpenedDocument(value) {
  if (!value || typeof value !== "object" || value.readOnly !== true
      || typeof value.content !== "string" || typeof value.canEdit !== "boolean") {
    throw new TypeError("native bridge returned an invalid document");
  }
  if (value.mustBeChanged !== undefined && typeof value.mustBeChanged !== "boolean") {
    throw new TypeError("native bridge returned invalid invitation state");
  }
  if (value.canAddPasswords !== undefined
      && typeof value.canAddPasswords !== "boolean") {
    throw new TypeError("native bridge returned invalid slot permissions");
  }
  const invitationRequired = value.mustBeChanged === true;
  if (invitationRequired) {
    if (value.content !== "" || value.canEdit || value.canAddPasswords) {
      throw new TypeError("invitation content was exposed before claim");
    }
    return Object.freeze({ readOnly: true, invitationRequired: true });
  }
  let recovery;
  let lease;
  if (value.lease !== undefined) {
    const candidate = value.lease;
    if (!candidate || typeof candidate !== "object"
        || typeof candidate.active !== "boolean"
        || !/^[0-9a-f]{32}$/.test(candidate.sessionId)
        || !Number.isSafeInteger(candidate.heartbeatCounter)
        || !Number.isSafeInteger(candidate.holderUtcMs)
        || !Number.isSafeInteger(candidate.durationMs) || candidate.durationMs <= 0
        || typeof candidate.holderName !== "string"
        || typeof candidate.holderEmail !== "string"
        || typeof candidate.deviceName !== "string") {
      throw new TypeError("host returned invalid editing lease details");
    }
    lease = Object.freeze({ ...candidate });
  }
  let headMismatch;
  if (value.headMismatch !== undefined) {
    const mismatch = value.headMismatch;
    if (!mismatch || typeof mismatch !== "object"
        || !["rollback", "divergence", "replacement", "witness-error"].includes(mismatch.kind)
        || typeof mismatch.title !== "string" || !mismatch.title
        || typeof mismatch.explanation !== "string" || !mismatch.explanation
        || mismatch.editingBlocked !== true
        || !/^[0-9a-f]{32}$/.test(mismatch.observedDocumentId)
        || !/^[0-9a-f]{64}$/.test(mismatch.observedHead)
        || (mismatch.witnessedDocumentId !== undefined
          && !/^[0-9a-f]{32}$/.test(mismatch.witnessedDocumentId))
        || (mismatch.witnessedHead !== undefined
          && !/^[0-9a-f]{64}$/.test(mismatch.witnessedHead))) {
      throw new TypeError("host returned an invalid head mismatch");
    }
    headMismatch = Object.freeze({ ...mismatch });
  }
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
      ...(typeof value.recovery.authorName === "string" && value.recovery.authorName
        ? { authorName: value.recovery.authorName } : {}),
      ...(typeof value.recovery.deviceName === "string" && value.recovery.deviceName
        ? { deviceName: value.recovery.deviceName } : {}),
      cursor: Object.freeze({ start: value.recovery.cursor.start,
        end: value.recovery.cursor.end }) });
  }
  const publicationState = value.publicationState ?? "target-published";
  if (!["target-published", "pending-publication", "conflict"].includes(publicationState)) {
    throw new TypeError("host returned an invalid publication state");
  }
  if (value.manuallySealed !== undefined && typeof value.manuallySealed !== "boolean") {
    throw new TypeError("host returned invalid revision state");
  }
  if (value.provisional !== undefined && typeof value.provisional !== "boolean") {
    throw new TypeError("host returned invalid provisional state");
  }
  const provisional = value.provisional === true || value.manuallySealed === false;
  let profileMismatch;
  if (value.profileMismatch !== undefined) {
    const mismatch = value.profileMismatch;
    if (!mismatch || typeof mismatch !== "object"
        || typeof mismatch.slotName !== "string"
        || typeof mismatch.slotEmail !== "string"
        || typeof mismatch.profileName !== "string"
        || typeof mismatch.profileEmail !== "string") {
      throw new TypeError("host returned invalid profile mismatch details");
    }
    profileMismatch = Object.freeze({ ...mismatch, editingBlocked: true });
  }
  if (value.managedSlots !== undefined && !Array.isArray(value.managedSlots)) {
    throw new TypeError("host returned invalid managed slots");
  }
  const managedSlots = value.managedSlots?.map((slot) => {
    if (!slot || typeof slot !== "object" || !/^[0-9a-f]{32}$/.test(slot.slotId)
        || typeof slot.identityName !== "string" || typeof slot.identityEmail !== "string"
        || typeof slot.canEdit !== "boolean"
        || typeof slot.canAddPasswords !== "boolean"
        || typeof slot.canRemovePasswords !== "boolean"
        || typeof slot.mustBeChanged !== "boolean"
        || (slot.slotIdKnown !== undefined && typeof slot.slotIdKnown !== "boolean")
        || (slot.permissionsKnown !== undefined && typeof slot.permissionsKnown !== "boolean")
        || (slot.identityKnown !== undefined && typeof slot.identityKnown !== "boolean")) {
      throw new TypeError("host returned invalid managed slot details");
    }
    return Object.freeze({ ...slot });
  });
  return Object.freeze({ content: value.content, readOnly: true,
    canEdit: value.canEdit, publicationState,
    ...(provisional ? { provisional: true } : {}),
    ...(value.canAddPasswords !== undefined
      ? { canAddPasswords: value.canAddPasswords } : {}),
    ...(value.canRemovePasswords !== undefined
      ? { canRemovePasswords: value.canRemovePasswords } : {}),
    ...(value.recoverySlot !== undefined ? { recoverySlot: value.recoverySlot } : {}),
    ...(value.slotId !== undefined ? { slotId: value.slotId } : {}),
    ...(value.slotIdentityName !== undefined
      ? { slotIdentityName: value.slotIdentityName,
        slotIdentityEmail: value.slotIdentityEmail } : {}),
    ...(managedSlots ? { managedSlots: Object.freeze(managedSlots) } : {}),
    ...(profileMismatch ? { profileMismatch } : {}),
    ...(value.mustBeChanged !== undefined ? { invitationRequired } : {}),
    ...(lease ? { lease } : {}),
    ...(recovery ? { recovery } : {}),
    ...(headMismatch ? { headMismatch } : {}) });
}

export function validateEditMode(value) {
  if (!value || typeof value !== "object" || value.readOnly !== false
      || value.canEdit !== true || typeof value.content !== "string") {
    throw new TypeError("host did not enter edit mode");
  }
  return Object.freeze({ content: value.content, readOnly: false, canEdit: true,
    publicationState: "target-published",
    ...(value.canAddPasswords !== undefined
      ? { canAddPasswords: value.canAddPasswords } : {}),
    ...(value.canRemovePasswords !== undefined
      ? { canRemovePasswords: value.canRemovePasswords } : {}),
    ...(value.managedSlots !== undefined ? { managedSlots: value.managedSlots } : {}),
    ...(value.invitationRequired !== undefined
      ? { invitationRequired: false } : {}) });
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
      || typeof value.content !== "string"
      || !["target-published", "pending-publication", "conflict"].includes(value.publicationState)
      || Object.keys(value).length !== 3) {
    throw new TypeError("host returned an invalid save result");
  }
  return Object.freeze({ saved: true, content: value.content,
    publicationState: value.publicationState });
}

export function validatePublicationResult(value) {
  if (!value || typeof value !== "object"
      || !["target-published", "pending-publication", "conflict"].includes(value.publicationState)
      || typeof value.content !== "string" || Object.keys(value).length !== 2) {
    throw new TypeError("host returned an invalid publication result");
  }
  return Object.freeze({ publicationState: value.publicationState,
    content: value.content });
}

export function validateMergeDraft(value) {
  if (!value || typeof value !== "object" || typeof value.content !== "string"
      || typeof value.hasConflicts !== "boolean"
      || !/^[0-9a-f]{64}$/.test(value.ancestorRevision)
      || !/^[0-9a-f]{64}$/.test(value.localRevision)
      || !/^[0-9a-f]{64}$/.test(value.currentRevision)
      || Object.keys(value).length !== 5) {
    throw new TypeError("host returned an invalid merge draft");
  }
  return Object.freeze({ content: canonicalizeDocumentText(value.content),
    hasConflicts: value.hasConflicts,
    ancestorRevision: value.ancestorRevision,
    localRevision: value.localRevision,
    currentRevision: value.currentRevision });
}

export function validatePlaintextExportRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 2
      || !Object.hasOwn(value, "content")
      || !Object.hasOwn(value, "lineEndings")
      || (value.lineEndings !== "lf" && value.lineEndings !== "native")) {
    throw new TypeError("plaintext export request is invalid");
  }
  return Object.freeze({
    content: canonicalizeDocumentText(value.content),
    lineEndings: value.lineEndings,
  });
}

export function validatePlaintextExportResult(value) {
  if (!value || typeof value !== "object" || value.exported !== true
      || Object.keys(value).length !== 1) {
    throw new TypeError("host returned an invalid plaintext export result");
  }
  return Object.freeze({ exported: true });
}

export function validateBackupResult(value) {
  if (!value || typeof value !== "object" || value.backedUp !== true
      || Object.keys(value).length !== 1) {
    throw new TypeError("host returned an invalid backup result");
  }
  return Object.freeze({ backedUp: true });
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
