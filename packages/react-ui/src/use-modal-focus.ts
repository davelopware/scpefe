import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { browserFocusManager } from "./browser-focus-dom.ts";
import type { FocusScope } from "./focus-manager.ts";

/** Focus behavior supplied by each modal renderer without owning its markup. */
export interface ModalFocusOptions {
  readonly scopeRef: RefObject<HTMLElement | null>;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly returnFocus?: HTMLElement | null;
  readonly fallbackFocus?: () => HTMLElement | null;
  readonly onEscape?: () => void;
  readonly shouldRestoreFocus?: () => boolean;
}

/** Connects a mounted React dialog to the document's shared focus manager. */
export function useModalFocus(options: ModalFocusOptions): {
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
} {
  const latest = useRef(options);
  latest.current = options;
  const scope = useRef<FocusScope | null>(null);
  useEffect(() => {
    const element = options.scopeRef.current;
    if (!element) return;
    const document = element.ownerDocument;
    scope.current = browserFocusManager(document).acquire({
      scope: element,
      chrome: document.querySelector<HTMLElement>(".shell-chrome"),
      initialFocus: options.initialFocusRef?.current,
      returnFocus: options.returnFocus,
      fallbackFocus: options.fallbackFocus,
    });
    return () => {
      scope.current?.release({
        restoreFocus: latest.current.shouldRestoreFocus?.() ?? true,
      });
      scope.current = null;
    };
  }, []);
  return { onKeyDown: (event) => scope.current?.handleKeyDown(event,
    latest.current.onEscape) };
}
