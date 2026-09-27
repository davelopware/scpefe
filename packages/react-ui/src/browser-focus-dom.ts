import { FocusManager, type FocusDomCapability } from "./focus-manager.ts";

const managers = new WeakMap<Document, FocusManager>();

/** Supplies the browser document and animation-frame scheduler to FocusManager. */
export function browserFocusDom(document: Document): FocusDomCapability {
  return {
    document,
    schedule(callback) {
      const view = document.defaultView;
      const request = view?.requestAnimationFrame?.bind(view)
        ?? globalThis.requestAnimationFrame?.bind(globalThis);
      const cancel = view?.cancelAnimationFrame?.bind(view)
        ?? globalThis.cancelAnimationFrame?.bind(globalThis);
      if (request && cancel) {
        const frame = request(() => callback());
        return () => cancel(frame);
      }
      const timer = setTimeout(callback, 0);
      return () => clearTimeout(timer);
    },
  };
}

/** Shares one application focus stack among dialogs in the same document. */
export function browserFocusManager(document: Document): FocusManager {
  let manager = managers.get(document);
  if (!manager) {
    manager = new FocusManager(browserFocusDom(document));
    managers.set(document, manager);
  }
  return manager;
}
