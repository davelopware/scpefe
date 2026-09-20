const REVISION_ID = /^[0-9a-f]{64}$/;
const MAX_GRAPH_NODES = 4096;
const MAX_PARENTS = 8;

function graphOf(...observations) {
  const graph = new Map();
  for (const observation of observations) {
    if (!observation || !REVISION_ID.test(observation.baseRevision)
        || !Array.isArray(observation.revisionGraph)) {
      throw new TypeError("invalid authenticated revision observation");
    }
    for (const node of observation.revisionGraph) {
      if (!node || !REVISION_ID.test(node.revisionId)
          || !Array.isArray(node.parentRevisionIds)
          || node.parentRevisionIds.length > MAX_PARENTS
          || node.parentRevisionIds.some((parent) => !REVISION_ID.test(parent))) {
        throw new TypeError("invalid authenticated revision graph");
      }
      const known = graph.get(node.revisionId);
      if (known && (known.length !== node.parentRevisionIds.length
          || known.some((parent, index) => parent !== node.parentRevisionIds[index]))) {
        throw new Error("authenticated revision graphs disagree");
      }
      graph.set(node.revisionId, [...node.parentRevisionIds]);
      if (graph.size > MAX_GRAPH_NODES) {
        throw new Error("authenticated revision graph exceeds its node limit");
      }
    }
  }
  return graph;
}

function distances(graph, head) {
  const result = new Map([[head, 0]]);
  const pending = [head];
  while (pending.length) {
    const current = pending.shift();
    const distance = result.get(current);
    for (const parent of graph.get(current) ?? []) {
      if (!result.has(parent)) {
        result.set(parent, distance + 1);
        pending.push(parent);
      }
    }
  }
  return result;
}

function nearestCommonAncestor(graph, localHead, currentHead) {
  const local = distances(graph, localHead);
  const current = distances(graph, currentHead);
  let selected = null;
  let score = Number.POSITIVE_INFINITY;
  for (const [revision, localDistance] of local) {
    const currentDistance = current.get(revision);
    if (currentDistance === undefined) continue;
    const candidateScore = localDistance + currentDistance;
    if (candidateScore < score
        || (candidateScore === score && revision < selected)) {
      selected = revision;
      score = candidateScore;
    }
  }
  return selected;
}

function marked(local, current) {
  const block = (value) => value.endsWith("\n") ? value : `${value}\n`;
  return `<<<<<<< local\n${block(local)}=======\n${block(current)}>>>>>>> current\n`;
}

function lines(content) {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function changedSpan(base, branch) {
  let prefix = 0;
  while (prefix < base.length && prefix < branch.length
      && base[prefix] === branch[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < base.length - prefix && suffix < branch.length - prefix
      && base[base.length - suffix - 1] === branch[branch.length - suffix - 1]) {
    suffix += 1;
  }
  return { start: prefix, end: base.length - suffix,
    replacement: branch.slice(prefix, branch.length - suffix) };
}

function cleanLineMerge(ancestor, local, current) {
  const baseLines = lines(ancestor);
  const localChange = changedSpan(baseLines, lines(local));
  const currentChange = changedSpan(baseLines, lines(current));
  const disjoint = localChange.end < currentChange.start
    || currentChange.end < localChange.start;
  if (!disjoint) return null;
  const changes = [localChange, currentChange].sort((left, right) =>
    right.start - left.start);
  const merged = [...baseLines];
  for (const change of changes) {
    merged.splice(change.start, change.end - change.start, ...change.replacement);
  }
  return merged.join("");
}

/* Builds the persisted working draft for two authenticated divergent branches. */
export function createMergeDraft({ ancestor, local, current }) {
  if (ancestor.documentId !== local.documentId
      || ancestor.documentId !== current.documentId) {
    throw new Error("Divergent replicas do not carry the same document ID");
  }
  if (local.baseRevision === current.baseRevision) {
    throw new Error("The observed replicas are not divergent");
  }
  const graph = graphOf(ancestor, local, current);
  const commonAncestor = nearestCommonAncestor(
    graph, local.baseRevision, current.baseRevision);
  if (!commonAncestor) throw new Error("Divergent replicas have no common ancestor");
  if (commonAncestor !== ancestor.baseRevision) {
    throw new Error("The available publication base is not the common ancestor");
  }
  let content;
  let hasConflicts = false;
  if (local.opened.content === current.opened.content) content = local.opened.content;
  else if (local.opened.content === ancestor.opened.content) content = current.opened.content;
  else if (current.opened.content === ancestor.opened.content) content = local.opened.content;
  else {
    content = cleanLineMerge(ancestor.opened.content,
      local.opened.content, current.opened.content);
    if (content === null) {
      content = marked(local.opened.content, current.opened.content);
      hasConflicts = true;
    }
  }
  return Object.freeze({ content, hasConflicts,
    ancestorRevision: commonAncestor,
    localRevision: local.baseRevision,
    currentRevision: current.baseRevision });
}

/* Reports whether a draft still contains one of the required conflict markers. */
export function hasConflictMarkers(content) {
  return /^(?:<<<<<<<.*|=======.*|>>>>>>>.*)$/m.test(content);
}
