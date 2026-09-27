/** UTF-16 offsets matching a text editor's selection. */
export interface WorkingCopySelection {
  readonly start: number;
  readonly end: number;
}

/** The narrow request accepted by the platform's recovery-journal capability. */
export interface WorkingCopyUpdate {
  content: string;
  cursor: WorkingCopySelection;
  journalScope: string;
}

/** Schedules recovery-journal work without making the frontend a storage owner. */
export interface WorkingCopyJournalHost {
  /** Returns a unique opaque scope for each adoption, including after lock or reset. */
  createJournalScope(): string;
  /** Applies calls in invocation order, even if acknowledgements settle out of order.
   * An acknowledgement is not durable checkpoint proof. */
  updateWorkingCopy(update: WorkingCopyUpdate): Promise<unknown>;
  /** Reports later checkpoint failures with the scope of the update that scheduled them. */
  onJournalWarning(listener: (code: string, journalScope: string | null) => void): () => void;
}

/** The secret-free state before adoption and immediately after reset or lock. */
export interface EmptyWorkingCopySnapshot {
  readonly kind: "empty";
}

/** An immutable projection of the current editable text and local edit state. */
export interface ReadyWorkingCopySnapshot {
  readonly kind: "ready";
  readonly text: string;
  readonly baseline: "valid" | "invalid";
  readonly dirty: boolean;
  readonly selection: WorkingCopySelection;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly historyLength: number;
  readonly journal: Readonly<{ pending: number; failed: boolean }>;
}

/** The only states a WorkingCopy can expose to its owning session. */
export type WorkingCopySnapshot = EmptyWorkingCopySnapshot | ReadyWorkingCopySnapshot;

/** A semantic search result for presentation adapters to map to messages. */
export type WorkingCopyFindResult =
  | Readonly<{ status: "empty" | "not-found" }>
  | Readonly<{ status: "selected"; wrapped: boolean;
    selection: WorkingCopySelection }>;

interface WorkingState {
  text: string;
  journalScope: string;
  baseline: string | null;
  history: string[];
  index: number;
  selection: WorkingCopySelection;
  pending: Map<number, Promise<void>>;
  revision: number;
  acceptedRevision: number;
  failedRevision: number;
  checkpointFailed: boolean;
}

const EMPTY: EmptyWorkingCopySnapshot = Object.freeze({ kind: "empty" });

/** Owns local text semantics while a DocumentSession owns its lifetime. */
export class WorkingCopy {
  private state: WorkingState | null = null;
  private snapshot: WorkingCopySnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private readonly invalidateWaiters = new Set<() => void>();
  private readonly stopWarnings: () => void;
  private disposed = false;

  constructor(private readonly journalHost: WorkingCopyJournalHost,
    private readonly historyLimit = 100) {
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) {
      throw new RangeError("history limit must be a positive integer");
    }
    this.stopWarnings = journalHost.onJournalWarning((code, journalScope) => {
      if (code !== "RECOVERY_CHECKPOINT_FAILED" || !journalScope
        || journalScope !== this.state?.journalScope) return;
      this.state.checkpointFailed = true;
      this.publish();
    });
  }

  getSnapshot(): WorkingCopySnapshot { return this.snapshot; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Adopts host-validated canonical text from a successful open. */
  adoptOpen(text: string, provisional = false): void {
    this.adopt(text, provisional ? null : text, { start: 0, end: 0 });
  }

  /** Adopts recovered text with no valid manual-save baseline. */
  adoptRecovery(text: string, selection: WorkingCopySelection): void {
    this.adopt(text, null, selection);
  }

  /** Adopts a divergent draft with no valid manual-save baseline. */
  adoptDivergence(text: string): void {
    this.adopt(text, null, { start: 0, end: 0 });
  }

  markProvisional(): void {
    this.requireReady().baseline = null;
    this.publish();
  }

  /** Adopts canonical text returned by a successful manual publication. */
  adoptPublication(text: string): void {
    const state = this.requireReady();
    const journalScope = this.journalHost.createJournalScope();
    this.startGeneration();
    state.pending.clear();
    state.revision = 0;
    state.acceptedRevision = 0;
    state.failedRevision = 0;
    state.checkpointFailed = false;
    state.journalScope = journalScope;
    state.text = text;
    state.baseline = text;
    state.history[state.index] = text;
    state.selection = this.normalizedSelection(text, state.selection);
    this.publish();
  }

  reset(): void {
    this.startGeneration();
    this.state = null;
    this.publish();
  }

  lock(): void { this.reset(); }

  dispose(): void {
    if (this.disposed) return;
    this.reset();
    this.stopWarnings();
    this.listeners.clear();
    this.disposed = true;
  }

  private adopt(text: string, baseline: string | null,
    selection: WorkingCopySelection): void {
    const journalScope = this.journalHost.createJournalScope();
    this.startGeneration();
    this.state = {
      text, baseline, journalScope,
      history: [text], index: 0, selection: this.normalizedSelection(text, selection),
      pending: new Map(), revision: 0, acceptedRevision: 0, failedRevision: 0,
      checkpointFailed: false,
    };
    this.publish();
  }

  edit(text: string, selection: WorkingCopySelection = {
    start: text.length, end: text.length }): void {
    const state = this.requireReady();
    state.text = text;
    state.history = [...state.history.slice(0, state.index + 1), text];
    if (state.history.length > this.historyLimit) state.history.shift();
    state.index = state.history.length - 1;
    state.selection = this.normalizedSelection(text, selection);
    this.updateJournal(state);
    this.publish();
  }

  undo(): boolean { return this.moveHistory(-1); }

  redo(): boolean { return this.moveHistory(1); }

  setSelection(selection: WorkingCopySelection): void {
    const state = this.requireReady();
    state.selection = this.normalizedSelection(state.text, selection);
    this.publish();
  }

  findNext(query: string): WorkingCopyFindResult {
    const state = this.requireReady();
    if (!query) return Object.freeze({ status: "empty" });
    let start = state.text.indexOf(query, state.selection.end);
    const wrapped = start < 0 && state.text.indexOf(query) >= 0;
    if (start < 0) start = state.text.indexOf(query);
    if (start < 0) return Object.freeze({ status: "not-found" });
    state.selection = Object.freeze({ start, end: start + query.length });
    this.publish();
    return Object.freeze({ status: "selected", wrapped, selection: state.selection });
  }

  replaceSelection(query: string, replacement: string): WorkingCopyFindResult
    | Readonly<{ status: "replaced" }> {
    const state = this.requireReady();
    if (!query) return Object.freeze({ status: "empty" });
    const { start, end } = state.selection;
    if (state.text.slice(start, end) !== query) return this.findNext(query);
    const text = state.text.slice(0, start) + replacement + state.text.slice(end);
    const cursor = start + replacement.length;
    this.edit(text, { start: cursor, end: cursor });
    return Object.freeze({ status: "replaced" });
  }

  replaceAll(query: string, replacement: string): Readonly<{ replacements: number }> {
    const state = this.requireReady();
    if (!query) return Object.freeze({ replacements: 0 });
    const pieces = state.text.split(query);
    const replacements = pieces.length - 1;
    if (replacements === 0) return Object.freeze({ replacements: 0 });
    const text = pieces.join(replacement);
    this.edit(text, { start: text.length, end: text.length });
    return Object.freeze({ replacements });
  }

  /** Waits for current host acknowledgements, not durable checkpoint completion. */
  async drainJournal(): Promise<{ readonly status: "drained" | "failed" | "cleared" }> {
    const generation = this.generation;
    while (generation === this.generation && this.state?.pending.size) {
      let release!: () => void;
      const invalidated = new Promise<void>((resolve) => {
        release = resolve;
        this.invalidateWaiters.add(resolve);
      });
      try {
        await Promise.race([Promise.all([...this.state.pending.values()]), invalidated]);
      } finally {
        this.invalidateWaiters.delete(release);
      }
    }
    if (generation !== this.generation || !this.state) {
      return Object.freeze({ status: "cleared" });
    }
    return Object.freeze({ status: this.state.failedRevision > 0
      || this.state.checkpointFailed ? "failed" : "drained" });
  }

  private moveHistory(offset: number): boolean {
    const state = this.requireReady();
    const next = state.index + offset;
    if (next < 0 || next >= state.history.length) return false;
    state.index = next;
    state.text = state.history[next];
    state.selection = Object.freeze({ start: state.text.length, end: state.text.length });
    this.updateJournal(state);
    this.publish();
    return true;
  }

  private requireReady(): WorkingState {
    if (!this.state) throw new Error("working copy is empty");
    return this.state;
  }

  private normalizedSelection(text: string,
    selection: WorkingCopySelection): WorkingCopySelection {
    const clamp = (offset: number) => Number.isFinite(offset)
      ? Math.max(0, Math.min(text.length, Math.trunc(offset))) : 0;
    const start = clamp(selection.start);
    const end = clamp(selection.end);
    return Object.freeze({ start: Math.min(start, end), end: Math.max(start, end) });
  }

  private startGeneration(): void {
    if (this.disposed) throw new Error("working copy is disposed");
    for (const release of this.invalidateWaiters) release();
    this.invalidateWaiters.clear();
    this.generation += 1;
  }

  private updateJournal(state: WorkingState): void {
    const revision = ++state.revision;
    const generation = this.generation;
    let update: Promise<unknown>;
    try {
      update = Promise.resolve(this.journalHost.updateWorkingCopy({
        content: state.text, cursor: state.selection,
        journalScope: state.journalScope,
      }));
    } catch {
      update = Promise.reject(new Error("journal update failed"));
    }
    const settled = update.then(() => this.finishJournal(generation, revision, true),
      () => this.finishJournal(generation, revision, false));
    state.pending.set(revision, settled);
  }

  private finishJournal(generation: number, revision: number, accepted: boolean): void {
    if (generation !== this.generation || !this.state) return;
    this.state.pending.delete(revision);
    if (accepted) {
      this.state.acceptedRevision = Math.max(this.state.acceptedRevision, revision);
      if (this.state.failedRevision <= this.state.acceptedRevision) {
        this.state.failedRevision = 0;
      }
    } else if (revision > this.state.acceptedRevision) {
      this.state.failedRevision = Math.max(this.state.failedRevision, revision);
    }
    this.publish();
  }

  private publish(): void {
    const state = this.state;
    this.snapshot = state ? Object.freeze({
      kind: "ready", text: state.text,
      baseline: state.baseline === null ? "invalid" : "valid",
      dirty: state.baseline === null || state.text !== state.baseline,
      selection: state.selection,
      canUndo: state.index > 0, canRedo: state.index < state.history.length - 1,
      historyLength: state.history.length,
      journal: Object.freeze({ pending: state.pending.size,
        failed: state.failedRevision > 0 || state.checkpointFailed }),
    }) : EMPTY;
    for (const listener of this.listeners) listener();
  }
}
