import path from "node:path";
import { fileURLToPath } from "node:url";

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

/* Validates the random acknowledgement token used only for liveness signalling. */
export function acknowledgementToken(value) {
  const token = value?.acknowledgementToken;
  return typeof token === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(token) ? token : null;
}

/* Holds every shell request in FIFO order until the current request completes. */
export class OrderedOpenRequests {
  constructor({ randomToken }) {
    this.randomToken = randomToken;
    this.pending = [];
    this.active = null;
    this.ready = false;
  }

  enqueue({ target = null, acknowledgementToken: ack = null, source }) {
    const request = Object.freeze({ token: this.randomToken(), target, ack, source });
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
