import { validateCreateFormRequest, validateCreateRequest } from "./contracts.mjs";

/* Retains a host-only creation target while the renderer collects validated secrets. */
export class CreationTargetFlow {
  #target = null;
  #creating = false;

  /* Chooses the target before any creation secret crosses the renderer boundary. */
  async chooseTarget(chooseTarget) {
    if (this.#creating) throw new Error("Document creation is already in progress");
    const target = await chooseTarget();
    this.#target = target;
    return target === null ? null : Object.freeze({ selected: true });
  }

  /* Forgets a selected target when the security dialog is canceled. */
  cancel() {
    this.#target = null;
  }

  /* Validates a dialog request and creates at the retained target. */
  async create(request, createDocument) {
    if (this.#target === null) {
      throw new Error("Choose a target before entering document passwords");
    }
    if (this.#creating) throw new Error("Document creation is already in progress");
    const validated = validateCreateFormRequest(request);
    const target = this.#target;
    this.#creating = true;
    try {
      const result = await createDocument(target, validateCreateRequest(validated));
      this.#target = null;
      return result;
    } finally {
      this.#creating = false;
    }
  }
}
