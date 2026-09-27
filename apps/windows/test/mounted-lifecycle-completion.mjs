/* Waits for the whole mounted lifecycle boundary, including host work. */
export class MountedLifecycleCompletion {
  constructor({ renderer }) {
    this.renderer = renderer;
    this.pending = new Map();
    this.version = 0;
  }

  track(label, operation) {
    let promise;
    try { promise = Promise.resolve(operation()); }
    catch (error) { promise = Promise.reject(error); }
    this.pending.set(promise, { label, started: performance.now() });
    this.version += 1;
    void promise.finally(() => {
      this.pending.delete(promise);
      this.version += 1;
    }).catch(() => {});
    return promise;
  }

  async waitForIdle({ timeoutMs = 5_000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive finite number");
    }
    let timeout;
    const expired = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const host = [...this.pending.values()].map(({ label, started }) =>
          `${label}:${Math.round(performance.now() - started)}ms`).join(", ") || "none";
        const renderer = this.renderer.pendingCount ?? "unknown";
        reject(Object.assign(new Error(
          `Mounted lifecycle work did not finish within ${timeoutMs} ms; `
          + `renderer=${renderer}; host=[${host}]`),
        { code: "RENDERER_LIFECYCLE_TIMEOUT" }));
      }, timeoutMs);
    });
    try {
      await Promise.race([this.#waitUntilIdle(), expired]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async #waitUntilIdle() {
    while (true) {
      const version = this.version;
      await Promise.all([
        this.renderer.waitForIdle(),
        Promise.allSettled([...this.pending.keys()]),
      ]);
      await new Promise((resolve) => setImmediate(resolve));
      await this.renderer.waitForIdle();
      if (this.version === version && this.pending.size === 0) return;
    }
  }
}
