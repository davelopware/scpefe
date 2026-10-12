/** The renderer side of the mounted lifecycle completion boundary. */
export interface RendererLifecycleBoundary {
  readonly pendingCount?: number;
  waitForIdle(): Promise<void>;
}

/* Waits for the whole mounted lifecycle boundary, including host work. */
export class MountedLifecycleCompletion {
  readonly renderer: RendererLifecycleBoundary;
  readonly pending = new Map<Promise<unknown>, { label: string; started: number }>();
  version = 0;

  constructor({ renderer }: { renderer: RendererLifecycleBoundary }) {
    this.renderer = renderer;
  }

  track<T>(label: string, operation: () => T | Promise<T>): Promise<T> {
    let promise: Promise<T>;
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

  async waitForIdle({ timeoutMs = 5_000 }: { timeoutMs?: number } = {}): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive finite number");
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
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
      if (timeout) clearTimeout(timeout);
    }
  }

  async #waitUntilIdle(): Promise<void> {
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
