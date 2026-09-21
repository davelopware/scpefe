import { completeOpenReplacement, createReplacement, disposeReplacement,
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
    const staged = await createReplacement({ makeCandidate: this.makeCandidate,
      target, request, authorizeCurrent: this.authorizeCurrent });
    this.adopt(staged, target);
    return staged.opened;
  }

  async open(target, password) {
    if (this.invitation) throw new Error("Finish or cancel the invitation claim first");
    const staged = await stageOpenReplacement({ makeCandidate: this.makeCandidate,
      target, password });
    if (staged.opened.invitationRequired) {
      let authorized;
      try {
        authorized = await this.authorizeCurrent();
      } catch (error) {
        await disposeReplacement(staged);
        throw error;
      }
      if (!authorized) {
        await disposeReplacement(staged);
        const error = new Error("The current document remains open");
        error.code = "DOCUMENT_REPLACEMENT_CANCELED";
        throw error;
      }
      this.invitation = staged;
      return Object.freeze({ readOnly: true, invitationRequired: true });
    }
    const completed = await completeOpenReplacement({ staged,
      authorizeCurrent: this.authorizeCurrent });
    this.adopt(completed, target);
    return completed.opened;
  }

  async claim(password) {
    if (!this.invitation) throw new Error("No staged invitation is awaiting a claim");
    const staged = this.invitation;
    const opened = await staged.candidate.claimInvitation(password);
    await staged.candidate.revalidateTargetForReplacement();
    this.adopt(staged, staged.target);
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
