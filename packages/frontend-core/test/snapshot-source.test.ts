import assert from "node:assert/strict";
import test from "node:test";
import { isSnapshotSource } from "../src/index.ts";

test("a presentation adapter accepts a snapshot source with both methods", () => {
  const source = {
    getSnapshot: () => ({ state: "closed" as const }),
    subscribe: (_listener: () => void) => () => {},
  };
  assert.equal(isSnapshotSource(source), true);
  assert.equal(isSnapshotSource({ getSnapshot: source.getSnapshot }), false);
  assert.equal(isSnapshotSource(null), false);
});
