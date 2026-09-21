import { randomUUID } from "node:crypto";

const OPERATIONS = new Set(["edit", "recovery", "divergence", "migration"]);

/* Keeps native lease capabilities out of the renderer and makes every approval one-shot. */
export class LeaseTakeoverAuthorizations {
  constructor({ createId = randomUUID } = {}) {
    this.createId = createId;
    this.pending = new Map();
  }

  stage(operation, service, error) {
    if (!OPERATIONS.has(operation) || !service || error?.code !== "LEASE_CLOCK_UNCERTAIN"
        || !error.takeoverToken) {
      throw new TypeError("lease takeover evidence is invalid");
    }
    const authorization = this.createId();
    this.pending.set(authorization, { operation, service, token: error.takeoverToken });
    return Object.freeze({ decisionRequired: "lease-takeover", operation,
      holderName: String(error.lease?.holderName || "another editor"), authorization });
  }

  consume(operation, authorization, service) {
    const pending = this.pending.get(authorization);
    if (pending) this.pending.delete(authorization);
    if (!pending || pending.operation !== operation || pending.service !== service) {
      if (pending) pending.service.cancelLeaseTakeover(pending.token);
      throw new Error("No matching lease takeover is awaiting confirmation");
    }
    return pending.token;
  }

  cancel(authorization, service) {
    const pending = this.pending.get(authorization);
    if (!pending) return false;
    this.pending.delete(authorization);
    if (pending.service !== service) {
      pending.service.cancelLeaseTakeover(pending.token);
      return false;
    }
    return pending.service.cancelLeaseTakeover(pending.token);
  }

  clear() {
    for (const pending of this.pending.values()) {
      pending.service.cancelLeaseTakeover(pending.token);
    }
    this.pending.clear();
  }
}

/* Runs a lease-requiring operation and stages only clock-uncertain takeovers. */
export async function runLeaseOperation({ authorizations, operation, service,
  authorization, perform }) {
  const takeoverToken = authorization === undefined ? undefined
    : authorizations.consume(operation, authorization, service);
  try {
    return await perform(takeoverToken);
  } catch (error) {
    if (authorization !== undefined && error?.code === "LEASE_CHANGED") {
      try {
        return await perform(undefined);
      } catch (refreshed) {
        if (refreshed?.code !== "LEASE_CLOCK_UNCERTAIN") throw refreshed;
        return authorizations.stage(operation, service, refreshed);
      }
    }
    if (error?.code !== "LEASE_CLOCK_UNCERTAIN") throw error;
    return authorizations.stage(operation, service, error);
  }
}
