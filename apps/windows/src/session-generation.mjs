/* Invalidates asynchronous session work synchronously when locking begins. */
export class SessionGeneration {
  constructor() { this.value = 0; }

  capture() { return this.value; }

  invalidate() {
    this.value += 1;
    return this.value;
  }

  isCurrent(captured) { return captured === this.value; }

  assertCurrent(captured) {
    if (this.isCurrent(captured)) return;
    const error = new Error("The session locked while the operation was running; no replacement was adopted");
    error.code = "DOCUMENT_SESSION_INVALIDATED";
    throw error;
  }
}
