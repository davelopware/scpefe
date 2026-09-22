import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import path from "node:path";

const DOCUMENT_ID = /^[0-9a-f]{32}$/;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const STATES = new Set(["unsaved", "pending-publication", "conflict"]);
const TRANSACTION_STAGES = new Set([
  "prepared", "written", "flushed", "replaced", "verified", "cleanup",
]);

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function journalName(documentId) {
  if (!DOCUMENT_ID.test(documentId)) throw new TypeError("invalid document identifier");
  return `${documentId}.work-journal`;
}

function requireKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new TypeError("invalid work-journal key");
  }
}

function validateRecord(value) {
  if (!value || typeof value !== "object" || typeof value.text !== "string"
      || !/^[0-9a-f]{64}$/.test(value.baseRevision)
      || typeof value.target !== "string" || !value.target
      || !STATES.has(value.state) || !Number.isSafeInteger(value.updateTime)
      || value.updateTime < 0 || !value.cursor || typeof value.cursor !== "object"
      || !Number.isSafeInteger(value.cursor.start) || value.cursor.start < 0
      || !Number.isSafeInteger(value.cursor.end) || value.cursor.end < value.cursor.start
      || value.cursor.end > value.text.length) {
    throw new TypeError("invalid work-journal record");
  }
  let publication;
  let merge;
  if (value.merge !== undefined) {
    if (value.state !== "conflict" || !value.merge
        || typeof value.merge !== "object"
        || typeof value.merge.localContent !== "string"
        || !/^[0-9a-f]{64}$/.test(value.merge.ancestorRevision)
        || !/^[0-9a-f]{64}$/.test(value.merge.localRevision)
        || !/^[0-9a-f]{64}$/.test(value.merge.currentRevision)) {
      throw new TypeError("invalid merge-resolution state");
    }
    merge = { localContent: value.merge.localContent,
      ancestorRevision: value.merge.ancestorRevision,
      localRevision: value.merge.localRevision,
      currentRevision: value.merge.currentRevision };
  }
  if (value.publication !== undefined) {
    const candidate = value.publication?.candidate;
    const base = value.publication?.base;
    const mergeAncestor = value.publication?.mergeAncestor;
    const mergeAncestorHash = value.publication?.mergeAncestorHash;
    if (!value.publication || typeof value.publication !== "object"
        || !["unsaved", "pending-publication", "conflict"].includes(value.state)
        || typeof value.publication.id !== "string"
        || !/^[0-9a-f]{32}$/.test(value.publication.id)
        || value.publication.target !== value.target
        || typeof value.publication.transactionFile !== "string"
        || !value.publication.transactionFile
        || typeof value.publication.baseFile !== "string"
        || !value.publication.baseFile
        || !/^[0-9a-f]{64}$/.test(value.publication.candidateHash)
        || !/^[0-9a-f]{64}$/.test(value.publication.baseHash)
        || !TRANSACTION_STAGES.has(value.publication.stage)
        || typeof candidate !== "string"
        || !Buffer.from(candidate, "base64").length
        || typeof base !== "string" || !Buffer.from(base, "base64").length
        || hash(Buffer.from(base, "base64")) !== value.publication.baseHash
        || ((mergeAncestor === undefined) !== (mergeAncestorHash === undefined))
        || (mergeAncestor !== undefined
          && (typeof mergeAncestor !== "string"
            || !Buffer.from(mergeAncestor, "base64").length
            || !/^[0-9a-f]{64}$/.test(mergeAncestorHash)
            || hash(Buffer.from(mergeAncestor, "base64")) !== mergeAncestorHash
            || value.publication.purpose !== "regular-save"))
        || (value.publication.purpose !== undefined
          && !["invitation-claim", "regular-save", "provisional-discard",
            "identity-reconciliation", "slot-administration", "compaction",
            "format-migration", "password-change"]
            .includes(value.publication.purpose))
        || (value.publication.reopenPassword !== undefined
          && (typeof value.publication.reopenPassword !== "string"
            || !value.publication.reopenPassword
            || value.publication.reopenPassword.length > 4096))
        || (["invitation-claim", "password-change"].includes(
          value.publication.purpose) && value.publication.reopenPassword === undefined)
        || (value.publication.purpose === "invitation-claim" && value.text !== "")
        || (value.publication.reopenPassword !== undefined
          && !["invitation-claim", "password-change"].includes(
            value.publication.purpose))
        || (value.state === "unsaved"
          && value.publication.purpose !== "regular-save")) {
      throw new TypeError("invalid publication transaction");
    }
    publication = {
      id: value.publication.id,
      target: value.publication.target,
      transactionFile: value.publication.transactionFile,
      baseFile: value.publication.baseFile,
      candidateHash: value.publication.candidateHash,
      baseHash: value.publication.baseHash,
      base,
      candidate,
      ...(mergeAncestor ? { mergeAncestor, mergeAncestorHash } : {}),
      stage: value.publication.stage,
      ...(value.publication.purpose
        ? { purpose: value.publication.purpose } : {}),
      ...(value.publication.reopenPassword
        ? { reopenPassword: value.publication.reopenPassword } : {}),
    };
  }
  return {
    text: value.text,
    baseRevision: value.baseRevision,
    cursor: { start: value.cursor.start, end: value.cursor.end },
    target: value.target,
    state: value.state,
    updateTime: value.updateTime,
    ...(publication ? { publication } : {}),
    ...(merge ? { merge } : {}),
  };
}

/* Stores one authenticated encrypted app-private journal per document. */
export class WorkJournalStore {
  constructor({ fs, directory }) {
    this.fs = fs;
    this.directory = directory;
  }

  async read(documentId, key) {
    requireKey(key);
    let envelope;
    try {
      envelope = JSON.parse(await this.fs.readFile(
        path.join(this.directory, journalName(documentId)), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (!envelope || envelope.version !== 1 || typeof envelope.nonce !== "string"
        || typeof envelope.tag !== "string" || typeof envelope.ciphertext !== "string") {
      throw new Error("Work journal is malformed");
    }
    const nonce = Buffer.from(envelope.nonce, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
      throw new Error("Work journal is malformed");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(`scpefe-work-journal-v1:${documentId}`, "ascii"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    try {
      return validateRecord(JSON.parse(plaintext.toString("utf8")));
    } finally {
      plaintext.fill(0);
    }
  }

  async findPublication(target) {
    let names;
    try {
      names = await this.fs.readdir(this.directory);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const targetHash = hash(Buffer.from(target, "utf8"));
    for (const name of names) {
      const match = /^([0-9a-f]{32})\.work-journal$/.exec(name);
      if (!match) continue;
      try {
        const envelope = JSON.parse(await this.fs.readFile(
          path.join(this.directory, name), "utf8"));
        if (envelope?.bootstrap?.targetHash === targetHash
            && typeof envelope.bootstrap.base === "string") {
          const base = Buffer.from(envelope.bootstrap.base, "base64");
          if (base.length) return { documentId: match[1], base };
        }
      } catch {
        // Malformed journals are reported after authentication, not during discovery.
      }
    }
    return null;
  }

  /* Reports unresolved journal counts without decrypting or exposing document targets. */
  async discoverUnresolved() {
    let names;
    try {
      names = await this.fs.readdir(this.directory);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return Object.freeze({ total: 0, pendingPublications: 0 });
      }
      throw error;
    }
    let total = 0;
    let pendingPublications = 0;
    for (const name of names) {
      if (!/^[0-9a-f]{32}\.work-journal$/.test(name)) continue;
      total += 1;
      try {
        const envelope = JSON.parse(await this.fs.readFile(
          path.join(this.directory, name), "utf8"));
        if (envelope?.bootstrap
            && /^[0-9a-f]{64}$/.test(envelope.bootstrap.targetHash)
            && typeof envelope.bootstrap.base === "string"
            && Buffer.from(envelope.bootstrap.base, "base64").length > 0) {
          pendingPublications += 1;
        }
      } catch {
        // A malformed journal remains unresolved and discoverable without exposing details.
      }
    }
    return Object.freeze({ total, pendingPublications });
  }

  async write(documentId, key, record) {
    requireKey(key);
    const validated = validateRecord(record);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(`scpefe-work-journal-v1:${documentId}`, "ascii"));
    const plaintext = Buffer.from(JSON.stringify(validated), "utf8");
    let ciphertext;
    try {
      ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    } finally {
      plaintext.fill(0);
    }
    const bootstrap = validated.publication ? {
      targetHash: hash(Buffer.from(validated.target, "utf8")),
      base: validated.publication.base,
    } : undefined;
    const envelope = Buffer.from(`${JSON.stringify({
      version: 1,
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      ...(bootstrap ? { bootstrap } : {}),
    })}\n`, "utf8");
    await this.fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, journalName(documentId));
    const transaction = `${target}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
    let handle;
    try {
      handle = await this.fs.open(transaction, "wx", 0o600);
      await handle.writeFile(envelope);
      await handle.sync();
      await handle.close();
      handle = null;
      await this.fs.rename(transaction, target);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await this.fs.unlink(transaction).catch(() => {});
      throw error;
    }
  }

  async clear(documentId) {
    try {
      await this.fs.unlink(path.join(this.directory, journalName(documentId)));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
