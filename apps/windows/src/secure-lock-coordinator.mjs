/* Coordinates authoritative locking with disposal of every staged secret workflow. */
export class SecureLockCoordinator {
  constructor({ getService, replacements, creationFlow, clearOpenTarget,
    rememberLockedTarget, emitLocked }) {
    this.getService = getService;
    this.replacements = replacements;
    this.creationFlow = creationFlow;
    this.clearOpenTarget = clearOpenTarget;
    this.rememberLockedTarget = rememberLockedTarget;
    this.emitLocked = emitLocked;
    this.inFlight = null;
    this.lockingService = null;
  }

  async lock(reason) {
    if (this.inFlight) return this.inFlight;
    const service = this.getService();
    this.lockingService = service;
    this.inFlight = (async () => {
      this.#rememberTarget(service);
      await this.#disposeStagedWorkflows();
      const result = await service.lock(reason);
      this.emitLocked(result);
      return result;
    })();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
      this.lockingService = null;
    }
  }

  async serviceLocked(service, result) {
    if (service === this.lockingService) return;
    if (service !== this.getService()) {
      if (this.replacements.hasStagedCandidate(service)) {
        await this.lock(result.reason ?? "inactivity");
      }
      return;
    }
    this.#rememberTarget(service);
    await this.#disposeStagedWorkflows();
    this.emitLocked(result);
  }

  #rememberTarget(service) {
    this.rememberLockedTarget(service.active?.target ?? null);
  }

  async #disposeStagedWorkflows() {
    this.creationFlow.cancel();
    this.clearOpenTarget();
    await this.replacements.cancelClaim();
  }
}
