import { needsCloseDecision } from "./close-document.mjs";

/* Intercepts native termination until the shared session-protection policy succeeds. */
export class NativeLifecycleCoordinator {
  constructor({ getService, protections, lockActive, closeWindow, report }) {
    this.getService = getService;
    this.protections = protections;
    this.lockActive = lockActive;
    this.closeWindow = closeWindow;
    this.report = report;
    this.releasing = false;
    this.operation = null;
  }

  async requestExit() {
    return this.protections.authorize("exit", () => this.#releaseAndClose());
  }

  handleClose(event) {
    if (this.releasing) return Promise.resolve(true);
    const service = this.getService();
    const active = service.active;
    const needsProtection = needsCloseDecision(active)
      || service.hasActivePublication?.() === true;
    if (!active || (!active.editMode && !needsProtection)) return Promise.resolve(true);
    event.preventDefault();
    if (this.operation) return this.operation;
    this.operation = (async () => {
      return this.protections.authorize("exit", () => this.#releaseAndClose(service));
    })().catch((error) => {
      this.report(`Could not finish exit: ${error.message}`);
      return false;
    }).finally(() => { this.operation = null; });
    return this.operation;
  }

  async #releaseAndClose(expected = this.getService()) {
    const service = this.getService();
    if (service !== expected) throw new Error("The document changed before native close cleanup");
    if (service.active?.editMode) {
      try { await service.exitEditMode(); }
      catch { await this.lockActive("app-exit"); }
    }
    this.releasing = true;
    this.closeWindow();
  }
}
