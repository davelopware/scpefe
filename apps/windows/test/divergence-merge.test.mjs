import assert from "node:assert/strict";
import test from "node:test";
import { createMergeDraft, hasConflictMarkers } from "../src/divergence-merge.mjs";

const id = (byte) => byte.repeat(64);
const documentId = "11".repeat(16);
const node = (revisionId, parentRevisionIds = []) => ({ revisionId, parentRevisionIds });
const observed = (head, content, graph) => ({ documentId, baseRevision: head,
  revisionGraph: graph, opened: { content } });

test("three-way drafts select unchanged sides and mark overlapping edits", () => {
  const a = id("a");
  const l = id("b");
  const c = id("c");
  const ancestor = observed(a, "base", [node(a)]);
  const local = observed(l, "local", [node(a), node(l, [a])]);
  const unchangedCurrent = observed(c, "base", [node(a), node(c, [a])]);
  assert.deepEqual(createMergeDraft({ ancestor, local, current: unchangedCurrent }), {
    content: "local", hasConflicts: false, ancestorRevision: a,
    localRevision: l, currentRevision: c,
  });

  const current = observed(c, "current", [node(a), node(c, [a])]);
  const overlap = createMergeDraft({ ancestor, local, current });
  assert.equal(overlap.hasConflicts, true);
  assert.equal(overlap.content,
    "<<<<<<< local\nlocal\n=======\ncurrent\n>>>>>>> current\n");
  assert.equal(hasConflictMarkers(overlap.content), true);
  assert.equal(hasConflictMarkers("local and current resolved"), false);
});

test("three-way drafts combine disjoint line edits without markers", () => {
  const a = id("a");
  const l = id("b");
  const c = id("c");
  const draft = createMergeDraft({
    ancestor: observed(a, "one\nmiddle\nthree\n", [node(a)]),
    local: observed(l, "local\nmiddle\nthree\n", [node(a), node(l, [a])]),
    current: observed(c, "one\nmiddle\ncurrent\n",
      [node(a), node(c, [a])]),
  });
  assert.equal(draft.content, "local\nmiddle\ncurrent\n");
  assert.equal(draft.hasConflicts, false);
});

test("unrelated authenticated heads have no merge base", () => {
  const a = id("a");
  const l = id("b");
  const c = id("c");
  assert.throws(() => createMergeDraft({
    ancestor: observed(a, "base", [node(a)]),
    local: observed(l, "local", [node(l)]),
    current: observed(c, "current", [node(c)]),
  }), /no common ancestor/);
});

test("ancestry traversal is bounded", () => {
  const graph = Array.from({ length: 4097 }, (_, index) =>
    node(index.toString(16).padStart(64, "0")));
  const a = graph[0].revisionId;
  assert.throws(() => createMergeDraft({
    ancestor: observed(a, "base", graph),
    local: observed(id("b"), "local", [node(id("b"), [a])]),
    current: observed(id("c"), "current", [node(id("c"), [a])]),
  }), /node limit/);
});
