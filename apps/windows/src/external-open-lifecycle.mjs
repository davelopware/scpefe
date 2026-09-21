const TERMINAL = new Set(["opened", "canceled", "failed"]);

/* Completes authenticated external-open requests only after their final outcome is known. */
export class ExternalOpenLifecycle {
  constructor({ requests, acknowledge, record = async () => {}, drain }) {
    this.requests = requests;
    this.acknowledge = acknowledge;
    this.record = record;
    this.drain = drain;
    this.invitation = null;
    this.finishing = new Map();
    this.terminating = false;
  }

  current(token) { return this.requests.current(token); }

  stageInvitation(request) {
    this.#requireActive(request);
    if (this.invitation) throw new Error("An external invitation is already pending");
    this.invitation = request;
  }

  async cancel(token, { blocked = false } = {}) {
    const request = this.requests.current(token);
    if (!request || blocked || this.invitation) {
      throw new Error("The external open request is no longer cancelable here");
    }
    await this.finish(request, "canceled", "renderer-canceled");
    return true;
  }

  async finishInvitation(status, outcome) {
    if (!this.invitation) throw new Error("No external invitation is pending");
    const request = this.invitation;
    await this.finish(request, status, outcome);
    this.invitation = null;
  }

  async cancelForLock() {
    const request = this.requests.currentRequest;
    if (!request) return false;
    await this.finish(request, "canceled", "session-locked");
    if (this.invitation === request) this.invitation = null;
    return true;
  }

  async terminateAll(outcome = "application-exit") {
    this.terminating = true;
    try {
      let request;
      while ((request = this.requests.currentRequest
          ?? this.requests.takeForTermination())) {
        await this.finish(request, "canceled", outcome);
      }
      this.invitation = null;
      return true;
    } catch (error) {
      this.terminating = false;
      throw error;
    }
  }

  async finish(request, status, outcome) {
    if (!TERMINAL.has(status)) throw new TypeError("invalid external open outcome");
    this.#requireActive(request);
    const existing = this.finishing.get(request.token);
    if (existing) return existing;
    const finishing = (async () => {
      await this.acknowledge(request, status, 3);
      this.requests.complete(request.token);
      try { await this.record(request, outcome); }
      finally { if (!this.terminating) void this.drain(); }
    })();
    this.finishing.set(request.token, finishing);
    try { return await finishing; }
    finally { this.finishing.delete(request.token); }
  }

  #requireActive(request) {
    if (!request || this.requests.current(request.token) !== request) {
      throw new Error("The external open request is no longer active");
    }
  }
}
