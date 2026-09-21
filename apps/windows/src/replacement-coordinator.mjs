import { createReplacement, disposeReplacement,
  stageOpenReplacement } from "./replacement-flow.mjs";

/* Owns staged replacement sessions until they can atomically become authoritative. */
export class ReplacementCoordinator {
  constructor({ makeCandidate, authorizeCurrent, adopt, generation = null }) {
    this.makeCandidate = makeCandidate;
    this.authorizeCurrent = authorizeCurrent;
    this.adopt = adopt;
    this.generation = generation;
    this.invitation = null;
    this.candidates = new Set();
  }

  async create(target, request) {
    const generation = this.#capture(); let staged; let candidate;
    const authorized = await this.authorizeCurrent("new", async () => {
      try {
        staged = await createReplacement({ makeCandidate: () => {
          candidate = this.makeCandidate(); this.candidates.add(candidate); return candidate;
        },
          target, request, authorizeCurrent: async () => true });
        this.#assertCurrent(generation);
        this.adopt(staged, target);
        this.#assertCurrent(generation);
        this.candidates.delete(staged.candidate);
      } catch (error) {
        if (staged) await disposeReplacement(staged);
        if (candidate) this.candidates.delete(candidate);
        throw error;
      }
    });
    if (!authorized) throw canceledReplacement();
    return staged.opened;
  }

  async open(target, password, operation = "open") {
    const generation = this.#capture();
    if (this.invitation) throw new Error("Finish or cancel the invitation claim first");
    let staged; let candidate;
    try {
      staged = await stageOpenReplacement({ makeCandidate: () => {
        candidate = this.makeCandidate(); this.candidates.add(candidate); return candidate;
      },
        target, password });
      this.#assertCurrent(generation);
    } catch (error) {
      if (staged) await disposeReplacement(staged);
      if (candidate) this.candidates.delete(candidate);
      throw error;
    }
    if (staged.opened.invitationRequired) {
      this.invitation = Object.freeze({ ...staged, operation, generation });
      return Object.freeze({ readOnly: true, invitationRequired: true });
    }
    try {
      const authorized = await this.authorizeCurrent(operation, async () => {
        await staged.candidate.revalidateTargetForReplacement();
        this.#assertCurrent(generation);
        this.adopt(staged, target);
        this.#assertCurrent(generation);
        this.candidates.delete(staged.candidate);
      });
      if (!authorized) throw canceledReplacement();
      return staged.opened;
    } catch (error) {
      await disposeReplacement(staged);
      this.candidates.delete(staged.candidate);
      throw error;
    }
  }

  async claim(password) {
    if (!this.invitation) throw new Error("No staged invitation is awaiting a claim");
    const staged = this.invitation;
    const generation = staged.generation ?? this.#capture();
    let opened = null;
    let authorized;
    try {
      this.#assertCurrent(generation);
      authorized = await this.authorizeCurrent(staged.operation, async () => {
        opened ??= await staged.candidate.claimInvitation(password);
        this.#assertCurrent(generation);
        await staged.candidate.revalidateTargetForReplacement();
        this.#assertCurrent(generation);
        this.adopt(staged, staged.target);
        this.#assertCurrent(generation);
        this.candidates.delete(staged.candidate);
      });
    } catch (error) {
      if (!this.#isCurrent(generation)) {
        await disposeReplacement(staged);
        this.candidates.delete(staged.candidate);
        if (this.invitation === staged) this.invitation = null;
      }
      throw error;
    }
    if (!authorized) throw canceledReplacement();
    this.invitation = null;
    return opened;
  }

  async cancelClaim() {
    if (!this.invitation) return false;
    const staged = this.invitation;
    await disposeReplacement(staged);
    this.candidates.delete(staged.candidate);
    this.invitation = null;
    return true;
  }

  hasStagedCandidate(candidate) {
    return this.candidates.has(candidate);
  }

  #capture() { return this.generation?.capture() ?? 0; }
  #isCurrent(captured) { return this.generation?.isCurrent(captured) ?? true; }
  #assertCurrent(captured) { this.generation?.assertCurrent(captured); }
}

function canceledReplacement() {
  const error = new Error("The current document remains open");
  error.code = "DOCUMENT_REPLACEMENT_CANCELED";
  return error;
}
