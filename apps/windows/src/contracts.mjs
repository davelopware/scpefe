const MAX_TEXT_BYTES = 16 * 1024 * 1024;

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
  if (typeof value.content !== "string"
      || Buffer.byteLength(value.content, "utf8") > MAX_TEXT_BYTES) {
    throw new TypeError("content must be UTF-8 text within the size limit");
  }
  return { ownerPassword, recoveryPassword, content: value.content };
}

export function validatePassword(value) {
  return requiredText(value, "password", 4096);
}

export function validateOpenedDocument(value) {
  if (!value || typeof value !== "object" || value.readOnly !== true
      || typeof value.content !== "string") {
    throw new TypeError("native bridge returned an invalid document");
  }
  return Object.freeze({ content: value.content, readOnly: true });
}

export function validateCreationResult(value) {
  if (!value || typeof value !== "object" || value.created !== true
      || Object.keys(value).length !== 1) {
    throw new TypeError("host returned an invalid creation result");
  }
  return Object.freeze({ created: true });
}
