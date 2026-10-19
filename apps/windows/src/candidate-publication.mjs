import { createHash } from "node:crypto";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/* Coordinates a retained native candidate with its journaled target publication. */
export class CandidatePublication {
  #pendingOperationId = null;
  #ambiguousNotified = false;
  #candidateHash = null;

  constructor(publications) {
    this.publications = publications;
  }

  get pendingOperationId() {
    return this.#pendingOperationId;
  }

  track(operationId) {
    if (operationId !== null && (!Number.isSafeInteger(operationId)
        || (this.#pendingOperationId !== null
          && this.#pendingOperationId !== operationId))) {
      throw new Error("Resolve the pending candidate before preparing another one");
    }
    if (operationId !== this.#pendingOperationId) {
      this.#candidateHash = null;
      this.#ambiguousNotified = false;
    }
    this.#pendingOperationId = operationId;
  }

  finish(container, operationId, outcome) {
    if (operationId === null) return { verified: false, effects: 0 };
    if (this.#pendingOperationId !== operationId) {
      throw new Error("Native candidate operation does not match the pending publication");
    }
    if (outcome === "ambiguous" && this.#ambiguousNotified) {
      return { verified: false, effects: 0 };
    }
    const effects = container.finishSave(operationId, outcome);
    if (outcome === "ambiguous") this.#ambiguousNotified = true;
    if (outcome !== "ambiguous") this.track(null);
    return { verified: outcome === "verified", effects };
  }

  resolve(container, published) {
    if (this.#pendingOperationId === null) return { published: false, effects: 0 };
    const effects = container.resolveSave(this.#pendingOperationId, published);
    this.track(null);
    return { published, effects };
  }

  async #settle(container, prepared, operation) {
    if (this.#pendingOperationId !== prepared.operationId
        || !Buffer.isBuffer(prepared.bytes) || prepared.bytes.length === 0) {
      throw new Error("Native bridge did not return the retained candidate");
    }
    const candidateHash = hash(prepared.bytes);
    if (this.#candidateHash && this.#candidateHash !== candidateHash) {
      throw new Error("Native candidate bytes changed during publication");
    }
    this.#candidateHash = candidateHash;
    try {
      const result = await operation();
      return result;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      // A prior conflict may already have a publication record. Only a record
      // for this exact candidate proves that its preparation persisted; an
      // unreadable journal remains ambiguous.
      try {
        const record = await this.publications.journals.read(
          prepared.documentId, prepared.journalKey);
        if (record?.publication) {
          failure.publicationPrepared = record.publication.candidate
            === prepared.bytes.toString("base64");
        }
      } catch {
        failure.publicationPrepared = true;
      }
      this.finish(container, prepared.operationId,
        failure.publicationPrepared ? "ambiguous" : "definite-failure");
      throw failure;
    }
  }

  async publish(container, prepared, request) {
    const candidate = prepared.bytes;
    const identity = { ...prepared, documentId: request.documentId,
      journalKey: request.journalKey };
    const result = await this.#settle(container, identity, () =>
      this.publications.publish({ ...request, candidate }));
    const native = this.finish(container, prepared.operationId, "verified");
    return { ...result, nativeEffects: native.effects };
  }

  async journalUnavailable(container, prepared, request) {
    const identity = { ...prepared, documentId: request.documentId,
      journalKey: request.journalKey };
    const record = await this.#settle(container, identity, () =>
      this.publications.prepare({ ...request, candidate: prepared.bytes }));
    this.finish(container, prepared.operationId, "ambiguous");
    return record;
  }

  async resume(documentId, journalKey, record, container = null) {
    if (container && this.#candidateHash
        && this.#candidateHash !== hash(Buffer.from(
          record.publication.candidate, "base64"))) {
      return { completed: false, reason: "ambiguous" };
    }
    const result = await this.publications.resume(documentId, journalKey, record);
    if (container && result.completed) {
      const native = this.resolve(container, true);
      result.nativeAdopted = native.published;
      result.nativeEffects = native.effects;
    } else if (container && result.reason === "changed") {
      this.resolve(container, false);
    }
    return result;
  }
}
