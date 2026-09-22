import { randomUUID } from "node:crypto";
import { applyCloseDecision, needsCloseDecision } from "./close-document.mjs";

const OPERATIONS = new Set(["new", "open", "external-open", "close", "exit"]);
const DECISIONS = new Set(["cancel", "save", "discard"]);

/* Describes the non-clean state that must be resolved before a session is abandoned. */
export function describeProtection(active, activePublication = false) {
  if (!active || (!needsCloseDecision(active) && !activePublication)) return null;
  const regularSavePending = active.pendingRecord?.publication?.purpose === "regular-save";
  return Object.freeze({
    dirty: active.dirty === true,
    provisional: active.manuallySealed === false || regularSavePending,
    pendingPublication: active.pendingPublication === true,
    recovered: Boolean(active.recovery),
    conflict: active.pendingRecord?.state === "conflict",
    unresolvedJournal: Boolean(active.unresolvedJournal || active.unreadableJournal),
    activePublication,
  });
}

/* Coordinates one accessible protection decision against the exact captured session. */
export class SessionProtectionCoordinator {
  constructor({ getService, present, generation = null }) {
    this.getService = getService;
    this.present = present;
    this.generation = generation;
    this.pending = null;
    this.cleanOperation = null;
  }

  async authorize(operation, commit = async () => {}, validateCandidate = async () => {}) {
    if (!OPERATIONS.has(operation)) throw new TypeError("invalid protection operation");
    if (typeof commit !== "function") throw new TypeError("invalid protection commit");
    if (typeof validateCandidate !== "function") {
      throw new TypeError("invalid protection candidate validation");
    }
    const service = this.getService();
    const generation = this.generation?.capture();
    const state = describeProtection(service.active,
      service.hasActivePublication?.() === true);
    if (this.pending || this.cleanOperation) {
      const error = new Error("Another document protection decision is already in progress");
      error.code = "DOCUMENT_PROTECTION_BUSY";
      throw error;
    }
    if (!state) {
      const active = service.active;
      const runExclusive = service.runLifecycleBarrier?.bind(service)
        ?? ((operation) => operation());
      const claimed = { state: "queued", aborted: false };
      this.cleanOperation = claimed;
      try {
        await runExclusive(async () => {
          if (claimed.aborted) throw Object.assign(
            new Error("The document locked while the operation was waiting; nothing was abandoned"),
            { code: "DOCUMENT_PROTECTION_LOCKED" });
          if (this.getService() !== service || service.active !== active) {
            throw Object.assign(new Error(
              "The document changed while the operation was waiting; nothing was abandoned"),
            { code: "DOCUMENT_PROTECTION_STALE" });
          }
          this.#assertGeneration(generation);
          await validateCandidate();
          this.#assertGeneration(generation);
          claimed.state = "commit";
          await commit();
          this.#assertGeneration(generation);
        });
        return true;
      } finally { if (this.cleanOperation === claimed) this.cleanOperation = null; }
    }
    const token = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending = { token, operation, service, active: service.active,
        generation, state: "presented", aborted: false, commit, validateCandidate,
        resolve, reject };
      try { this.present(Object.freeze({ token, operation, state })); }
      catch (error) { this.pending = null; reject(error); }
    });
  }

  async decide(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)
        || Object.keys(request).some((key) => !["token", "decision"].includes(key))
        || typeof request.token !== "string" || !DECISIONS.has(request.decision)) {
      throw new TypeError("invalid protection decision");
    }
    const pending = this.pending;
    if (!pending || pending.token !== request.token || pending.state !== "presented") {
      throw new Error("The protection decision is no longer active");
    }
    pending.state = "in-flight";
    if (request.decision === "cancel") {
      this.pending = null;
      pending.resolve(false);
      return Object.freeze({ completed: true, proceed: false });
    }
    if (this.getService() !== pending.service || pending.service.active !== pending.active) {
      this.pending = null;
      const error = new Error("The document changed while the decision was open; nothing was abandoned");
      pending.reject(error);
      throw error;
    }
    try {
      const runExclusive = pending.service.runLifecycleBarrier?.bind(pending.service)
        ?? ((operation) => operation());
      const proceed = await runExclusive(async () => {
        if (pending.aborted) throw Object.assign(
          new Error("The document locked while the decision was running; nothing was abandoned"),
          { code: "DOCUMENT_PROTECTION_LOCKED" });
        this.#assertGeneration(pending.generation);
        if (this.getService() !== pending.service || pending.service.active !== pending.active) {
          throw Object.assign(new Error(
            "The document changed while the decision was running; nothing was abandoned"),
          { code: "DOCUMENT_PROTECTION_STALE" });
        }
        await pending.validateCandidate();
        this.#assertGeneration(pending.generation);
        const allowed = !needsCloseDecision(pending.service.active)
          || await applyCloseDecision(pending.service, request.decision);
        if (!allowed) return false;
        if (pending.aborted) throw Object.assign(
          new Error("The document locked while the decision was running; nothing was abandoned"),
          { code: "DOCUMENT_PROTECTION_LOCKED" });
        this.#assertGeneration(pending.generation);
        await pending.commit();
        this.#assertGeneration(pending.generation);
        if (pending.aborted) throw Object.assign(
          new Error("The document locked while the decision was running; nothing was abandoned"),
          { code: "DOCUMENT_PROTECTION_LOCKED" });
        return true;
      });
      this.pending = null;
      pending.resolve(proceed);
      return Object.freeze({ completed: true, proceed });
    } catch (error) {
      if (pending.aborted || error?.code === "DOCUMENT_PROTECTION_LOCKED"
          || error?.code === "DOCUMENT_SESSION_INVALIDATED"
          || error?.code === "DOCUMENT_PROTECTION_STALE") {
        this.pending = null;
        pending.reject(error);
        throw error;
      }
      const retryToken = randomUUID();
      pending.token = retryToken;
      pending.state = "presented";
      return Object.freeze({ completed: false, proceed: false, retryToken,
        errorCode: "LIFECYCLE_FAILED" });
    }
  }

  cancelForLock() {
    if (this.cleanOperation?.state === "queued") {
      this.cleanOperation.aborted = true;
      return true;
    }
    const pending = this.pending;
    if (!pending) return false;
    if (pending.state === "in-flight") {
      pending.aborted = true;
      return true;
    }
    this.pending = null;
    const error = new Error("The document locked while the decision was open; nothing was abandoned");
    error.code = "DOCUMENT_PROTECTION_LOCKED";
    pending.reject(error);
    return true;
  }

  #assertGeneration(captured) {
    if (captured !== undefined) this.generation?.assertCurrent(captured);
  }
}
