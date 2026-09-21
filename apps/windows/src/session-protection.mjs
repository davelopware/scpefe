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
  constructor({ getService, present }) {
    this.getService = getService;
    this.present = present;
    this.pending = null;
  }

  async authorize(operation) {
    if (!OPERATIONS.has(operation)) throw new TypeError("invalid protection operation");
    const service = this.getService();
    const state = describeProtection(service.active,
      service.hasActivePublication?.() === true);
    if (!state) return true;
    if (this.pending) {
      const error = new Error("Another document protection decision is already in progress");
      error.code = "DOCUMENT_PROTECTION_BUSY";
      throw error;
    }
    const token = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending = { token, operation, service, active: service.active, resolve, reject };
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
    if (!pending || pending.token !== request.token) {
      throw new Error("The protection decision is no longer active");
    }
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
      if (pending.service.hasActivePublication?.() === true) {
        await pending.service.waitForPublications();
        if (this.getService() !== pending.service || pending.service.active !== pending.active) {
          this.pending = null;
          const error = new Error(
            "The document changed while publication completed; nothing was abandoned");
          pending.reject(error);
          throw error;
        }
        if (!needsCloseDecision(pending.service.active)) {
          this.pending = null;
          pending.resolve(true);
          return Object.freeze({ completed: true, proceed: true });
        }
      }
      const proceed = await applyCloseDecision(pending.service, request.decision);
      this.pending = null;
      pending.resolve(proceed);
      return Object.freeze({ completed: true, proceed });
    } catch (error) {
      // Keep the request active so the user can retry or cancel after a recoverable failure.
      throw error;
    }
  }

  cancelForLock() {
    const pending = this.pending;
    if (!pending) return false;
    this.pending = null;
    const error = new Error("The document locked while the decision was open; nothing was abandoned");
    error.code = "DOCUMENT_PROTECTION_LOCKED";
    pending.reject(error);
    return true;
  }
}
