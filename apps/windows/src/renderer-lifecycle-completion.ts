export const RENDERER_LIFECYCLE_COMPLETION =
  Symbol.for("scpefe.renderer.lifecycle-completion");

/** Session work that can still change the result of a lifecycle transition. */
export interface LifecycleSessionSource {
  getPendingWorkCount(): number;
  subscribe(listener: () => void): () => void;
}

/** Tracks renderer and session work so mounted clients can await safe teardown. */
export class RendererLifecycleCompletion {
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly waiters = new Set<() => void>();
  private source: LifecycleSessionSource | null = null;
  private stopSource: (() => void) | null = null;

  get pendingCount(): number {
    return this.inFlight.size + (this.source?.getPendingWorkCount() ?? 0);
  }

  /** Connects the current mounted session to the same idle boundary. */
  setSessionSource(source: LifecycleSessionSource | null): void {
    this.stopSource?.();
    this.source = source;
    this.stopSource = source?.subscribe(() => this.notify()) ?? null;
    this.notify();
  }

  track<T>(operation: () => T | Promise<T>): Promise<T> {
    if (typeof operation !== "function") throw new TypeError("operation must be a function");
    let promise: Promise<T>;
    try { promise = Promise.resolve(operation()); }
    catch (error) { promise = Promise.reject(error); }
    this.inFlight.add(promise);
    void promise.finally(() => {
      this.inFlight.delete(promise);
      this.notify();
    }).catch(() => {});
    this.notify();
    return promise;
  }

  async waitForIdle({ timeoutMs = 5_000 }: { timeoutMs?: number } = {}): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive finite number");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Object.assign(
      new Error(`Renderer lifecycle work did not finish within ${timeoutMs} ms`),
      { code: "RENDERER_LIFECYCLE_TIMEOUT" })), timeoutMs);
    try {
      while (this.pendingCount > 0) {
        await this.waitForChange(controller.signal);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private waitForChange(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const changed = () => { cleanup(); resolve(); };
      const aborted = () => { cleanup(); reject(signal.reason); };
      const cleanup = () => {
        this.waiters.delete(changed);
        signal.removeEventListener("abort", aborted);
      };
      this.waiters.add(changed);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      else if (this.pendingCount === 0) changed();
    });
  }

  private notify(): void { for (const waiter of [...this.waiters]) waiter(); }
}
