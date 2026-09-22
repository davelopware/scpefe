import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";

const DOCUMENT_ID = /^[0-9a-f]{32}$/;
const REVISION_ID = /^[0-9a-f]{64}$/;
const KEY_BYTES = 32;
const MAX_GRAPH_NODES = 1025;
const MAX_PARENTS = 8;

function targetKey(target) {
  return createHash("sha256").update(target, "utf8").digest("hex");
}

function validateGraph(value) {
  if (!Array.isArray(value) || value.length > MAX_GRAPH_NODES) {
    throw new TypeError("invalid authenticated revision graph");
  }
  const graph = new Map();
  for (const node of value) {
    if (!node || !REVISION_ID.test(node.revisionId)
        || !Array.isArray(node.parentRevisionIds)
        || node.parentRevisionIds.length > MAX_PARENTS
        || node.parentRevisionIds.some((parent) => !REVISION_ID.test(parent))) {
      throw new TypeError("invalid authenticated revision graph");
    }
    if (graph.has(node.revisionId)) {
      throw new TypeError("invalid authenticated revision graph");
    }
    graph.set(node.revisionId, [...new Set(node.parentRevisionIds)]);
  }
  return graph;
}

function validateWitness(value) {
  if (!value || !DOCUMENT_ID.test(value.documentId)
      || !REVISION_ID.test(value.headRevision)) {
    throw new Error("Head witness is malformed");
  }
  const graph = validateGraph(value.graph);
  if (!graph.has(value.headRevision)) graph.set(value.headRevision, []);
  return { documentId: value.documentId, headRevision: value.headRevision,
    graph: [...graph].map(([revisionId, parentRevisionIds]) =>
      ({ revisionId, parentRevisionIds })) };
}

function reaches(graph, start, sought) {
  const pending = [start];
  const visited = new Set();
  while (pending.length > 0) {
    const revision = pending.pop();
    if (revision === sought) return true;
    if (visited.has(revision)) continue;
    visited.add(revision);
    pending.push(...(graph.get(revision) ?? []));
  }
  return false;
}

function mergeGraphs(previous, observed) {
  const merged = validateGraph(previous);
  for (const [revision, parents] of validateGraph(observed)) {
    const known = merged.get(revision) ?? [];
    merged.set(revision, [...new Set([...known, ...parents])]);
  }
  if (merged.size > MAX_GRAPH_NODES) {
    throw new TypeError("authenticated revision graph exceeds its node limit");
  }
  return merged;
}

export function compareHeadWitness(witness, observation) {
  const currentGraph = validateGraph(observation.revisionGraph);
  if (!DOCUMENT_ID.test(observation.documentId)
      || !REVISION_ID.test(observation.headRevision)
      || !currentGraph.has(observation.headRevision)) {
    throw new TypeError("invalid authenticated head observation");
  }
  if (!witness) return Object.freeze({ kind: "first-observation" });
  const previous = validateWitness(witness);
  if (previous.documentId !== observation.documentId) {
    return Object.freeze({ kind: "replacement" });
  }
  if (previous.headRevision === observation.headRevision) {
    return Object.freeze({ kind: "unchanged" });
  }
  const graph = mergeGraphs(previous.graph, observation.revisionGraph);
  if (reaches(graph, observation.headRevision, previous.headRevision)) {
    return Object.freeze({ kind: "descendant" });
  }
  if (reaches(graph, previous.headRevision, observation.headRevision)) {
    return Object.freeze({ kind: "rollback" });
  }
  return Object.freeze({ kind: "divergence" });
}

/* Stores authenticated client-local head witnesses in app-private storage. */
export class HeadWitnessStore {
  constructor({ fs, directory }) {
    this.fs = fs;
    this.directory = directory;
    this.storePath = path.join(directory, "head-witnesses.json");
    this.keyPath = path.join(directory, "head-witness.key");
  }

  async read(target) {
    const entries = await this.#readEntries(false);
    return entries[targetKey(target)] ?? null;
  }

  async observe(target, observation, { replaceCorrupt = false } = {}) {
    let entries;
    try {
      entries = await this.#readEntries(true);
    } catch (error) {
      if (!replaceCorrupt) throw error;
      entries = {};
    }
    const key = targetKey(target);
    const previous = entries[key] ?? null;
    const comparison = compareHeadWitness(previous, observation);
    if (["first-observation", "unchanged", "descendant"].includes(comparison.kind)
        || replaceCorrupt) {
      const graph = mergeGraphs(previous?.graph ?? [], observation.revisionGraph);
      entries[key] = validateWitness({ documentId: observation.documentId,
        headRevision: observation.headRevision,
        graph: [...graph].map(([revisionId, parentRevisionIds]) =>
          ({ revisionId, parentRevisionIds })) });
      await this.#writeEntries(entries);
    }
    return { comparison, previous };
  }

  async accept(target, observation) {
    let entries;
    try { entries = await this.#readEntries(true); } catch { entries = {}; }
    entries[targetKey(target)] = validateWitness({
      documentId: observation.documentId,
      headRevision: observation.headRevision,
      graph: observation.revisionGraph,
    });
    await this.#writeEntries(entries);
  }

  async #key(create) {
    try {
      const key = await this.fs.readFile(this.keyPath);
      if (key.length !== KEY_BYTES) throw new Error("Head witness key is malformed");
      return key;
    } catch (error) {
      if (error?.code !== "ENOENT" || !create) throw error;
      const key = randomBytes(KEY_BYTES);
      await this.fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      try { await this.fs.writeFile(this.keyPath, key, { flag: "wx", mode: 0o600 }); }
      catch (writeError) {
        if (writeError?.code !== "EEXIST") throw writeError;
        return this.#key(false);
      }
      return key;
    }
  }

  async #readEntries(createKey) {
    let envelope;
    try { envelope = JSON.parse(await this.fs.readFile(this.storePath, "utf8")); }
    catch (error) {
      if (error?.code === "ENOENT") return {};
      throw new Error(`Head witness could not be read: ${error.message}`);
    }
    if (!envelope || envelope.version !== 1 || typeof envelope.payload !== "string"
        || typeof envelope.mac !== "string") throw new Error("Head witness is malformed");
    const key = await this.#key(createKey);
    const payload = Buffer.from(envelope.payload, "base64");
    const supplied = Buffer.from(envelope.mac, "base64");
    const expected = createHmac("sha256", key).update(payload).digest();
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new Error("Head witness integrity check failed");
    }
    let decoded;
    try { decoded = JSON.parse(payload.toString("utf8")); }
    catch { throw new Error("Head witness is malformed"); }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("Head witness is malformed");
    }
    return Object.fromEntries(Object.entries(decoded)
      .map(([keyName, witness]) => [keyName, validateWitness(witness)]));
  }

  async #writeEntries(entries) {
    const key = await this.#key(true);
    const payload = Buffer.from(JSON.stringify(entries), "utf8");
    const envelope = Buffer.from(`${JSON.stringify({ version: 1,
      payload: payload.toString("base64"),
      mac: createHmac("sha256", key).update(payload).digest("base64") })}\n`, "utf8");
    await this.fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const transaction = `${this.storePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
    let handle;
    try {
      handle = await this.fs.open(transaction, "wx", 0o600);
      await handle.writeFile(envelope);
      await handle.sync();
      await handle.close();
      handle = null;
      await this.fs.rename(transaction, this.storePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await this.fs.unlink(transaction).catch(() => {});
      throw error;
    }
  }
}
