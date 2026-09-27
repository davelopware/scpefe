import { useSyncExternalStore } from "react";
import type { SnapshotSource } from "@scpefe/frontend-core";

/** Observes a portable session without making React its state owner. */
export function useSessionSnapshot<Snapshot>(source: SnapshotSource<Snapshot>): Snapshot {
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}
