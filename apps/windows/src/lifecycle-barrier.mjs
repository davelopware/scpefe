import { AsyncLocalStorage } from "node:async_hooks";

/* Serializes lifecycle abandonment against all queued and active maintenance work. */
export class LifecycleBarrier {
  constructor() {
    this.context = new AsyncLocalStorage();
    this.activeOwner = null;
    this.queue = [];
    this.readers = 0;
    this.writer = false;
    this.maintenance = 0;
    this.generation = 0;
  }

  runMaintenance(operation) {
    if (this.#ownsExclusive()) return this.#runOwned(operation);
    this.maintenance += 1;
    this.generation += 1;
    return this.#enqueue("reader", operation).finally(() => {
      this.maintenance -= 1;
      this.generation += 1;
    });
  }

  runExclusive(operation) {
    if (this.#ownsExclusive()) return this.#runOwned(operation);
    this.generation += 1;
    const owner = { pending: new Set() };
    return this.#enqueue("writer", () => {
      this.activeOwner = owner;
      return this.context.run(owner, async () => {
        try { return await operation(); }
        finally {
          // Reentrant work remains owned even when its caller did not await it.
          while (owner.pending.size > 0) {
            await Promise.allSettled([...owner.pending]);
          }
          if (this.activeOwner === owner) this.activeOwner = null;
        }
      });
    })
      .finally(() => { this.generation += 1; });
  }

  get hasMaintenance() { return this.maintenance > 0; }

  #ownsExclusive() {
    return this.writer && this.activeOwner !== null
      && this.context.getStore() === this.activeOwner;
  }

  #runOwned(operation) {
    const owner = this.activeOwner;
    const pending = Promise.resolve().then(operation);
    owner.pending.add(pending);
    void pending.finally(() => owner.pending.delete(pending)).catch(() => {});
    return pending;
  }

  #enqueue(kind, operation) {
    return new Promise((resolve, reject) => {
      this.queue.push({ kind, operation, resolve, reject });
      this.#drain();
    });
  }

  #drain() {
    if (this.writer || this.queue.length === 0) return;
    if (this.queue[0].kind === "writer") {
      if (this.readers !== 0) return;
      const item = this.queue.shift();
      this.writer = true;
      Promise.resolve().then(item.operation).then(item.resolve, item.reject).finally(() => {
        this.writer = false; this.#drain();
      });
      return;
    }
    while (this.queue[0]?.kind === "reader" && !this.writer) {
      const item = this.queue.shift();
      this.readers += 1;
      Promise.resolve().then(item.operation).then(item.resolve, item.reject).finally(() => {
        this.readers -= 1; this.#drain();
      });
    }
  }
}
