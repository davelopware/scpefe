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
  return Object.freeze({ content: value.content, readOnly: true,
    canEdit: value.canEdit });
}

export function validateEditMode(value) {
  if (!value || typeof value !== "object" || value.readOnly !== false
      || value.canEdit !== true || typeof value.content !== "string") {
    throw new TypeError("host did not enter edit mode");
  }
  return Object.freeze({ content: value.content, readOnly: false, canEdit: true });
}

export function validateSaveResult(value) {
  if (!value || typeof value !== "object" || value.saved !== true
      || typeof value.content !== "string" || Object.keys(value).length !== 2) {
    throw new TypeError("host returned an invalid save result");
  }
  return Object.freeze({ saved: true, content: value.content });
}

export function validateCreationResult(value) {
  if (!value || typeof value !== "object" || value.created !== true
      || Object.keys(value).length !== 1) {
    throw new TypeError("host returned an invalid creation result");
  }
  return Object.freeze({ created: true });
}
