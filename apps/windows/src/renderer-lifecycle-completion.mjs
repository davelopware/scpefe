export const RENDERER_LIFECYCLE_COMPLETION =
  Symbol.for("scpefe.renderer.lifecycle-completion");

/* Tracks renderer lifecycle work so mounted clients can await safe teardown. */
export class RendererLifecycleCompletion {
  #inFlight = new Set();

  track(operation) {
    if (typeof operation !== "function") throw new TypeError("operation must be a function");
    let promise;
    try { promise = Promise.resolve(operation()); }
    catch (error) { promise = Promise.reject(error); }
    this.#inFlight.add(promise);
    void promise.finally(() => this.#inFlight.delete(promise)).catch(() => {});
    return promise;
  }

  async waitForIdle({ timeoutMs = 5_000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive finite number");
    }
    let timeout;
    const expired = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(Object.assign(
        new Error(`Renderer lifecycle work did not finish within ${timeoutMs} ms`),
        { code: "RENDERER_LIFECYCLE_TIMEOUT" })), timeoutMs);
    });
    try {
      await Promise.race([this.#waitUntilIdle(), expired]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async #waitUntilIdle() {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
      await Promise.resolve();
    }
  }
}
