const TERMINAL = new Set(["opened", "canceled", "failed"]);

/* Completes authenticated external-open requests only after their final outcome is known. */
export class ExternalOpenLifecycle {
  constructor({ requests, acknowledge, record = async () => {}, drain }) {
    this.requests = requests;
    this.acknowledge = acknowledge;
    this.record = record;
    this.drain = drain;
    this.invitation = null;
    this.finishing = new Set();
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

  async finish(request, status, outcome) {
    if (!TERMINAL.has(status)) throw new TypeError("invalid external open outcome");
    this.#requireActive(request);
    if (this.finishing.has(request.token)) {
      throw new Error("The external open request is already finishing");
    }
    this.finishing.add(request.token);
    try {
      await this.acknowledge(request, status, 3);
      this.requests.complete(request.token);
      try { await this.record(request, outcome); }
      finally { void this.drain(); }
    } finally { this.finishing.delete(request.token); }
  }

  #requireActive(request) {
    if (!request || this.requests.current(request.token) !== request) {
      throw new Error("The external open request is no longer active");
    }
  }
}
