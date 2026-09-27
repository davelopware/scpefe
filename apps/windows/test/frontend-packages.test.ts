import assert from "node:assert/strict";
import test from "node:test";
import { isSnapshotSource, type SnapshotSource } from "@scpefe/frontend-core";
import type { SnapshotSource as ReactSnapshotSource } from "@scpefe/react-ui";

test("Windows can consume both workspace public entries from a clean install", () => {
  const source: ReactSnapshotSource<{ state: "closed" }> = {
    getSnapshot: () => ({ state: "closed" }),
    subscribe: () => () => {},
  };
  const coreSource: SnapshotSource<{ state: "closed" }> = source;
  assert.equal(isSnapshotSource(coreSource), true);
  assert.deepEqual(coreSource.getSnapshot(), { state: "closed" });
});
