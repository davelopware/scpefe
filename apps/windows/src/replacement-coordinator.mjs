import { createReplacement, disposeReplacement,
  stageOpenReplacement } from "./replacement-flow.mjs";

/* Owns staged replacement sessions until they can atomically become authoritative. */
export class ReplacementCoordinator {
  constructor({ makeCandidate, authorizeCurrent, adopt }) {
    this.makeCandidate = makeCandidate;
    this.authorizeCurrent = authorizeCurrent;
    this.adopt = adopt;
    this.invitation = null;
  }

  async create(target, request) {
    let staged;
    const authorized = await this.authorizeCurrent("new", async () => {
      staged = await createReplacement({ makeCandidate: this.makeCandidate,
        target, request, authorizeCurrent: async () => true });
      this.adopt(staged, target);
    });
    if (!authorized) throw canceledReplacement();
    return staged.opened;
  }

  async open(target, password, operation = "open") {
    if (this.invitation) throw new Error("Finish or cancel the invitation claim first");
    const staged = await stageOpenReplacement({ makeCandidate: this.makeCandidate,
      target, password });
    if (staged.opened.invitationRequired) {
      this.invitation = Object.freeze({ ...staged, operation });
      return Object.freeze({ readOnly: true, invitationRequired: true });
    }
    try {
      const authorized = await this.authorizeCurrent(operation, async () => {
        await staged.candidate.revalidateTargetForReplacement();
        this.adopt(staged, target);
      });
      if (!authorized) throw canceledReplacement();
      return staged.opened;
    } catch (error) {
      await disposeReplacement(staged);
      throw error;
    }
  }

  async claim(password) {
    if (!this.invitation) throw new Error("No staged invitation is awaiting a claim");
    const staged = this.invitation;
    let opened = null;
    const authorized = await this.authorizeCurrent(staged.operation, async () => {
      opened ??= await staged.candidate.claimInvitation(password);
      await staged.candidate.revalidateTargetForReplacement();
      this.adopt(staged, staged.target);
    });
    if (!authorized) throw canceledReplacement();
    this.invitation = null;
    return opened;
  }

  async cancelClaim() {
    if (!this.invitation) return false;
    const staged = this.invitation;
    await disposeReplacement(staged);
    this.invitation = null;
    return true;
  }

  hasStagedCandidate(candidate) {
    return this.invitation?.candidate === candidate;
  }
}

function canceledReplacement() {
  const error = new Error("The current document remains open");
  error.code = "DOCUMENT_REPLACEMENT_CANCELED";
  return error;
}
