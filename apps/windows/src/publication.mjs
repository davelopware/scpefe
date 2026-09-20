import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readIfPresent(fs, file) {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

const REPLACEMENT_GUARANTEES = new Set([
  "atomic-replace", "best-effort-replace",
]);

function validateCapabilities(value) {
  if (!value || typeof value !== "object"
      || value.sameFilesystemTransaction !== true
      || !REPLACEMENT_GUARANTEES.has(value.replacementGuarantee)) {
    throw new TypeError("invalid host publication capabilities");
  }
  return Object.freeze({ sameFilesystemTransaction: true,
    replacementGuarantee: value.replacementGuarantee });
}

function publicationError(error) {
  if (error && typeof error === "object") {
    error.publicationPrepared = true;
    return error;
  }
  const wrapped = new Error("Publication failed after preparation may have persisted");
  wrapped.cause = error;
  wrapped.publicationPrepared = true;
  return wrapped;
}

/* Tracks and completes crash-safe candidate-container publication. */
export class PublicationService {
  constructor({ fs, journals, capabilities, now = () => Date.now() }) {
    this.fs = fs;
    this.journals = journals;
    this.now = now;
    this.capabilities = validateCapabilities(capabilities);
  }

  replacementCapabilities() {
    return this.capabilities;
  }

  async prepare({ documentId, journalKey, target, base, candidate, text, cursor,
    baseRevision }) {
    const id = randomBytes(16).toString("hex");
    const transactionFile = path.join(path.dirname(target),
      `.${path.basename(target)}.scpefe-txn-${id}`);
    const record = {
      text,
      baseRevision,
      cursor: { ...cursor },
      target,
      state: "pending-publication",
      updateTime: this.now(),
      publication: {
        id, target, transactionFile,
        candidateHash: hash(candidate),
        baseHash: hash(base),
        base: base.toString("base64"),
        candidate: candidate.toString("base64"),
        stage: "prepared",
      },
    };
    await this.journals.write(documentId, journalKey, record);
    return record;
  }

  async publish({ documentId, journalKey, target, base, candidate, text, cursor,
    baseRevision }) {
    let record;
    try {
      record = await this.prepare({ documentId, journalKey, target, base,
        candidate, text, cursor, baseRevision });
      record = await this.#complete(documentId, journalKey, record);
      return { completed: true, record,
        replacementCapabilities: this.capabilities };
    } catch (error) {
      throw publicationError(error);
    }
  }

  async resume(documentId, journalKey, record) {
    if (!record?.publication) return { completed: false, reason: "none" };
    const publication = record.publication;
    const candidate = Buffer.from(publication.candidate, "base64");
    if (hash(candidate) !== publication.candidateHash
        || path.dirname(publication.transactionFile) !== path.dirname(publication.target)) {
      return { completed: false, reason: "ambiguous",
        replacementCapabilities: this.capabilities };
    }
    const transaction = await readIfPresent(this.fs, publication.transactionFile);
    if (transaction && hash(transaction) !== publication.candidateHash) {
      return { completed: false, reason: "ambiguous",
        replacementCapabilities: this.capabilities };
    }
    const target = await readIfPresent(this.fs, publication.target);
    if (target && hash(target) === publication.candidateHash) {
      await this.#cleanup(documentId, journalKey, record);
      return { completed: true, recovered: true,
        replacementCapabilities: this.capabilities };
    }
    if (!target) {
      return { completed: false, reason: "unavailable",
        replacementCapabilities: this.capabilities };
    }
    if (hash(target) !== publication.baseHash) {
      return { completed: false, reason: "changed",
        replacementCapabilities: this.capabilities };
    }
    await this.#complete(documentId, journalKey, record);
    return { completed: true, recovered: true,
      replacementCapabilities: this.capabilities };
  }

  async markDiverged(documentId, journalKey, record) {
    const diverged = { ...record, state: "conflict", updateTime: this.now() };
    await this.journals.write(documentId, journalKey, diverged);
    return diverged;
  }

  async discard(documentId, journalKey, record) {
    if (!record?.publication) throw new Error("No pending publication is available");
    const transaction = await readIfPresent(this.fs, record.publication.transactionFile);
    if (transaction && hash(transaction) === record.publication.candidateHash) {
      await this.fs.unlink(record.publication.transactionFile);
    }
    await this.journals.clear(documentId);
  }

  async #complete(documentId, journalKey, initialRecord) {
    let record = initialRecord;
    const publication = record.publication;
    const candidate = Buffer.from(publication.candidate, "base64");
    let handle;
    try {
      const transaction = await readIfPresent(this.fs, publication.transactionFile);
      if (!transaction) {
        handle = await this.fs.open(publication.transactionFile, "wx", 0o600);
        await handle.writeFile(candidate);
        record = await this.#stage(documentId, journalKey, record, "written");
      } else if (hash(transaction) !== publication.candidateHash) {
        throw new Error("Tracked transaction file does not match its candidate");
      } else {
        handle = await this.fs.open(publication.transactionFile, "r+");
      }
      await handle.sync();
      await handle.close();
      handle = null;
      record = await this.#stage(documentId, journalKey, record, "flushed");

      const current = await readIfPresent(this.fs, publication.target);
      if (!current || hash(current) !== publication.baseHash) {
        throw new Error("Publication target changed; recovery data was preserved");
      }
      await this.fs.rename(publication.transactionFile, publication.target);
      record = await this.#stage(documentId, journalKey, record, "replaced");

      const published = await this.fs.readFile(publication.target);
      if (hash(published) !== publication.candidateHash) {
        throw new Error("Published container verification failed");
      }
      record = await this.#stage(documentId, journalKey, record, "verified");
      await this.#cleanup(documentId, journalKey, record);
      return record;
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      throw error;
    }
  }

  async #stage(documentId, journalKey, record, stage) {
    const updated = { ...record,
      publication: { ...record.publication, stage },
      updateTime: this.now() };
    await this.journals.write(documentId, journalKey, updated);
    return updated;
  }

  async #cleanup(documentId, journalKey, initialRecord) {
    const record = initialRecord.publication.stage === "cleanup" ? initialRecord
      : await this.#stage(documentId, journalKey, initialRecord, "cleanup");
    const transaction = await readIfPresent(this.fs, record.publication.transactionFile);
    if (transaction && hash(transaction) === record.publication.candidateHash) {
      await this.fs.unlink(record.publication.transactionFile);
    }
    await this.journals.clear(documentId);
  }
}
