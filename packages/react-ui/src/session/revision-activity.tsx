import React, { useEffect, useState } from "react";
import { FocusedDialog } from "../dialogs/focused-dialog.tsx";

/** One authenticated history record copied across the Windows host boundary. */
export interface RevisionActivity {
  revisionId: string;
  previousHead?: string;
  contentParent?: string;
  resolvedBy?: string;
  mergeSources: string[];
  timestampMs: number;
  actorSlotId: string;
  actorName: string;
  actorEmail: string;
  clientName: string;
  clientEmail: string;
  device: string;
  eventType: string;
  kind: 0 | 1 | 2;
  storageKind: 0 | 1 | 2 | 3 | 4 | 5;
  foreign: boolean;
  provisional: boolean;
  bodyAvailable: boolean;
  textAvailable: boolean;
  detailsTruncated?: true;
  details?: { affectedSlotId?: string; cutoffRevision?: string;
    retainedDeltas?: number; outcome?: 0 | 1 | 2; note?: string };
}

/** Read-only host operations for paged activity and available comparisons. */
export interface RevisionActivityHost {
  revisionActivityPage(offset: number, count: number): Promise<{
    items: RevisionActivity[]; nextOffset: number; hasMore: boolean;
    unavailable?: true }>;
  revisionActivityComparison(beforeId: string, afterId: string): Promise<
    { available: true; text: string } | { available: false }>;
}

const PAGE_SIZE = 20;

/** Labels content availability independently from an event's original body. */
export function revisionAvailability(record: RevisionActivity): string {
  if (record.foreign || record.storageKind === 5) return "Foreign metadata only";
  if (record.storageKind === 4) return "Pruned body; text unavailable";
  if (record.textAvailable) return record.bodyAvailable
    ? "Reconstructable text and stored body" : "Reconstructable text";
  return "Text unavailable";
}

function kindName(record: RevisionActivity): string {
  if (record.kind === 0) return "Baseline";
  if (record.kind === 1) return record.mergeSources.length ? "Merge" : "Content save";
  return record.eventType || "Event";
}

function timeLabel(timestamp: number): string {
  const value = new Date(timestamp);
  return Number.isNaN(value.getTime()) ? "Time unavailable" : value.toLocaleString();
}

/** Displays newest-first, self-asserted revision activity for the current document. */
export function RevisionActivityDialog({ host, returnFocus, close, safeError }: {
  host: RevisionActivityHost;
  returnFocus: HTMLElement | null;
  close(): void;
  safeError(error: unknown): string;
}): React.ReactElement {
  const [items, setItems] = useState<RevisionActivity[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [comparison, setComparison] = useState<{
    revisionId: string; text: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    setLoading(true);
    void host.revisionActivityPage(0, PAGE_SIZE).then((page) => {
      if (!live) return;
      setItems(page.items); setOffset(page.nextOffset); setHasMore(page.hasMore);
      setUnavailable(page.unavailable === true);
      setError("");
    }).catch((failure: unknown) => {
      if (live) setError(safeError(failure));
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [host]);

  async function loadMore() {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const page = await host.revisionActivityPage(offset, PAGE_SIZE);
      setItems((before) => [...before, ...page.items]);
      setOffset(page.nextOffset); setHasMore(page.hasMore); setError("");
    } catch (failure) { setError(safeError(failure)); }
    finally { setLoading(false); }
  }

  async function compare(record: RevisionActivity) {
    const before = record.contentParent ?? record.previousHead;
    if (!before || !record.textAvailable || record.foreign) return;
    setLoading(true); setComparison(null);
    try {
      const result = await host.revisionActivityComparison(before, record.revisionId);
      setComparison({ revisionId: record.revisionId,
        text: result.available ? result.text : null });
      setError("");
    } catch (failure) { setError(safeError(failure)); }
    finally { setLoading(false); }
  }

  return <FocusedDialog returnFocus={returnFocus} title="Revision activity" close={close}>
    <p>Names and email addresses were supplied by clients when these revisions were saved. They are not verified identities.</p>
    {error && <p role="alert" className="dialog-error">{error}</p>}
    {unavailable && <p role="status">This container format has no readable revision activity.</p>}
    {items.length === 0 && !loading && !error && !unavailable
      && <p>No revision activity is available.</p>}
    <ol className="revision-activity-list">
      {items.map((record) => <li key={record.revisionId}>
        <h3>{kindName(record)}{record.provisional ? " (provisional)" : ""}</h3>
        <p><time dateTime={Number.isNaN(new Date(record.timestampMs).getTime())
          ? undefined : new Date(record.timestampMs).toISOString()}>
          {timeLabel(record.timestampMs)}</time> · {record.device || "Device not recorded"}</p>
        <p>Actor: {record.actorName || "Name not recorded"}
          {record.actorEmail ? ` · ${record.actorEmail}` : ""}
          {` · slot ${record.actorSlotId}`}</p>
        <p>Client: {record.clientName || "Name not recorded"}
          {record.clientEmail ? ` · ${record.clientEmail}` : ""}</p>
        <p>{revisionAvailability(record)}</p>
        <details><summary>Lineage and details</summary>
          <dl><dt>Revision ID</dt><dd>{record.revisionId}</dd>
            {record.previousHead && <><dt>Previous head</dt><dd>{record.previousHead}</dd></>}
            {record.contentParent && <><dt>Content parent</dt><dd>{record.contentParent}</dd></>}
            {record.mergeSources.map((source) => <React.Fragment key={source}>
              <dt>Merge source</dt><dd>{source}</dd></React.Fragment>)}
            {record.resolvedBy && <><dt>Resolved by</dt><dd>{record.resolvedBy}</dd></>}
            {record.details?.affectedSlotId && <><dt>Affected slot</dt>
              <dd>{record.details.affectedSlotId}</dd></>}
            {record.details?.cutoffRevision && <><dt>Compaction cutoff</dt>
              <dd>{record.details.cutoffRevision}</dd></>}
            {record.details?.retainedDeltas !== undefined && <><dt>Retained deltas</dt>
              <dd>{record.details.retainedDeltas}</dd></>}
            {record.details?.outcome !== undefined && <><dt>Outcome</dt>
              <dd>{["Attempted", "Succeeded", "Failed"][record.details.outcome]}</dd></>}
            {record.details?.note && <><dt>Note</dt><dd>{record.details.note}</dd></>}
            {record.detailsTruncated && <><dt>Additional details</dt>
              <dd>Too large to display</dd></>}
          </dl></details>
        {record.textAvailable && !record.foreign
          && (record.contentParent || record.previousHead)
          ? <button type="button" disabled={loading} onClick={() => void compare(record)}>
            Compare with parent</button>
          : <p>Comparison unavailable for this revision.</p>}
        {comparison?.revisionId === record.revisionId && (comparison.text === null
          ? <p role="status">Comparison unavailable: required text was pruned or is metadata only.</p>
          : <pre aria-label="Revision comparison">{comparison.text}</pre>)}
      </li>)}
    </ol>
    {hasMore && <button type="button" disabled={loading} onClick={() => void loadMore()}>
      Load more activity</button>}
    {loading && <p role="status">Loading revision activity…</p>}
    <div className="dialog-actions"><button type="button" onClick={close}>Close</button></div>
  </FocusedDialog>;
}
