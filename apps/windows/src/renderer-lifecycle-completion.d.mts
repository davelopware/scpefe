export const RENDERER_LIFECYCLE_COMPLETION: symbol;

/** Tracks renderer lifecycle work and exposes bounded idle synchronization. */
export class RendererLifecycleCompletion {
  track<T>(operation: () => T | Promise<T>): Promise<T>;
  waitForIdle(options?: { timeoutMs?: number }): Promise<void>;
}
