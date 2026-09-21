import { AsyncLocalStorage } from "node:async_hooks";

/* Serializes lifecycle abandonment against all queued and active maintenance work. */
export class LifecycleBarrier {
  constructor() {
    this.context = new AsyncLocalStorage();
    this.queue = [];
    this.readers = 0;
    this.writer = false;
    this.maintenance = 0;
    this.generation = 0;
  }

  runMaintenance(operation) {
    if (this.context.getStore() === this) return Promise.resolve().then(operation);
    this.maintenance += 1;
    this.generation += 1;
    return this.#enqueue("reader", operation).finally(() => {
      this.maintenance -= 1;
      this.generation += 1;
    });
  }

  runExclusive(operation) {
    if (this.context.getStore() === this) return Promise.resolve().then(operation);
    this.generation += 1;
    return this.#enqueue("writer", () => this.context.run(this, operation))
      .finally(() => { this.generation += 1; });
  }

  get hasMaintenance() { return this.maintenance > 0; }

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
