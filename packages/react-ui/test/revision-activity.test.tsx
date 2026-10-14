import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RevisionActivityDialog, revisionAvailability,
  type RevisionActivity, type RevisionActivityHost } from "../src/session/revision-activity.tsx";

const id = (digit: string) => digit.repeat(64);
const baseline: RevisionActivity = { revisionId: id("1"), mergeSources: [],
  timestampMs: 100, actorSlotId: "ab".repeat(16), actorName: "Ada",
  actorEmail: "ada@example.test", clientName: "Ada", clientEmail: "ada@example.test",
  device: "Desk", eventType: "", kind: 0, storageKind: 4,
  foreign: false, provisional: false, bodyAvailable: false, textAvailable: false };
const event: RevisionActivity = { ...baseline, revisionId: id("2"),
  previousHead: baseline.revisionId, timestampMs: 200, kind: 2,
  storageKind: 0, eventType: "compaction", bodyAvailable: false,
  textAvailable: true, details: { cutoffRevision: baseline.revisionId,
    retainedDeltas: 10 } };

test("availability labels distinguish event text, pruned bodies and foreign metadata", () => {
  assert.equal(revisionAvailability(baseline), "Pruned body; text unavailable");
  assert.equal(revisionAvailability(event), "Reconstructable text");
  assert.equal(revisionAvailability({ ...baseline, foreign: true, storageKind: 5 }),
    "Foreign metadata only");
});

test("activity dialog renders attribution, lineage and unavailable comparison", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>",
    { url: "https://scpefe.invalid/" });
  const keys = ["window", "document", "HTMLElement", "Node", "MutationObserver",
    "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT"] as const;
  const prior = new Map(keys.map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  let root: Root | null = null;
  let closed = false;
  t.after(() => {
    if (root) root.unmount();
    frames.clear();
    if (!closed) dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  const view = dom.window as unknown as Window & typeof globalThis;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: view.HTMLElement, Node: view.Node,
    MutationObserver: view.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const token = ++frameId;
      frames.set(token, callback);
      queueMicrotask(() => {
        const pending = frames.get(token);
        if (pending) { frames.delete(token); pending(performance.now()); }
      });
      return token;
    }, cancelAnimationFrame: (token: number) => frames.delete(token),
    IS_REACT_ACT_ENVIRONMENT: true });
  const calls: Array<[string, string]> = [];
  const host: RevisionActivityHost = {
    revisionActivityPage: async (offset, count) => {
      assert.equal(offset, 0); assert.equal(count, 20);
      return { items: [event, baseline], nextOffset: 2, hasMore: false };
    },
    revisionActivityComparison: async (before, after) => {
      calls.push([before, after]); return { available: false };
    },
  };
  const mount = dom.window.document.getElementById("root");
  assert.ok(mount);
  root = createRoot(mount);
  await act(async () => {
    root?.render(<RevisionActivityDialog host={host} returnFocus={null}
      close={() => {}} safeError={() => "Safe error"} />);
    await Promise.resolve();
  });
  const dialog = dom.window.document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.match(dialog.textContent ?? "", /not verified identities/);
  assert.match(dialog.textContent ?? "", /Ada · ada@example\.test · slot ab/);
  assert.match(dialog.textContent ?? "", /Pruned body; text unavailable/);
  assert.match(dialog.textContent ?? "", /Reconstructable text/);
  assert.equal(dialog.querySelectorAll("ol > li").length, 2);
  const detail = dialog.querySelector("details");
  assert.ok(detail);
  assert.match(detail.textContent ?? "", /Compaction cutoff/);
  const compare = [...dialog.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Compare with parent"));
  assert.ok(compare);
  await act(async () => { compare.click(); await Promise.resolve(); });
  assert.deepEqual(calls, [[baseline.revisionId, event.revisionId]]);
  assert.match(dialog.textContent ?? "", /Comparison unavailable: required text was pruned/);
  await act(async () => { root?.unmount(); root = null; });
  dom.window.close(); closed = true;
  assert.equal(frames.size, 0);
});
