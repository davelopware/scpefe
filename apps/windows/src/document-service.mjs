import path from "node:path";
import { randomBytes } from "node:crypto";
import { canonicalizeDocumentText, validateCreateRequest, validateEditMode,
  validateOpenedDocument, validatePassword, validateProfile,
  validatePlaintextExportRequest, validatePlaintextExportResult,
  validatePublicationResult, validateSaveResult, validateWorkingCopy } from "./contracts.mjs";
import { WorkJournalStore } from "./work-journal.mjs";
import { PublicationService } from "./publication.mjs";
import { HeadWitnessStore } from "./head-witness.mjs";

const DOCUMENT_ID = /^[0-9a-f]{32}$/;
const REVISION_ID = /^[0-9a-f]{64}$/;
const HEARTBEAT_MS = 120_000;
const DEFAULT_LEASE_DURATION_MS = 600_000;
const UNAVAILABLE_CODES = new Set([
  "ENOENT", "ENOTDIR", "EACCES", "EIO", "ENODEV", "ESTALE", "ETIMEDOUT",
  "ECONNRESET",
]);

function targetUnavailable(error) {
  return UNAVAILABLE_CODES.has(error?.code);
}

export class DocumentService {
  constructor({ native, fs, profilePath, journalDirectory,
    publicationCapabilities, witnessDirectory,
    nativeLineEnding = process.platform === "win32" ? "\r\n" : "\n",
    checkpointIdleMs = 10_000, checkpointContinuousMs = 30_000,
    inactivityMs = 120_000, now = () => Date.now(),
    utcNow = now, monotonicNow = now, randomSessionId = () => randomBytes(16),
    setTimer = setTimeout, clearTimer = clearTimeout,
    onLocked = () => {}, onJournalWarning = () => {} }) {
    this.native = native;
    this.fs = fs;
    this.profilePath = profilePath;
    this.nativeLineEnding = nativeLineEnding;
    this.journals = new WorkJournalStore({ fs,
      directory: journalDirectory ?? path.join(path.dirname(profilePath), "work-journals") });
    this.publications = new PublicationService({ fs, journals: this.journals,
      capabilities: publicationCapabilities, now });
    this.witnesses = new HeadWitnessStore({ fs,
      directory: witnessDirectory ?? path.join(path.dirname(profilePath), "head-witnesses") });
    this.checkpointIdleMs = checkpointIdleMs;
    this.checkpointContinuousMs = checkpointContinuousMs;
    this.inactivityMs = inactivityMs;
    this.now = now;
    this.utcNow = utcNow;
    this.monotonicNow = monotonicNow;
    this.randomSessionId = randomSessionId;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onLocked = onLocked;
    this.onJournalWarning = onJournalWarning;
    this.checkpointTimer = null;
    this.inactivityTimer = null;
    this.heartbeatTimer = null;
    this.heartbeatOperation = null;
    this.leaseGeneration = 0;
    this.flushChain = Promise.resolve();
    this.publicationChain = Promise.resolve();
    this.active = null;
    this.suspendedLeases = new Map();
    this.leaseObservations = new Map();
  }

  async loadProfile() {
    try {
      return validateProfile(JSON.parse(await this.fs.readFile(this.profilePath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async saveProfile(profile) {
    const validated = validateProfile(profile);
    await this.fs.mkdir(path.dirname(this.profilePath), { recursive: true });
    await this.#atomicWrite(this.profilePath,
      Buffer.from(`${JSON.stringify(validated)}\n`, "utf8"), true);
    return validated;
  }

  async createDocument(target, request) {
    const profile = await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    const input = validateCreateRequest(request);
    const candidate = this.native.createDocument({
      ...profile,
      ...input,
      timestampMs: Date.now(),
    });
    if (!Buffer.isBuffer(candidate) || candidate.length === 0) {
      throw new Error("Native bridge did not produce a container");
    }
    await this.#queuePublication(async () => {
      await this.#atomicWrite(target, candidate, false);
      const published = await this.fs.readFile(target);
      if (!published.equals(candidate)) throw new Error("Published container verification failed");
      const opened = this.#validateNativeOpened(
        this.native.openDocument(published, input.ownerPassword));
      await this.witnesses.observe(target, this.#observation(opened));
      opened.journalKey.fill(0);
    });
    return { created: true };
  }

  async openDocument(target, password) {
    const validatedPassword = validatePassword(password);
    const bootstrap = await this.journals.findPublication(target);
    if (bootstrap) {
      return this.#openPendingDocument(target, validatedPassword, bootstrap);
    }
    let bytes = await this.fs.readFile(target);
    let nativeOpened = this.#validateNativeOpened(
      this.native.openDocument(bytes, validatedPassword));
    let recovery = null;
    let pendingPublication = false;
    let pendingRecord = null;
    let publicationState = "target-published";
    try {
      const journal = await this.journals.read(
        nativeOpened.documentId, nativeOpened.journalKey);
      if (journal?.publication) {
        pendingPublication = true;
        pendingRecord = journal;
        publicationState = journal.state === "conflict" ? "conflict" : "pending-publication";
        this.#validateCandidate(journal, validatedPassword, nativeOpened.documentId);
        const resumed = journal.state === "conflict" ? { completed: false, reason: "changed" }
          : await this.publications.resume(
            nativeOpened.documentId, nativeOpened.journalKey, journal);
        if (resumed.completed) {
          pendingPublication = false;
          pendingRecord = null;
          publicationState = "target-published";
          const published = await this.fs.readFile(target);
          bytes = published;
          nativeOpened.journalKey.fill(0);
          nativeOpened = this.#validateNativeOpened(
            this.native.openDocument(published, validatedPassword));
          this.onJournalWarning("Interrupted publication was completed and verified.");
        } else if (resumed.reason === "changed") {
          pendingRecord = await this.publications.markDiverged(
            nativeOpened.documentId, nativeOpened.journalKey, journal);
          publicationState = "conflict";
          this.onJournalWarning(
            "The target changed while publication was pending; divergence must be resolved.");
        } else if (resumed.reason === "ambiguous") {
          this.onJournalWarning(
            "Interrupted publication needs confirmation; recovery data was preserved.");
        }
      }
      if (journal?.state === "unsaved"
          && journal.baseRevision === nativeOpened.baseRevision) {
        recovery = journal;
      }
    } catch (error) {
      this.onJournalWarning(`Recovered work could not be read: ${error.message}`);
    }
    const targetOpened = nativeOpened.opened;
    let headMismatch = null;
    try {
      const { comparison, previous } = await this.witnesses.observe(
        target, this.#observation(nativeOpened));
      headMismatch = this.#headMismatch(comparison.kind, previous, nativeOpened);
    } catch (error) {
      headMismatch = Object.freeze({ kind: "witness-error",
        title: "Local head witness could not be authenticated",
        explanation: `${error.message}. The document remains available read-only, but editing and saving are blocked until you explicitly accept this authenticated head.`,
        editingBlocked: true, observedDocumentId: nativeOpened.documentId,
        observedHead: nativeOpened.baseRevision });
    }
    const slotCanEdit = nativeOpened.opened.canEdit;
    const opened = validateOpenedDocument({ ...nativeOpened.opened,
      lease: nativeOpened.lease.active ? nativeOpened.lease : undefined,
      canEdit: headMismatch ? false : slotCanEdit,
      ...(pendingRecord ? { content: pendingRecord.text } : {}), publicationState,
      ...(headMismatch ? { headMismatch } : {}),
      ...(recovery ? { recovery: { content: recovery.text,
        cursor: recovery.cursor, state: "unsaved",
        updateTime: recovery.updateTime } } : {}) });
    this.active = { target, password: validatedPassword, opened, editMode: false,
      documentId: nativeOpened.documentId, baseRevision: nativeOpened.baseRevision,
      revisionGraph: nativeOpened.revisionGraph, observation: this.#observation(nativeOpened),
      slotCanEdit, headMismatch,
      journalKey: Buffer.from(nativeOpened.journalKey), recovery,
      baseContainer: Buffer.from(bytes), targetContent: targetOpened.content,
      working: null, dirty: false,
      pendingPublication, pendingRecord,
      continuousDue: null, journalWarning: null };
    nativeOpened.journalKey.fill(0);
    this.notifyActivity();
    return opened;
  }

  async enterEditMode({ forceTakeover = false } = {}) {
    if (!this.active) throw new Error("Open a document first");
    if (this.active.pendingPublication) {
      throw new Error("Resolve the interrupted publication before editing");
    }
    if (this.active.recovery) {
      throw new Error("Restore or discard recovered work before editing");
    }
    if (this.active.headMismatch) {
      throw new Error("Accept or resolve the head mismatch before editing");
    }
    if (!this.active.opened.canEdit) {
      throw new Error("The active password slot does not permit editing");
    }
    await this.#acquireLease(forceTakeover);
    this.active.editMode = true;
    this.active.working = { content: this.active.opened.content,
      cursor: { start: 0, end: 0 } };
    return validateEditMode({ ...this.active.opened, readOnly: false });
  }

  publicationCapabilities() {
    return this.publications.replacementCapabilities();
  }

  async restoreRecoveredWork() {
    if (!this.active?.recovery) throw new Error("No recovered work is available");
    if (this.active.pendingPublication) {
      throw new Error("Resolve the interrupted publication before editing");
    }
    if (this.active.headMismatch) {
      throw new Error("Accept or resolve the head mismatch before editing");
    }
    if (!this.active.opened.canEdit) {
      throw new Error("The active password slot does not permit editing");
    }
    await this.#acquireLease(false);
    this.active.editMode = true;
    this.active.working = { content: this.active.recovery.text,
      cursor: { ...this.active.recovery.cursor } };
    this.active.dirty = true;
    this.notifyActivity();
    return Object.freeze({ content: this.active.working.content, readOnly: false,
      canEdit: true, recoveredUnsaved: true,
      cursor: Object.freeze({ ...this.active.working.cursor }) });
  }

  async discardRecoveredWork() {
    if (!this.active?.recovery) throw new Error("No recovered work is available");
    await this.journals.clear(this.active.documentId);
    this.active.recovery = null;
    this.active.opened = validateOpenedDocument({
      content: this.active.opened.content, readOnly: true,
      canEdit: this.active.headMismatch ? false : this.active.slotCanEdit,
      publicationState: this.active.opened.publicationState,
      ...(this.active.opened.lease ? { lease: this.active.opened.lease } : {}),
      ...(this.active.headMismatch ? { headMismatch: this.active.headMismatch } : {}) });
    return this.active.opened;
  }

  async acceptHeadMismatch() {
    if (!this.active?.headMismatch) throw new Error("No head mismatch is available");
    await this.witnesses.accept(this.active.target, this.active.observation);
    this.active.headMismatch = null;
    this.active.opened = validateOpenedDocument({
      content: this.active.opened.content, readOnly: true,
      canEdit: this.active.slotCanEdit,
      publicationState: this.active.opened.publicationState,
      ...(this.active.opened.lease ? { lease: this.active.opened.lease } : {}),
      ...(this.active.opened.recovery ? { recovery: this.active.opened.recovery } : {}),
    });
    return this.active.opened;
  }

  async reconnectPendingPublication() {
    const active = this.active;
    if (!active?.pendingPublication || !active.pendingRecord) {
      throw new Error("No pending publication is available");
    }
    let target;
    try {
      target = await this.fs.readFile(active.target);
    } catch (error) {
      if (targetUnavailable(error)) {
        return validatePublicationResult({ publicationState: "pending-publication",
          content: active.pendingRecord.text });
      }
      throw error;
    }
    let targetOpened;
    try {
      targetOpened = this.#validateNativeOpened(
        this.native.openDocument(target, active.password));
    } catch {
      return this.#markActiveConflict(active);
    }
    try {
      if (targetOpened.documentId !== active.documentId) {
        return await this.#markActiveConflict(active);
      }
    } finally {
      targetOpened.journalKey.fill(0);
    }
    this.#validateCandidate(active.pendingRecord, active.password, active.documentId);
    const resumed = await this.publications.resume(
      active.documentId, active.journalKey, active.pendingRecord);
    if (resumed.completed) {
      await this.#adoptPublishedCandidate(active);
      return validatePublicationResult({ publicationState: "target-published",
        content: active.opened.content });
    }
    if (resumed.reason === "changed") {
      active.pendingRecord = await this.publications.markDiverged(
        active.documentId, active.journalKey, active.pendingRecord);
      active.opened = validateOpenedDocument({ ...active.opened,
        publicationState: "conflict" });
      return validatePublicationResult({ publicationState: "conflict",
        content: active.pendingRecord.text });
    }
    return validatePublicationResult({ publicationState: "pending-publication",
      content: active.pendingRecord.text });
  }

  async discardPendingPublication() {
    const active = this.active;
    if (!active?.pendingPublication || !active.pendingRecord) {
      throw new Error("No pending publication is available");
    }
    await this.publications.discard(
      active.documentId, active.journalKey, active.pendingRecord);
    active.pendingPublication = false;
    active.pendingRecord = null;
    active.working = null;
    active.dirty = false;
    active.opened = validateOpenedDocument({ content: active.targetContent,
      readOnly: true, canEdit: active.headMismatch ? false : active.slotCanEdit,
      publicationState: "target-published",
      ...(active.opened.lease ? { lease: active.opened.lease } : {}),
      ...(active.headMismatch ? { headMismatch: active.headMismatch } : {}) });
    return active.opened;
  }

  updateWorkingCopy(value) {
    if (!this.active?.editMode) throw new Error("Enter edit mode before editing");
    if (this.active.pendingPublication) {
      throw new Error("Resolve the interrupted publication before editing");
    }
    const working = validateWorkingCopy(value);
    this.active.working = working;
    this.active.dirty = working.content !== this.active.opened.content;
    if (this.active.dirty) this.#scheduleCheckpoint();
    this.notifyActivity();
    return { checkpointScheduled: this.active.dirty,
      warning: this.active.journalWarning };
  }

  notifyActivity() {
    if (!this.active) return { tracked: false };
    if (this.inactivityTimer !== null) this.clearTimer(this.inactivityTimer);
    this.inactivityTimer = this.setTimer(() => {
      void this.lock("inactivity");
    }, this.inactivityMs);
    this.inactivityTimer?.unref?.();
    return { tracked: true };
  }

  async lock(reason = "app-lock") {
    const active = this.active;
    if (!active) return { locked: true, journalSaved: true, warning: null };
    this.#cancelCheckpoint();
    if (this.inactivityTimer !== null) this.clearTimer(this.inactivityTimer);
    this.inactivityTimer = null;
    await this.#stopHeartbeat();
    let journalSaved = true;
    let warning = null;
    try {
      await this.#flushActive(active);
    } catch (error) {
      journalSaved = false;
      warning = `Latest changes could not be checkpointed: ${error.message}`;
    } finally {
      if (active.leaseSessionId) {
        this.suspendedLeases.set(active.documentId, {
          sessionId: Buffer.from(active.leaseSessionId),
          counter: active.leaseCounter,
        });
      }
      active.journalKey.fill(0);
      active.working = null;
      active.recovery = null;
      active.password = "";
      this.active = null;
    }
    const result = Object.freeze({ locked: true, journalSaved, warning, reason });
    this.onLocked(result);
    return result;
  }

  async exitEditMode() {
    const active = this.active;
    if (!active?.editMode) return { released: false };
    await this.#stopHeartbeat();
    await this.#flushActive(active);
    await this.#queuePublication(async () => {
      const current = await this.fs.readFile(active.target);
      const inspected = this.#validateNativeOpened(
        this.native.openDocument(current, active.password));
      const sameSession = inspected.lease.active
        && Buffer.from(inspected.lease.sessionId, "hex").equals(active.leaseSessionId);
      if (sameSession && inspected.lease.heartbeatCounter !== active.leaseCounter) {
        const error = new Error("Editing lease changed before it could be released");
        error.code = "LEASE_CHANGED";
        throw error;
      }
      if (sameSession) {
        const candidate = this.native.updateLease(current, active.password,
          { ...inspected.lease, active: false });
        await this.#atomicWrite(active.target, candidate, true);
      }
    });
    active.editMode = false;
    active.working = null;
    active.leaseSessionId = null;
    this.suspendedLeases.delete(active.documentId);
    return { released: true };
  }

  async saveDocument(content) {
    if (!this.active) throw new Error("Open a document first");
    if (!this.active.editMode) throw new Error("Enter edit mode before saving");
    if (this.active.pendingPublication) {
      throw new Error("Resolve the interrupted publication before saving");
    }
    if (this.active.headMismatch) {
      throw new Error("Accept or resolve the head mismatch before saving");
    }
    if (!this.active.opened.canEdit) {
      throw new Error("The active password slot does not permit editing");
    }
    const profile = await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    const canonical = canonicalizeDocumentText(content);
    this.#cancelCheckpoint();
    await this.flushChain.catch(() => {});
    const active = this.active;
    let reopened;
    let published;
    try {
      reopened = await this.#queuePublication(async () => {
        let current;
        try {
          current = await this.fs.readFile(active.target);
        } catch (error) {
          if (!targetUnavailable(error)) throw error;
          const candidate = this.native.saveDocument(
            active.baseContainer, active.password, {
              ...profile, content: canonical, timestampMs: Date.now(),
            });
          if (!Buffer.isBuffer(candidate) || candidate.length === 0) {
            throw new Error("Native bridge did not produce a container");
          }
          active.pendingRecord = await this.publications.prepare({
            documentId: active.documentId,
            journalKey: active.journalKey,
            target: active.target,
            base: active.baseContainer,
            candidate,
            text: canonical,
            cursor: { start: 0, end: 0 },
            baseRevision: active.baseRevision,
          });
          active.pendingPublication = true;
          active.working = { content: canonical, cursor: { start: 0, end: 0 } };
          active.dirty = false;
          active.opened = validateOpenedDocument({ ...active.opened,
            content: canonical, publicationState: "pending-publication" });
          return null;
        }
        const currentLease = this.#validateNativeOpened(
          this.native.openDocument(current, active.password)).lease;
        if (!currentLease.active || !active.leaseSessionId
            || !Buffer.from(currentLease.sessionId, "hex").equals(active.leaseSessionId)
            || currentLease.heartbeatCounter !== active.leaseCounter) {
          throw new Error("Editing lease is no longer held by this session");
        }
        const candidate = this.native.saveDocument(current, active.password, {
          ...profile, content: canonical, timestampMs: Date.now(),
        });
        if (!Buffer.isBuffer(candidate) || candidate.length === 0) {
          throw new Error("Native bridge did not produce a container");
        }
        await this.publications.publish({
          documentId: active.documentId,
          journalKey: active.journalKey,
          target: active.target,
          base: current,
          candidate,
          text: canonical,
          cursor: { start: 0, end: 0 },
          baseRevision: active.baseRevision,
        });
        published = await this.fs.readFile(active.target);
        return this.#validateNativeOpened(
          this.native.openDocument(published, active.password));
      });
    } catch (error) {
      if (error.publicationPrepared) {
        active.pendingPublication = true;
        active.pendingRecord = await this.journals.read(
          active.documentId, active.journalKey);
        active.opened = validateOpenedDocument({ ...active.opened,
          content: canonical, publicationState: "pending-publication" });
        active.working = { content: canonical, cursor: { start: 0, end: 0 } };
        active.dirty = false;
      }
      throw error;
    }
    if (!reopened) {
      return validateSaveResult({ saved: true, content: canonical,
        publicationState: "pending-publication" });
    }
    if (reopened.opened.content !== canonical) {
      reopened.journalKey.fill(0);
      throw new Error("Saved document verification failed");
    }
    this.active.journalKey.fill(0);
    this.active.opened = reopened.opened;
    this.active.documentId = reopened.documentId;
    this.active.baseRevision = reopened.baseRevision;
    this.active.revisionGraph = reopened.revisionGraph;
    this.active.observation = this.#observation(reopened);
    await this.witnesses.observe(this.active.target, this.active.observation);
    this.active.baseContainer = Buffer.from(published);
    this.active.targetContent = canonical;
    this.active.journalKey = Buffer.from(reopened.journalKey);
    reopened.journalKey.fill(0);
    this.active.working = { content: canonical, cursor: { start: 0, end: 0 } };
    this.active.dirty = false;
    this.active.pendingPublication = false;
    this.active.pendingRecord = null;
    this.active.recovery = null;
    this.active.continuousDue = null;
    this.notifyActivity();
    return validateSaveResult({ saved: true, content: canonical,
      publicationState: "target-published" });
  }

  async exportPlaintext(target, request) {
    if (!this.active) throw new Error("Open a document first");
    const validated = validatePlaintextExportRequest(request);
    const content = validated.lineEndings === "native"
      ? validated.content.replace(/\n/g, this.nativeLineEnding)
      : validated.content;
    await this.fs.writeFile(target, Buffer.from(content, "utf8"));
    return validatePlaintextExportResult({ exported: true });
  }

  #validateNativeOpened(value) {
    const opened = validateOpenedDocument(value);
    if (!DOCUMENT_ID.test(value?.documentId)
        || !REVISION_ID.test(value?.baseRevision)
        || !Buffer.isBuffer(value?.journalKey) || value.journalKey.length !== 32) {
      throw new TypeError("native bridge returned incomplete recovery metadata");
    }
    const rawLease = value.lease ?? { active: false, sessionId: "0".repeat(32),
      heartbeatCounter: 0, holderUtcMs: 0, durationMs: DEFAULT_LEASE_DURATION_MS,
      holderName: "", holderEmail: "", deviceName: "" };
    if (typeof rawLease.active !== "boolean"
        || !/^[0-9a-f]{32}$/.test(rawLease.sessionId)
        || !Number.isSafeInteger(rawLease.heartbeatCounter)
        || !Number.isSafeInteger(rawLease.holderUtcMs)
        || !Number.isSafeInteger(rawLease.durationMs) || rawLease.durationMs <= 0) {
      throw new TypeError("native bridge returned invalid editing lease metadata");
    }
    const revisionGraph = value.revisionGraph ?? [{ revisionId: value.baseRevision,
      parentRevisionIds: [] }];
    if (!Array.isArray(revisionGraph) || revisionGraph.length === 0
        || revisionGraph.some((node) => !node || !REVISION_ID.test(node.revisionId)
          || !Array.isArray(node.parentRevisionIds)
          || node.parentRevisionIds.some((parent) => !REVISION_ID.test(parent)))
        || !revisionGraph.some((node) => node.revisionId === value.baseRevision)) {
      throw new TypeError("native bridge returned an invalid authenticated revision graph");
    }
    return { opened, documentId: value.documentId,
      baseRevision: value.baseRevision, revisionGraph, journalKey: value.journalKey,
      lease: Object.freeze({ ...rawLease }) };
  }

  async #acquireLease(forceTakeover) {
    const active = this.active;
    const profile = await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    await this.#queuePublication(async () => {
      const bytes = await this.fs.readFile(active.target);
      const latest = this.#validateNativeOpened(
        this.native.openDocument(bytes, active.password));
      const lease = latest.lease;
      const suspended = this.suspendedLeases.get(active.documentId);
      const sessionMatches = lease.active && suspended
        && Buffer.from(lease.sessionId, "hex").equals(suspended.sessionId);
      const age = this.utcNow() - lease.holderUtcMs;
      if (sessionMatches && lease.heartbeatCounter !== suspended.counter) {
        const error = new Error("Editing lease changed while this session was locked");
        error.code = "LEASE_CHANGED";
        error.lease = lease;
        throw error;
      }
      const sameSession = sessionMatches && age >= 0 && age < lease.durationMs;
      if (lease.active && !sameSession) {
        const reliableExpiry = age >= lease.durationMs;
        const key = `${active.documentId}:${lease.sessionId}:${lease.heartbeatCounter}`;
        const firstSeen = this.leaseObservations.get(key) ?? this.monotonicNow();
        this.leaseObservations.set(key, firstSeen);
        const observedStale = this.monotonicNow() - firstSeen >= lease.durationMs;
        if (!reliableExpiry && !observedStale && !forceTakeover) {
          const error = new Error(`Editing lease held by ${lease.holderName || "another editor"}`);
          error.code = age < 0 ? "LEASE_CLOCK_UNCERTAIN" : "LEASE_ACTIVE";
          error.lease = lease;
          throw error;
        }
      }
      const sessionId = sameSession ? suspended.sessionId : this.randomSessionId();
      const nextLease = {
        active: true, sessionId: sessionId.toString("hex"),
        heartbeatCounter: sameSession ? lease.heartbeatCounter + 1 : 1,
        holderUtcMs: this.utcNow(), durationMs: lease.durationMs,
        holderName: profile.name, holderEmail: profile.email,
        deviceName: profile.deviceName,
      };
      const candidate = this.native.updateLease(bytes, active.password, nextLease);
      await this.#atomicWrite(active.target, candidate, true);
      active.baseContainer = Buffer.from(candidate);
      active.leaseSessionId = Buffer.from(sessionId);
      active.leaseCounter = nextLease.heartbeatCounter;
    });
    this.leaseGeneration += 1;
    this.#scheduleHeartbeat(this.leaseGeneration);
  }

  #scheduleHeartbeat(generation) {
    this.#cancelHeartbeat();
    this.heartbeatTimer = this.setTimer(() => {
      this.heartbeatTimer = null;
      if (generation !== this.leaseGeneration) return;
      const operation = this.#refreshLease(generation);
      this.heartbeatOperation = operation;
      void operation.catch((error) => {
        if (error?.code === "STALE_HEARTBEAT"
            || generation !== this.leaseGeneration) return;
        this.onJournalWarning(`Editing lease refresh failed: ${error.message}`);
        void this.lock("lease-refresh-failed");
      }).finally(() => {
        if (this.heartbeatOperation === operation) this.heartbeatOperation = null;
      });
    }, HEARTBEAT_MS);
    this.heartbeatTimer?.unref?.();
  }

  async #refreshLease(generation) {
    const active = this.active;
    if (!active?.editMode || !active.leaseSessionId
        || generation !== this.leaseGeneration) return;
    await this.#queuePublication(async () => {
      this.#requireCurrentHeartbeat(active, generation);
      const bytes = await this.fs.readFile(active.target);
      this.#requireCurrentHeartbeat(active, generation);
      const latest = this.#validateNativeOpened(
        this.native.openDocument(bytes, active.password));
      if (!latest.lease.active
          || !Buffer.from(latest.lease.sessionId, "hex").equals(active.leaseSessionId)
          || latest.lease.heartbeatCounter !== active.leaseCounter) {
        active.editMode = false;
        throw new Error("Editing lease was replaced by another client");
      }
      const nextLease = { ...latest.lease,
        heartbeatCounter: latest.lease.heartbeatCounter + 1,
        holderUtcMs: this.utcNow() };
      this.#requireCurrentHeartbeat(active, generation);
      const candidate = this.native.updateLease(bytes, active.password, nextLease);
      await this.#atomicWrite(active.target, candidate, true,
        () => active === this.active && generation === this.leaseGeneration);
      active.baseContainer = Buffer.from(candidate);
      active.leaseCounter = nextLease.heartbeatCounter;
      this.#requireCurrentHeartbeat(active, generation);
    });
    if (active === this.active && active.editMode
        && generation === this.leaseGeneration) this.#scheduleHeartbeat(generation);
  }

  #requireCurrentHeartbeat(active, generation) {
    if (active !== this.active || !active.editMode
        || generation !== this.leaseGeneration) {
      const error = new Error("Heartbeat no longer belongs to the active lease");
      error.code = "STALE_HEARTBEAT";
      throw error;
    }
  }

  #observation(opened) {
    return { documentId: opened.documentId, headRevision: opened.baseRevision,
      revisionGraph: opened.revisionGraph };
  }

  #headMismatch(kind, previous, opened) {
    const common = { editingBlocked: true,
      witnessedDocumentId: previous?.documentId,
      witnessedHead: previous?.headRevision,
      observedDocumentId: opened.documentId, observedHead: opened.baseRevision };
    if (kind === "rollback") return Object.freeze({ ...common, kind,
      title: "This target has rolled back",
      explanation: "The authenticated head is an ancestor of the last head seen by this client. This may be a stale replica; inspect it read-only and explicitly accept it only if the rollback is intended." });
    if (kind === "divergence") return Object.freeze({ ...common, kind,
      title: "This target has diverged",
      explanation: "The authenticated head is unrelated to the last head seen by this client. Resolve the divergent histories, or explicitly accept the current branch before editing." });
    if (kind === "replacement") return Object.freeze({ ...common, kind,
      title: "This target contains a different document",
      explanation: "The authenticated permanent document ID differs from the document previously observed at this target. Inspect it read-only and explicitly accept the replacement before editing." });
    return null;
  }

  #validateCandidate(record, password, documentId) {
    const candidate = Buffer.from(record.publication.candidate, "base64");
    const opened = this.#validateNativeOpened(this.native.openDocument(candidate, password));
    try {
      if (opened.documentId !== documentId || opened.opened.content !== record.text) {
        throw new Error("Pending publication candidate does not match its document");
      }
    } finally {
      opened.journalKey.fill(0);
    }
  }

  async #openPendingDocument(target, password, bootstrap) {
    let baseOpened = this.#validateNativeOpened(
      this.native.openDocument(bootstrap.base, password));
    if (baseOpened.documentId !== bootstrap.documentId) {
      baseOpened.journalKey.fill(0);
      throw new Error("Pending publication bootstrap does not match its document");
    }
    let record = await this.journals.read(
      baseOpened.documentId, baseOpened.journalKey);
    if (!record?.publication || record.target !== target) {
      baseOpened.journalKey.fill(0);
      throw new Error("Pending publication journal does not match its target");
    }
    this.#validateCandidate(record, password, baseOpened.documentId);

    let targetBytes = null;
    let targetOpened = null;
    let invalidTarget = false;
    let unavailable = false;
    try {
      targetBytes = await this.fs.readFile(target);
      targetOpened = this.#validateNativeOpened(
        this.native.openDocument(targetBytes, password));
      if (targetOpened.documentId !== baseOpened.documentId) invalidTarget = true;
    } catch (error) {
      if (targetUnavailable(error)) unavailable = true;
      else invalidTarget = true;
    }

    let publicationState = record.state === "conflict" ? "conflict" : "pending-publication";
    if (invalidTarget || (targetOpened && targetOpened.documentId !== baseOpened.documentId)) {
      if (record.state !== "conflict") {
        record = await this.publications.markDiverged(
          baseOpened.documentId, baseOpened.journalKey, record);
      }
      publicationState = "conflict";
      this.onJournalWarning(
        "The target was replaced or failed authentication; the pending candidate was preserved as a conflict.");
    } else if (!unavailable && record.state !== "conflict") {
      let resumed;
      try {
        resumed = await this.publications.resume(
          baseOpened.documentId, baseOpened.journalKey, record);
      } catch (error) {
        if (targetUnavailable(error)) unavailable = true;
        else throw error;
      }
      if (resumed?.completed) {
        const published = await this.fs.readFile(target);
        const reopened = this.#validateNativeOpened(
          this.native.openDocument(published, password));
        const { headMismatch, slotCanEdit } = await this.#observeHead(target, reopened);
        baseOpened.journalKey.fill(0);
        targetOpened?.journalKey.fill(0);
        const opened = validateOpenedDocument({ ...reopened.opened,
          canEdit: headMismatch ? false : slotCanEdit,
          publicationState: "target-published",
          ...(reopened.lease.active ? { lease: reopened.lease } : {}),
          ...(headMismatch ? { headMismatch } : {}) });
        this.active = { target, password, opened, editMode: false,
          documentId: reopened.documentId, baseRevision: reopened.baseRevision,
          revisionGraph: reopened.revisionGraph, observation: this.#observation(reopened),
          slotCanEdit, headMismatch,
          journalKey: Buffer.from(reopened.journalKey), recovery: null,
          baseContainer: Buffer.from(published), targetContent: reopened.opened.content,
          working: null, dirty: false, pendingPublication: false, pendingRecord: null,
          continuousDue: null, journalWarning: null };
        reopened.journalKey.fill(0);
        this.onJournalWarning("Interrupted publication was completed and verified.");
        this.notifyActivity();
        return opened;
      }
      if (resumed?.reason === "changed") {
        record = await this.publications.markDiverged(
          baseOpened.documentId, baseOpened.journalKey, record);
        publicationState = "conflict";
      }
    }
    if (unavailable) {
      this.onJournalWarning(
        "The target is unavailable; the manual save remains pending locally.");
    }

    const currentOpened = targetOpened && !invalidTarget ? targetOpened : baseOpened;
    const { headMismatch, slotCanEdit } = await this.#observeHead(target, currentOpened);
    const opened = validateOpenedDocument({ ...baseOpened.opened,
      content: record.text, canEdit: headMismatch ? false : slotCanEdit,
      publicationState,
      ...(currentOpened.lease.active ? { lease: currentOpened.lease } : {}),
      ...(headMismatch ? { headMismatch } : {}) });
    this.active = { target, password, opened, editMode: false,
      documentId: baseOpened.documentId, baseRevision: currentOpened.baseRevision,
      revisionGraph: currentOpened.revisionGraph,
      observation: this.#observation(currentOpened), slotCanEdit, headMismatch,
      journalKey: Buffer.from(baseOpened.journalKey), recovery: null,
      baseContainer: Buffer.from(targetBytes && !invalidTarget ? targetBytes : bootstrap.base),
      targetContent: currentOpened.opened.content,
      working: null, dirty: false, pendingPublication: true, pendingRecord: record,
      continuousDue: null, journalWarning: null };
    baseOpened.journalKey.fill(0);
    targetOpened?.journalKey.fill(0);
    this.notifyActivity();
    return opened;
  }

  async #adoptPublishedCandidate(active) {
    const published = await this.fs.readFile(active.target);
    const reopened = this.#validateNativeOpened(
      this.native.openDocument(published, active.password));
    const { headMismatch, slotCanEdit } = await this.#observeHead(
      active.target, reopened);
    active.journalKey.fill(0);
    active.opened = validateOpenedDocument({ ...reopened.opened,
      canEdit: headMismatch ? false : slotCanEdit,
      publicationState: "target-published",
      ...(reopened.lease.active ? { lease: reopened.lease } : {}),
      ...(headMismatch ? { headMismatch } : {}) });
    active.documentId = reopened.documentId;
    active.baseRevision = reopened.baseRevision;
    active.revisionGraph = reopened.revisionGraph;
    active.observation = this.#observation(reopened);
    active.slotCanEdit = slotCanEdit;
    active.headMismatch = headMismatch;
    active.baseContainer = Buffer.from(published);
    active.targetContent = reopened.opened.content;
    active.journalKey = Buffer.from(reopened.journalKey);
    reopened.journalKey.fill(0);
    active.working = { content: active.opened.content, cursor: { start: 0, end: 0 } };
    active.dirty = false;
    active.pendingPublication = false;
    active.pendingRecord = null;
    active.recovery = null;
  }

  async #observeHead(target, opened) {
    let headMismatch = null;
    try {
      const { comparison, previous } = await this.witnesses.observe(
        target, this.#observation(opened));
      headMismatch = this.#headMismatch(comparison.kind, previous, opened);
    } catch (error) {
      headMismatch = Object.freeze({ kind: "witness-error",
        title: "Local head witness could not be authenticated",
        explanation: `${error.message}. The document remains available read-only, but editing and saving are blocked until you explicitly accept this authenticated head.`,
        editingBlocked: true, observedDocumentId: opened.documentId,
        observedHead: opened.baseRevision });
    }
    return { headMismatch, slotCanEdit: opened.opened.canEdit };
  }

  async #markActiveConflict(active) {
    if (active.pendingRecord.state !== "conflict") {
      active.pendingRecord = await this.publications.markDiverged(
        active.documentId, active.journalKey, active.pendingRecord);
    }
    active.opened = validateOpenedDocument({ ...active.opened,
      publicationState: "conflict" });
    return validatePublicationResult({ publicationState: "conflict",
      content: active.pendingRecord.text });
  }

  #scheduleCheckpoint() {
    const active = this.active;
    const now = this.now();
    if (active.continuousDue === null) {
      active.continuousDue = now + this.checkpointContinuousMs;
    }
    if (this.checkpointTimer !== null) this.clearTimer(this.checkpointTimer);
    const due = Math.min(now + this.checkpointIdleMs, active.continuousDue);
    this.checkpointTimer = this.setTimer(() => {
      this.checkpointTimer = null;
      void this.#flushActive(active).catch((error) => {
        active.journalWarning = `Recovery checkpoint failed: ${error.message}`;
        this.onJournalWarning(active.journalWarning);
      });
    }, Math.max(0, due - now));
    this.checkpointTimer?.unref?.();
  }

  async #flushActive(active) {
    if (!active?.dirty || !active.working || active.pendingPublication) return;
    const record = {
      text: active.working.content,
      baseRevision: active.baseRevision,
      cursor: { ...active.working.cursor },
      target: active.target,
      state: "unsaved",
      updateTime: this.now(),
    };
    const operation = this.flushChain.catch(() => {}).then(() =>
      this.journals.write(active.documentId, active.journalKey, record));
    this.flushChain = operation;
    await operation;
    active.continuousDue = null;
    active.journalWarning = null;
  }

  #cancelHeartbeat() {
    if (this.heartbeatTimer !== null) this.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async #stopHeartbeat() {
    this.leaseGeneration += 1;
    this.#cancelHeartbeat();
    const operation = this.heartbeatOperation;
    if (operation) await operation.catch(() => {});
  }

  #cancelCheckpoint() {
    if (this.checkpointTimer !== null) this.clearTimer(this.checkpointTimer);
    this.checkpointTimer = null;
  }

  #queuePublication(operation) {
    const queued = this.publicationChain.catch(() => {}).then(operation);
    this.publicationChain = queued;
    return queued;
  }

  async #atomicWrite(target, bytes, replace, isCurrent = () => true) {
    const transaction = `${target}.scpefe-txn-${process.pid}-${Date.now()}`;
    let handle;
    try {
      handle = await this.fs.open(transaction, "wx");
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      if (!isCurrent()) {
        const error = new Error("Publication no longer belongs to the current state");
        error.code = "STALE_HEARTBEAT";
        throw error;
      }
      if (replace) {
        await this.fs.rename(transaction, target);
      } else {
        await this.fs.link(transaction, target);
        await this.fs.unlink(transaction);
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await this.fs.unlink(transaction).catch(() => {});
      throw error;
    }
  }
}
