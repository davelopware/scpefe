import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

function scpefePath(value, workingDirectory) {
  if (typeof value !== "string" || !value || value.startsWith("-")) return null;
  if (/\.scpefe$/i.test(value)) return path.resolve(workingDirectory, value);
  return openTargetFromUrl(value);
}

/* Extracts one Windows shell-open target while rejecting switches and other file types. */
export function openTargetFromCommandLine(commandLine, workingDirectory = process.cwd()) {
  if (!Array.isArray(commandLine)) return null;
  for (const argument of commandLine.slice(1)) {
    const target = scpefePath(argument, workingDirectory);
    if (target) return target;
  }
  return null;
}

/* Resolves file URLs and the narrow scpefe://open?target=file: lifecycle form. */
export function openTargetFromUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const targetUrl = url.protocol === "file:" ? url
      : url.protocol === "scpefe:" && url.hostname === "open"
        ? new URL(url.searchParams.get("target")) : null;
    if (!targetUrl || targetUrl.protocol !== "file:") return null;
    const target = fileURLToPath(targetUrl);
    return path.isAbsolute(target) && /\.scpefe$/i.test(target)
      ? path.normalize(target) : null;
  } catch {
    return null;
  }
}

/* Accepts only a validated shell-open target from untrusted second-instance metadata. */
export function openTargetFromAdditionalData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.openTarget !== "string"
      || !path.isAbsolute(value.openTarget)
      || !/\.scpefe$/i.test(value.openTarget)) return null;
  return path.normalize(value.openTarget);
}

/* Validates the per-launch identifier and secret used for acknowledgement authentication. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function acknowledgementCredentials(value) {
  const id = value?.acknowledgementId;
  const secret = value?.acknowledgementSecret;
  return typeof id === "string" && UUID.test(id)
    && typeof secret === "string" && UUID.test(secret)
    ? Object.freeze({ id, secret }) : null;
}

/* Binds acknowledgements to the exact normalized target without disclosing its path. */
export function acknowledgementTargetHash(target) {
  return createHash("sha256").update(target ?? "", "utf8").digest("hex");
}

function acknowledgementMessage(value) {
  return JSON.stringify({ id: value.id, requestToken: value.requestToken,
    targetHash: value.targetHash, sequence: value.sequence, status: value.status });
}

/* Authenticates one acknowledgement transition with the launch-only secret. */
export function createAcknowledgement(credentials, value) {
  const payload = { id: credentials.id, requestToken: value.requestToken,
    targetHash: value.targetHash, sequence: value.sequence, status: value.status };
  return Object.freeze({ ...payload, mac: createHmac("sha256", credentials.secret)
    .update(acknowledgementMessage(payload)).digest("hex") });
}

/* Rejects stale, redirected, malformed, or forged acknowledgement transitions. */
export function validateAcknowledgement(credentials, value, targetHash) {
  const validState = value?.sequence === 1 && value?.status === "queued"
    || value?.sequence === 2 && value?.status === "presented"
    || value?.sequence === 3
      && ["focused", "opened", "canceled"].includes(value?.status);
  if (!value || typeof value !== "object" || value.id !== credentials.id
      || typeof value.requestToken !== "string" || !UUID.test(value.requestToken)
      || value.targetHash !== targetHash
      || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.sequence > 3
      || !validState
      || typeof value.mac !== "string" || !/^[0-9a-f]{64}$/.test(value.mac)) return null;
  const expected = createHmac("sha256", credentials.secret)
    .update(acknowledgementMessage(value)).digest();
  const observed = Buffer.from(value.mac, "hex");
  return observed.length === expected.length && timingSafeEqual(observed, expected)
    ? Object.freeze({ id: value.id, requestToken: value.requestToken,
      targetHash: value.targetHash, sequence: value.sequence, status: value.status }) : null;
}

/* Holds every shell request in FIFO order until the current request completes. */
export class OrderedOpenRequests {
  constructor({ randomToken }) {
    this.randomToken = randomToken;
    this.pending = [];
    this.active = null;
    this.ready = false;
  }

  enqueue({ target = null, acknowledgement = null, source }) {
    const request = Object.freeze({ token: this.randomToken(), target,
      ack: acknowledgement, source });
    this.pending.push(request);
    return request;
  }

  setReady(ready = true) { this.ready = ready; }

  take() {
    if (!this.ready || this.active || this.pending.length === 0) return null;
    this.active = this.pending.shift();
    return this.active;
  }

  current(token) {
    return this.active?.token === token ? this.active : null;
  }

  complete(token) {
    if (!this.current(token)) throw new TypeError("external open request is not active");
    const completed = this.active;
    this.active = null;
    return completed;
  }

  get size() { return this.pending.length + (this.active ? 1 : 0); }
}
