import path from "node:path";
import { createHash } from "node:crypto";
import { validateEditMode, validateOpenedDocument,
  validateRevisionActivityPage } from "./contracts.mjs";

/* Coordinates published activity attempts, external actions, outcomes, and recovery. */
export class ActivityEventWorkflow {
  constructor({ host, inspect, adopt, queueJournalOperation,
    queuePublication, loadProfile }) {
    this.host = host;
    this.inspect = inspect;
    this.adopt = adopt;
    this.queueJournalOperation = queueJournalOperation;
    this.queuePublication = queuePublication;
    this.loadProfile = loadProfile;
  }

  available() {
    if (!this.host.container || typeof this.host.container.prepareActivity !== "function"
        || typeof this.host.container.completeActivity !== "function"
        || typeof this.host.container.restoreActivity !== "function"
        || typeof this.host.container.activityStatus !== "function") {
      throw new Error("Native activity interface is unavailable");
    }
    return true;
  }

  async #publishCandidate(active, phase, kind, source, profile) {
    if (this.host.pendingNativeCandidate !== null || !this.host.containerBytes?.equals(source)
        || !active.baseContainer.equals(source)) {
      throw new Error("Activity source changed before publication");
    }
    const candidate = this.host.container.prepareActivity(phase, active.password, {
      operationId: this.host.nextCandidateOperation++, kind,
      cleanStateConfirmed: kind === "backup" && !active.dirty
        && !active.recovery && !active.pendingPublication && !active.unresolvedJournal,
      observedTarget: source, clientName: profile.name,
      clientEmail: profile.email, deviceName: profile.deviceName,
      timestampMs: this.host.now() });
    if (!Buffer.isBuffer(candidate.bytes) || candidate.bytes.length === 0) {
      this.host.container.finishSave(candidate.operationId, "definite-failure");
      throw new Error("Native activity candidate has no container bytes");
    }
    this.host.pendingNativeCandidate = candidate.operationId;
    try {
      const candidateOpened = this.inspect(candidate.bytes, active.password);
      let activity;
      try {
        const expected = `${kind}-${phase === "attempt" ? "attempted"
          : active.pendingActivity?.succeeded ? "succeeded" : "failed"}`;
        if (candidateOpened.documentId !== active.documentId
            || candidateOpened.opened.content !== active.targetContent
            || candidateOpened.historyEventType !== expected) {
          throw new Error("Native activity candidate does not match its source");
        }
        activity = phase === "attempt"
          ? { kind, attemptOperationId: candidate.operationId,
            attemptHead: candidateOpened.baseRevision, succeeded: false,
            actionState: "not-started" }
          : active.pendingActivity;
      } finally { candidateOpened.journalKey.fill(0); }
      if (!activity) throw new Error("No pending activity outcome is available");
      await this.queueJournalOperation(async () => {
        const prior = await this.host.journals.read(active.documentId, active.journalKey);
        if (prior?.publication) throw new Error(
          "Resolve the pending publication before recording activity");
        const journalRecord = prior ? { ...prior, activity,
          updateTime: this.host.now() } : {
          text: active.opened.content, baseRevision: active.baseRevision,
          cursor: { start: 0, end: 0 }, target: active.target,
          state: "activity-outcome", updateTime: this.host.now(), activity };
        await this.host.candidates.publish(this.host.container, candidate,
          { documentId: active.documentId,
            journalKey: active.journalKey, target: active.target,
            base: source, text: journalRecord.text,
            cursor: journalRecord.cursor,
            baseRevision: journalRecord.baseRevision,
            state: journalRecord.state,
            purpose: `activity-${phase}`, journalRecord });
      });
      this.host.containerBytes = Buffer.from(candidate.bytes);
      await this.adopt(active, candidate.bytes);
      return candidate;
    } catch (error) {
      if (this.host.pendingNativeCandidate === candidate.operationId) {
        const prepared = Boolean(error.publicationPrepared);
        this.host.candidates.finish(this.host.container, candidate.operationId,
          prepared ? "ambiguous" : "definite-failure");
        if (prepared) {
          active.pendingPublication = true;
          active.pendingRecord = await this.host.journals.read(
            active.documentId, active.journalKey);
          active.pendingActivity = active.pendingRecord?.activity ?? null;
          active.unresolvedJournal = true;
          active.opened = (active.editMode ? validateEditMode : validateOpenedDocument)({
            ...active.opened, publicationState: "pending-publication",
            activityOutcomePending: true });
        }
      }
      throw error;
    }
  }

  async run(kind, action, externalTarget, expectedPlaintext = null) {
    const active = this.host.active;
    if (active.pendingActivity || active.pendingPublication || active.headMismatch
        || active.unreadableJournal) {
      throw new Error("Resolve pending document activity before starting another action");
    }
    const profile = await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    return this.queuePublication(async () => {
      const source = await this.host.fs.readFile(active.target);
      if (this.host.active !== active || !source.equals(active.baseContainer)) {
        throw new Error("Activity source changed before attempt publication");
      }
      const attempt = await this.#publishCandidate(active, "attempt", kind,
        source, profile);
      const status = this.host.container.activityStatus();
      if (!status.hasPending || status.kind !== kind
          || status.attemptOperationId !== attempt.operationId) {
        throw new Error("Native activity attempt was not adopted");
      }
      const started = { kind, attemptOperationId: attempt.operationId,
        attemptHead: status.attemptHead, succeeded: false,
        actionState: "started", externalTarget,
        externalHash: createHash("sha256").update(
          expectedPlaintext ?? active.baseContainer).digest("hex") };
      active.pendingActivity = { ...started, actionState: "not-started" };
      active.unresolvedJournal = true;
      active.opened = (active.editMode ? validateEditMode : validateOpenedDocument)({
        ...active.opened, readOnly: !active.editMode,
        activityOutcomePending: true });
      await this.#writeJournal(active, started);
      active.pendingActivity = started;
      let succeeded = false;
      let actionResult;
      let actionError;
      try { actionResult = await action(); succeeded = true; }
      catch (error) {
        if (error.activityOutcomeUnknown) {
          active.opened = (active.editMode ? validateEditMode : validateOpenedDocument)({
            ...active.opened, activityConfirmationRequired: true });
          this.host.onJournalWarning("ACTIVITY_OUTCOME_PENDING");
          return { succeeded: false, outcomePending: true, actionError: error };
        }
        actionError = error;
      }
      this.host.container.completeActivity(attempt.operationId, succeeded);
      const activity = { kind, attemptOperationId: attempt.operationId,
        attemptHead: status.attemptHead, succeeded, actionState: "known",
        externalTarget: started.externalTarget, externalHash: started.externalHash };
      active.pendingActivity = activity;
      try { await this.#writeJournal(active, activity); }
      catch {
        this.host.onJournalWarning("ACTIVITY_OUTCOME_PENDING");
        return { succeeded, outcomePending: true, actionResult, actionError };
      }
      let outcomePending = false;
      try { await this.reconcile(active, profile); }
      catch { outcomePending = true; this.host.onJournalWarning("ACTIVITY_OUTCOME_PENDING"); }
      return { succeeded, outcomePending, actionResult, actionError };
    });
  }

  async #writeJournal(active, activity) {
    await this.queueJournalOperation(async () => {
      const prior = await this.host.journals.read(active.documentId, active.journalKey);
      const record = prior ? { ...prior, activity,
        baseRevision: active.baseRevision, updateTime: this.host.now() }
        : { text: active.opened.content, baseRevision: active.baseRevision,
          cursor: { start: 0, end: 0 }, target: active.target,
          state: "activity-outcome", updateTime: this.host.now(), activity };
      await this.host.journals.write(active.documentId, active.journalKey, record);
    });
  }

  async resolve({ succeeded, replicaTarget } = {}) {
    const active = this.host.active;
    if (!active?.pendingActivity || active.pendingPublication) {
      throw new Error("No reconcilable activity outcome is available");
    }
    return this.queuePublication(async () => {
      const pending = active.pendingActivity;
      if (this.host.active !== active || !pending || active.pendingPublication) {
        throw new Error("Activity outcome changed before reconciliation");
      }
      const journal = await this.host.journals.read(active.documentId, active.journalKey);
      if (journal?.publication || journal?.activity?.attemptHead !== pending.attemptHead
          || journal.activity.attemptOperationId !== pending.attemptOperationId
          || journal.activity.kind !== pending.kind
          || (journal.activity.actionState === "known"
            && (pending.actionState !== "known"
              || journal.activity.succeeded !== pending.succeeded))) {
        throw new Error("Activity journal changed before reconciliation");
      }
      if (pending.actionState === "started") {
        if (typeof succeeded !== "boolean") {
          throw new TypeError("Confirm whether the interrupted host action completed");
        }
        if (succeeded) {
          const target = pending.kind === "backup" ? replicaTarget
            : pending.externalTarget;
          if (typeof target !== "string" || !target || target.includes("\0")
              || path.resolve(target) === path.resolve(active.target)) {
            throw new TypeError("Select the completed external result for verification");
          }
          const observed = await this.host.fs.readFile(target);
          if (createHash("sha256").update(observed).digest("hex")
              !== pending.externalHash
              || (pending.kind === "backup"
                && !observed.equals(active.baseContainer))) {
            throw new Error("External result differs from the attempted action");
          }
        }
        const known = { ...pending, succeeded, actionState: "known" };
        await this.#writeJournal(active, known);
        active.pendingActivity = known;
        active.opened = (active.editMode ? validateEditMode : validateOpenedDocument)({
          ...active.opened, activityConfirmationRequired: undefined });
      } else {
        if (succeeded !== undefined || replicaTarget !== undefined) {
          throw new TypeError("The activity outcome is already known; retry publication");
        }
        if (pending.actionState === "known"
            && journal.activity.actionState !== "known") {
          await this.#writeJournal(active, pending);
        }
      }
      try { await this.reconcile(active); }
      catch { this.host.onJournalWarning("ACTIVITY_OUTCOME_PENDING"); }
      return active.opened;
    });
  }

  async reconcile(active, suppliedProfile = null) {
    const pending = active.pendingActivity;
    if (!pending) return;
    if (pending.actionState === "started") {
      const error = new Error(
        "The interrupted host action outcome requires confirmation");
      error.code = "ACTIVITY_OUTCOME_CONFIRMATION_REQUIRED";
      throw error;
    }
    const source = await this.host.fs.readFile(active.target);
    if (!source.equals(active.baseContainer)) {
      throw new Error("Activity source changed before outcome publication");
    }
    const status = this.host.container.activityStatus();
    if (!status.hasPending) {
      const head = validateRevisionActivityPage(
        this.host.container.historyPage(0, 1), 0, 1).items[0];
      const expectedEvent = `${pending.kind}-${pending.succeeded
        ? "succeeded" : "failed"}`;
      if (head?.eventType === expectedEvent
          && head.previousHead === pending.attemptHead
          && head.details?.note === `attempt=${pending.attemptHead}`) {
        await this.#clearJournal(active, pending);
        return;
      }
      this.host.container.restoreActivity({ ...pending, observedTarget: source });
    } else {
      if (status.kind !== pending.kind
          || status.attemptOperationId !== pending.attemptOperationId
          || status.attemptHead !== pending.attemptHead
          || (status.hostActionComplete
            && status.succeeded !== pending.succeeded)) {
        throw new Error("Native pending activity differs from its journal");
      }
      if (!status.hostActionComplete) {
        this.host.container.completeActivity(pending.attemptOperationId,
          pending.succeeded);
      }
    }
    this.host.nextCandidateOperation = Math.max(this.host.nextCandidateOperation,
      pending.attemptOperationId + 1);
    const profile = suppliedProfile ?? await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    await this.#publishCandidate(active, "outcome", pending.kind,
      source, profile);
    await this.#clearJournal(active, pending);
  }

  async #clearJournal(active, pending) {
    await this.queueJournalOperation(async () => {
      const record = await this.host.journals.read(active.documentId, active.journalKey);
      if (record?.activity?.attemptHead !== pending.attemptHead
          || record.activity.attemptOperationId !== pending.attemptOperationId
          || record.activity.kind !== pending.kind
          || record.activity.succeeded !== pending.succeeded
          || record.activity.actionState !== pending.actionState) {
        throw new Error("Activity journal changed before clearing its outcome");
      }
      if (record.state === "activity-outcome") {
        await this.host.journals.clear(active.documentId);
        active.unresolvedJournal = false;
      } else {
        const { activity: _activity, ...rest } = record;
        await this.host.journals.write(active.documentId, active.journalKey,
          { ...rest, baseRevision: active.baseRevision, updateTime: this.host.now() });
      }
    });
    active.pendingActivity = null;
    active.opened = (active.editMode ? validateEditMode : validateOpenedDocument)({
      ...active.opened, readOnly: !active.editMode,
      activityOutcomePending: false, activityConfirmationRequired: undefined });
  }
}
