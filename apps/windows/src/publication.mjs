import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { classifyTargetImage, readDocumentTarget, validateOpaqueTarget,
  validateTargetCapabilities } from "./document-target.mjs";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function recoveryBasePath(target) {
  return path.join(path.dirname(target), `.${path.basename(target)}.scpefe-recovery-base`);
}

async function readIfPresent(fs, file) {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function collisionTarget(target, collision) {
  if (collision === 0) return target;
  const extension = path.extname(target);
  const stem = extension ? target.slice(0, -extension.length) : target;
  return `${stem}-${collision}${extension}`;
}

async function sameFile(fs, left, right) {
  try {
    const [leftStat, rightStat] = await Promise.all([
      fs.stat(left), fs.stat(right),
    ]);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

const REPLACEMENT_GUARANTEES = new Set([
  "atomic-replace", "best-effort-replace",
]);
const UNAVAILABLE_CODES = new Set([
  "ENOENT", "ENOTDIR", "EACCES", "EIO", "ENODEV", "ESTALE", "ETIMEDOUT",
  "ECONNRESET",
]);

function targetUnavailable(error) {
  return UNAVAILABLE_CODES.has(error?.code);
}

function validateCapabilities(value) {
  if (!value || typeof value !== "object"
      || value.sameFilesystemTransaction !== true
      || !REPLACEMENT_GUARANTEES.has(value.replacementGuarantee)) {
    throw new TypeError("invalid host publication capabilities");
  }
  return Object.freeze({ sameFilesystemTransaction: true,
    replacementGuarantee: value.replacementGuarantee });
}

function missingPath(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function fileIdentity(stat) {
  if (!stat || stat.dev === undefined || stat.ino === undefined) return null;
  if (String(stat.dev) === "0" && String(stat.ino) === "0") return null;
  return `${String(stat.dev)}:${String(stat.ino)}`;
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
  constructor({ fs, journals, capabilities, now = () => Date.now(),
    platform = process.platform, documentTargets = null }) {
    this.fs = fs;
    this.journals = journals;
    this.now = now;
    this.documentTargets = documentTargets;
    if (documentTargets) validateTargetCapabilities(documentTargets.capabilities);
    this.capabilities = capabilities === undefined && documentTargets
      ? null : validateCapabilities(capabilities);
    this.caseInsensitivePaths = platform === "win32";
  }

  #isOpaque(target) {
    return this.documentTargets?.owns(target) === true;
  }

  async #observeOpaque(target, base, candidate) {
    try {
      return classifyTargetImage(await readDocumentTarget(this.documentTargets, target),
        base, candidate);
    } catch (error) {
      if (targetUnavailable(error)) return "unavailable";
      throw error;
    }
  }

  async #completeOpaque(documentId, journalKey, record) {
    const publication = record.publication;
    const target = validateOpaqueTarget(publication.target);
    const base = Buffer.from(publication.base, "base64");
    const candidate = Buffer.from(publication.candidate, "base64");
    if (!this.#isOpaque(target) || record.target !== target
        || hash(base) !== publication.baseHash
        || hash(candidate) !== publication.candidateHash) {
      return { completed: false, reason: "ambiguous" };
    }
    const before = await this.#observeOpaque(target, base, candidate);
    if (before === "verified") {
      await this.#cleanupOpaque(documentId, journalKey, record);
      return { completed: true, recovered: true };
    }
    if (before !== "unchanged") return { completed: false, reason: before };
    let outcome;
    try {
      outcome = await this.documentTargets.publish(target, base, candidate);
    } catch {
      outcome = "ambiguous";
    }
    if (!["verified", "definite-failure", "ambiguous"].includes(outcome)) {
      throw new TypeError("invalid host target publication outcome");
    }
    const after = await this.#observeOpaque(target, base, candidate);
    if (after === "verified") {
      await this.#cleanupOpaque(documentId, journalKey, record);
      return { completed: true };
    }
    if (after === "changed") return { completed: false, reason: "changed" };
    if (outcome === "definite-failure" && after === "unchanged") {
      return { completed: false, reason: "definite-failure" };
    }
    return { completed: false, reason: "ambiguous" };
  }

  async #cleanupOpaque(documentId, journalKey, record) {
    if (record.activity) {
      const { publication: _publication, ...pendingActivity } = record;
      await this.journals.write(documentId, journalKey, pendingActivity);
    } else if (record.publication.preserveWork) {
      await this.journals.write(documentId, journalKey, {
        text: record.text, baseRevision: record.baseRevision,
        cursor: record.cursor, target: record.target, state: "unsaved",
        updateTime: record.updateTime });
    } else await this.journals.clear(documentId);
  }

  replacementCapabilities() {
    return this.capabilities ?? this.documentTargets.capabilities;
  }

  #comparablePath(value) {
    const resolved = path.resolve(value);
    return this.caseInsensitivePaths ? resolved.toLocaleLowerCase("en-US") : resolved;
  }

  async #pathIdentity(value) {
    const lexical = this.#comparablePath(value);
    let canonical;
    let stat;
    try {
      canonical = this.#comparablePath(await this.fs.realpath(value));
      stat = await this.fs.stat(value);
    } catch (error) {
      if (!missingPath(error)) throw error;
      const directory = path.dirname(value);
      canonical = this.#comparablePath(path.join(
        await this.fs.realpath(directory), path.basename(value)));
      stat = null;
    }
    return { lexical, canonical, file: fileIdentity(stat) };
  }

  /* Rejects lexical, resolved-path, and inode aliases of the encrypted target. */
  async assertDistinctPlaintextTarget(target, protectedTarget) {
    const [candidate, protectedFile] = await Promise.all([
      this.#pathIdentity(target), this.#pathIdentity(protectedTarget),
    ]);
    if (candidate.lexical === protectedFile.lexical
        || candidate.canonical === protectedFile.canonical
        || (candidate.file !== null && candidate.file === protectedFile.file)) {
      throw new Error("Plaintext export cannot replace or alias the active encrypted container");
    }
  }

  async publishPlaintext({ target, content, protectedTarget }) {
    if (typeof target !== "string" || target.length === 0 || target.includes("\0")
        || typeof protectedTarget !== "string" || protectedTarget.length === 0
        || protectedTarget.includes("\0") || !Buffer.isBuffer(content)) {
      throw new TypeError(
        "plaintext publication requires valid destination, protected target, and bytes");
    }
    await this.assertDistinctPlaintextTarget(target, protectedTarget);
    const transactionFile = path.join(path.dirname(target),
      `.${path.basename(target)}.scpefe-plaintext-txn-${randomBytes(16).toString("hex")}`);
    let handle;
    let replacementAttempted = false;
    try {
      handle = await this.fs.open(transactionFile, "wx", 0o600);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = null;
      await this.assertDistinctPlaintextTarget(target, protectedTarget);
      replacementAttempted = true;
      await this.fs.rename(transactionFile, target);
      return { completed: true };
    } catch (error) {
      let replacementMayHaveOccurred = false;
      if (replacementAttempted) {
        // An absent staging file after rename starts leaves replacement uncertain.
        try { await this.fs.lstat(transactionFile); }
        catch { replacementMayHaveOccurred = true; }
      }
      if (handle) await handle.close().catch(() => {});
      await this.fs.unlink(transactionFile).catch(() => {});
      if (replacementMayHaveOccurred) {
        const uncertain = new Error("Plaintext replacement outcome requires confirmation",
          { cause: error });
        uncertain.plaintextReplacementMayHaveOccurred = true;
        throw uncertain;
      }
      throw error;
    }
  }

  async publishReplica({ target, candidate, returnVerifiedBytes = false }) {
    if (!Buffer.isBuffer(candidate) || candidate.length === 0) {
      throw new TypeError("backup candidate must contain container bytes");
    }
    const id = randomBytes(16).toString("hex");
    const transactionFile = path.join(path.dirname(target),
      `.${path.basename(target)}.scpefe-backup-txn-${id}`);
    let handle;
    let publishedTarget;
    try {
      handle = await this.fs.open(transactionFile, "wx", 0o600);
      await handle.writeFile(candidate);
      await handle.sync();
      await handle.close();
      handle = null;

      for (let collision = 0; ; collision += 1) {
        const proposed = collisionTarget(target, collision);
        try {
          await this.fs.link(transactionFile, proposed);
          publishedTarget = proposed;
          break;
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
      }

      handle = await this.fs.open(publishedTarget, "r+");
      await handle.sync();
      await handle.close();
      handle = null;
      const published = await this.fs.readFile(publishedTarget);
      if (!published.equals(candidate)) {
        throw new Error("Backup replica verification failed");
      }
      await this.fs.unlink(transactionFile);
      return returnVerifiedBytes
        ? { completed: true, verifiedBytes: published }
        : { completed: true };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (publishedTarget
          && await sameFile(this.fs, publishedTarget, transactionFile).catch(() => false)) {
        await this.fs.unlink(publishedTarget).catch(() => {});
      }
      await this.fs.unlink(transactionFile).catch(() => {});
      throw error;
    }
  }

  async prepare({ documentId, journalKey, target, base, candidate, text, cursor,
    baseRevision, purpose, reopenPassword, mergeAncestor,
    preserveWork = false,
    state = "pending-publication", journalRecord = null }) {
    const id = randomBytes(16).toString("hex");
    const opaque = this.#isOpaque(target);
    const transactionFile = opaque ? null : path.join(path.dirname(target),
      `.${path.basename(target)}.scpefe-txn-${id}`);
    const record = {
      ...(journalRecord ?? {}),
      text,
      baseRevision,
      cursor: { ...cursor },
      target,
      state,
      updateTime: this.now(),
      publication: {
        id, target, ...(opaque ? { kind: "host-target" } : { transactionFile }),
        candidateHash: hash(candidate),
        baseHash: hash(base),
        base: base.toString("base64"),
        ...(mergeAncestor ? {
          mergeAncestorHash: hash(mergeAncestor),
          mergeAncestor: mergeAncestor.toString("base64"),
        } : {}),
        ...(!opaque ? { baseFile: recoveryBasePath(target) } : {}),
        candidate: candidate.toString("base64"),
        stage: "prepared",
        ...(purpose ? { purpose } : {}),
        ...(preserveWork ? { preserveWork: true } : {}),
        ...(reopenPassword ? { reopenPassword } : {}),
      },
    };
    await this.journals.write(documentId, journalKey, record);
    return record;
  }

  async publish({ documentId, journalKey, target, base, candidate, text, cursor,
    baseRevision, purpose, reopenPassword, mergeAncestor, preserveWork, state,
    journalRecord }) {
    let record;
    const priorRecord = this.#isOpaque(target)
      ? await this.journals.read(documentId, journalKey) : null;
    try {
      record = await this.prepare({ documentId, journalKey, target, base,
        candidate, text, cursor, baseRevision, purpose, reopenPassword,
        mergeAncestor, preserveWork, state, journalRecord });
      if (record.publication.kind === "host-target") {
        const result = await this.#completeOpaque(documentId, journalKey, record);
        if (!result.completed) {
          const failure = new Error(`Host target publication ${result.reason}`);
          failure.code = `TARGET_PUBLICATION_${result.reason.toUpperCase().replaceAll("-", "_")}`;
          failure.definitePublicationFailure = result.reason === "definite-failure";
          if (failure.definitePublicationFailure) {
            if (priorRecord) await this.journals.write(documentId, journalKey, priorRecord);
            else await this.journals.clear(documentId);
          }
          throw failure;
        }
        return { completed: true, record,
          replacementCapabilities: this.documentTargets.capabilities };
      }
      record = await this.#complete(documentId, journalKey, record);
      return { completed: true, record,
        replacementCapabilities: this.capabilities };
    } catch (error) {
      if (error?.definitePublicationFailure) throw error;
      if (!record) {
        const persisted = await this.journals.read(documentId, journalKey).catch(() => null);
        if (!persisted?.publication) throw error;
      }
      throw publicationError(error);
    }
  }

  async resume(documentId, journalKey, record) {
    if (!record?.publication) return { completed: false, reason: "none" };
    const publication = record.publication;
    if (publication.kind === "host-target") {
      return { ...await this.#completeOpaque(documentId, journalKey, record),
        replacementCapabilities: this.documentTargets.capabilities };
    }
    const candidate = Buffer.from(publication.candidate, "base64");
    if (hash(candidate) !== publication.candidateHash
        || path.dirname(publication.transactionFile) !== path.dirname(publication.target)
        || publication.baseFile !== recoveryBasePath(publication.target)) {
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
    if (record.activity) throw new Error(
      "Pending activity publication must be reconciled");
    if (record.publication.kind === "host-target") {
      if (record.publication.preserveWork) {
        await this.journals.write(documentId, journalKey, {
          text: record.text, baseRevision: record.baseRevision,
          cursor: record.cursor, target: record.target, state: "unsaved",
          updateTime: record.updateTime });
      } else await this.journals.clear(documentId);
      return;
    }
    let transaction;
    try {
      transaction = await readIfPresent(this.fs, record.publication.transactionFile);
    } catch (error) {
      if (!targetUnavailable(error)) throw error;
    }
    if (transaction && hash(transaction) === record.publication.candidateHash) {
      try {
        await this.fs.unlink(record.publication.transactionFile);
      } catch (error) {
        if (!targetUnavailable(error)) throw error;
      }
    }
    if (record.publication.preserveWork) {
      await this.journals.write(documentId, journalKey, {
        text: record.text, baseRevision: record.baseRevision,
        cursor: record.cursor, target: record.target, state: "unsaved",
        updateTime: record.updateTime,
      });
    } else {
      await this.journals.clear(documentId);
    }
    const recoveryBase = await readIfPresent(this.fs, record.publication.baseFile);
    if (recoveryBase && hash(recoveryBase) === record.publication.baseHash) {
      await this.fs.unlink(record.publication.baseFile);
    }
  }

  async readRecoveryBase(target) {
    if (this.#isOpaque(target)) return null;
    return readIfPresent(this.fs, recoveryBasePath(target));
  }

  async cleanupOrphanedRecoveryBase(target) {
    if (this.#isOpaque(target)) return;
    const recoveryBase = await readIfPresent(this.fs, recoveryBasePath(target));
    if (recoveryBase) await this.fs.unlink(recoveryBasePath(target));
  }

  async #complete(documentId, journalKey, initialRecord) {
    let record = initialRecord;
    const publication = record.publication;
    const candidate = Buffer.from(publication.candidate, "base64");
    let handle;
    try {
      let recoveryBase = await readIfPresent(this.fs, publication.baseFile);
      if (recoveryBase && hash(recoveryBase) !== publication.baseHash) {
        const currentBase = await readIfPresent(this.fs, publication.target);
        if (!currentBase || hash(currentBase) !== publication.baseHash) {
          throw new Error("Tracked recovery base does not match its publication");
        }
        await this.fs.unlink(publication.baseFile);
        recoveryBase = null;
      }
      if (!recoveryBase) {
        const currentBase = await readIfPresent(this.fs, publication.target);
        if (!currentBase || hash(currentBase) !== publication.baseHash) {
          throw new Error("Publication base is unavailable for crash recovery");
        }
        handle = await this.fs.open(publication.baseFile, "wx", 0o600);
        await handle.writeFile(currentBase);
        await handle.sync();
        await handle.close();
        handle = null;
      }
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
    // Keep the publication record until every fallible file cleanup finishes.
    // A failed recovery-base unlink can then be retried against the verified target.
    const recoveryBase = await readIfPresent(this.fs, record.publication.baseFile);
    if (recoveryBase && hash(recoveryBase) === record.publication.baseHash) {
      await this.fs.unlink(record.publication.baseFile);
    }
    if (record.activity) {
      const { publication: _publication, ...pendingActivity } = record;
      await this.journals.write(documentId, journalKey, pendingActivity);
    } else if (record.publication.preserveWork) {
      await this.journals.write(documentId, journalKey, {
        text: record.text, baseRevision: record.baseRevision,
        cursor: record.cursor, target: record.target, state: "unsaved",
        updateTime: record.updateTime,
      });
    } else {
      await this.journals.clear(documentId);
    }
  }
}
