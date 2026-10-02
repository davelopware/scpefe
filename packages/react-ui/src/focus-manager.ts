/** The small DOM capability required by modal focus behavior. */
export interface FocusDomCapability {
  readonly document: Document;
  schedule(callback: () => void): () => void;
}

/** Elements supplied by a rendering module when it opens a modal scope. */
export interface FocusScopeOptions {
  readonly scope: HTMLElement;
  readonly chrome?: HTMLElement | null;
  readonly initialFocus?: HTMLElement | null;
  readonly returnFocus?: HTMLElement | null;
  readonly fallbackFocus?: () => HTMLElement | null;
}

interface ScopeRecord {
  readonly options: FocusScopeOptions;
  readonly prior: HTMLElement | null;
}

/** Keyboard information shared by DOM and React keyboard events. */
export interface FocusKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  preventDefault(): void;
}

/** A mounted modal's cleanup and keyboard surface. */
export interface FocusScope {
  release(options?: { readonly restoreFocus?: boolean }): void;
  handleKeyDown(event: FocusKeyEvent, onEscape?: () => void): void;
}

/** Owns application modal depth, focus movement, and restoration. */
export class FocusManager {
  private readonly scopes: ScopeRecord[] = [];
  private chrome: HTMLElement | null = null;
  private chromeWasInert = false;
  private rootRestore: HTMLElement | null = null;
  private cancelRestore: (() => void) | null = null;

  constructor(private readonly dom: FocusDomCapability) {}

  get modalDepth(): number { return this.scopes.length; }

  acquire(options: FocusScopeOptions): FocusScope {
    this.cancelRestore?.();
    this.cancelRestore = null;
    if (this.scopes.length === 0) {
      this.chrome = options.chrome ?? null;
      this.chromeWasInert = this.chrome?.hasAttribute("inert") ?? false;
      this.chrome?.setAttribute("inert", "");
      this.rootRestore = this.dom.document.activeElement as HTMLElement | null;
    }
    const prior = this.dom.document.activeElement as HTMLElement | null;
    const record = { options, prior };
    this.scopes.push(record);
    this.focusWithin(options.scope, options.initialFocus);
    return { release: (releaseOptions) => this.release(record, releaseOptions),
      handleKeyDown: (event, onEscape) => this.handleKeyDown(record, event, onEscape) };
  }

  private handleKeyDown(record: ScopeRecord, event: FocusKeyEvent,
    onEscape?: () => void): void {
    if (this.scopes.at(-1) !== record) return;
    if (event.key === "Escape") {
      if (onEscape) { event.preventDefault(); onEscape(); }
      return;
    }
    if (event.key !== "Tab") return;
    const controls = this.focusables(record.options.scope);
    event.preventDefault();
    if (controls.length === 0) {
      record.options.scope.focus();
      return;
    }
    const current = controls.indexOf(this.dom.document.activeElement as HTMLElement);
    const next = current < 0 ? (event.shiftKey ? controls.length - 1 : 0)
      : (current + (event.shiftKey ? controls.length - 1 : 1)) % controls.length;
    controls[next].focus();
  }

  private release(record: ScopeRecord,
    options: { readonly restoreFocus?: boolean } = {}): void {
    const index = this.scopes.indexOf(record);
    if (index < 0) return;
    const wasTop = index === this.scopes.length - 1;
    this.scopes.splice(index, 1);
    const rootRestore = this.rootRestore;
    if (this.scopes.length === 0) {
      if (!this.chromeWasInert) this.chrome?.removeAttribute("inert");
      this.chrome = null;
      this.rootRestore = null;
    }
    if (!wasTop || options.restoreFocus === false) return;
    const nextTop = this.scopes.at(-1) ?? null;
    this.cancelRestore = this.dom.schedule(() => {
      this.cancelRestore = null;
      if ((this.scopes.at(-1) ?? null) !== nextTop) return;
      const allowed = (target: HTMLElement | null | undefined) => target?.isConnected
        && (!nextTop || nextTop.options.scope.contains(target)) ? target : null;
      const target = allowed(record.options.returnFocus) ?? allowed(record.prior)
        ?? (nextTop ? allowed(this.firstFocusable(nextTop.options.scope))
          ?? nextTop.options.scope : allowed(rootRestore)
            ?? allowed(record.options.fallbackFocus?.()));
      target?.focus();
    });
  }

  private firstFocusable(scope: HTMLElement): HTMLElement | null {
    return this.focusables(scope)[0] ?? null;
  }

  private focusables(scope: HTMLElement): HTMLElement[] {
    return [...scope.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])")]
      .filter((element) => element.tabIndex >= 0
        && !element.matches("input[type='hidden']")
        && !element.closest("[hidden], [inert], [aria-hidden='true']"));
  }

  private focusWithin(scope: HTMLElement, preferred: HTMLElement | null | undefined): void {
    const target = preferred?.isConnected && scope.contains(preferred)
      ? preferred : this.firstFocusable(scope) ?? scope;
    target.focus();
  }
}
