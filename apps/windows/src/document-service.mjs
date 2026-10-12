import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { canonicalizeDocumentText, validateCreateRequest, validateEditMode,
  validateOpenedDocument, validatePassword, validateProfile,
  validatePlaintextExportRequest, validatePlaintextExportResult,
  validateBackupResult, validateCompactionResult, validatePublicationResult,
  validateSaveResult,
  validateWorkingCopy, validateClientSettings } from "./contracts.mjs";
import { WorkJournalStore } from "./work-journal.mjs";
import { PublicationService } from "./publication.mjs";
import { HeadWitnessStore, compareHeadWitness } from "./head-witness.mjs";
import { createMergeDraft, hasConflictMarkers } from "./divergence-merge.mjs";
import { LifecycleBarrier } from "./lifecycle-barrier.mjs";

const DOCUMENT_ID = /^[0-9a-f]{32}$/;
const REVISION_ID = /^[0-9a-f]{64}$/;
const HEARTBEAT_MS = 120_000;
const DEFAULT_LEASE_DURATION_MS = 600_000;
const LEASE_PUBLISH_EFFECTS = 0b111;
const LEASE_ADOPT_EFFECT = 0b1000;
export const COMPACTION_CONFIRMATION = "I understand that compaction irreversibly removes older history from this container and cannot delete copies held by backups, sync tools, caches, or storage providers.";
export const DISCARD_UNREADABLE_JOURNAL_CONFIRMATION = "Permanently discard the unreadable recovery journal for this authenticated document.";
const UNAVAILABLE_CODES = new Set([
  "ENOENT", "ENOTDIR", "EACCES", "EIO", "ENODEV", "ESTALE", "ETIMEDOUT",
  "ECONNRESET",
]);

function targetUnavailable(error) {
  return UNAVAILABLE_CODES.has(error?.code);
}

function newerWorkingCopy(working, submittedVersion, content) {
  if (!working) return false;
  if (submittedVersion && working.journalScope) {
    return working.journalScope !== submittedVersion.journalScope
      || working.revision !== submittedVersion.revision;
  }
  return working.content !== content;
}

function proposedPasswordAccepted(native, password) {
  const assess = native.assessPasswordPolicy;
  return typeof assess === "function" && assess.call(native, password) === "accepted";
}

const MERGE_STATUS_CODES = Object.freeze({
  20: "MERGE_UNRELATED_TARGET",
  21: "MERGE_TARGET_ROLLBACK",
  22: "MERGE_BASE_UNAVAILABLE",
  23: "MERGE_ACCESS_REVOKED",
  24: "MERGE_PERMISSION_DENIED",
});

function mergeDecisionError(error) {
  const status = error?.status;
  const code = MERGE_STATUS_CODES[status]
    ?? (status === 10 ? "MERGE_TARGET_REAUTHENTICATION" : null);
  if (!code) return error;
  const decision = new Error(code);
  decision.code = code;
  decision.cause = error;
  return decision;
}

export class DocumentService {
  constructor({ native, fs, profilePath, settingsPath, journalDirectory,
    publicationCapabilities, witnessDirectory,
    platform = process.platform,
    nativeLineEnding = process.platform === "win32" ? "\r\n" : "\n",
    checkpointIdleMs = 10_000, checkpointContinuousMs = 30_000,
    inactivityMs = 120_000, now = () => Date.now(),
    utcNow = now, monotonicNow = now, randomSessionId = () => randomBytes(16),
    setTimer = setTimeout, clearTimer = clearTimeout,
    onLockStart = () => {}, onLocked = () => {}, onJournalWarning = () => {},
    onRegularSave = () => {} }) {
    this.native = native;
    this.container = native.createContainerContext?.() ?? null;
    this.containerTarget = null;
    this.containerBytes = null;
    this.nextCandidateOperation = 1;
    this.pendingNativeCandidate = null;
    this.fs = fs;
    this.profilePath = profilePath;
    this.settingsPath = settingsPath ?? path.join(path.dirname(profilePath), "settings.json");
    this.nativeLineEnding = nativeLineEnding;
    this.journals = new WorkJournalStore({ fs,
      directory: journalDirectory ?? path.join(path.dirname(profilePath), "work-journals") });
    this.publications = new PublicationService({ fs, journals: this.journals,
      capabilities: publicationCapabilities, now, platform });
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
    this.onLockStart = onLockStart;
    this.onLocked = onLocked;
    this.onJournalWarning = onJournalWarning;
    this.onRegularSave = onRegularSave;
    this.checkpointTimer = null;
    this.inactivityTimer = null;
    this.heartbeatTimer = null;
    this.heartbeatOperation = null;
    this.leaseAcquisitionOperations = new Set();
    this.lockOperation = null;
    this.regularSaveTimer = null;
    this.clientSettings = validateClientSettings();
    this.leaseGeneration = 0;
    this.flushChain = Promise.resolve();
    this.publicationChain = Promise.resolve();
    this.publicationOperations = 0;
    this.lifecycle = new LifecycleBarrier();
    this.active = null;
    this.createdTarget = null;
    this.createdBytes = null;
    this.suspendedLeases = new Map();
    this.leaseObservations = new Map();
    this.leaseTakeoverConfirmations = new WeakMap();
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
    const previous = await this.loadProfile();
    const identityChanged = previous !== null
      && (previous.name !== validated.name || previous.email !== validated.email);
    if (identityChanged && this.active?.opened
        && !this.active.opened.invitationRequired
        && !this.active.opened.recoverySlot
        && this.active.opened.slotIdentityName !== undefined
        && (this.active.editMode || this.active.dirty)) {
      throw new Error(
        "Leave edit mode and resolve unsaved changes before changing profile identity");
    }
    await this.fs.mkdir(path.dirname(this.profilePath), { recursive: true });
    await this.#atomicWrite(this.profilePath,
      Buffer.from(`${JSON.stringify(validated)}\n`, "utf8"), true);
    if (identityChanged) await this.reconcileProfile();
    return validated;
  }

  async reconcileProfile() {
    const active = this.active;
    if (!active || active.opened.invitationRequired) return null;
    const profile = await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    const hasIdentity = !active.opened.recoverySlot
      && active.opened.slotIdentityName !== undefined
      && active.opened.slotIdentityEmail !== undefined;
    const mismatch = hasIdentity
      && (active.opened.slotIdentityName !== profile.name
        || active.opened.slotIdentityEmail !== profile.email)
      ? Object.freeze({ slotName: active.opened.slotIdentityName,
        slotEmail: active.opened.slotIdentityEmail, profileName: profile.name,
        profileEmail: profile.email, editingBlocked: true }) : null;
    if (mismatch && (active.editMode || active.dirty)) {
      throw new Error(
        "Leave edit mode and resolve unsaved changes before refreshing profile identity");
    }
    active.profileMismatch = mismatch;
    const refreshed = { ...active.opened,
      readOnly: mismatch ? true : !active.editMode,
      canEdit: mismatch || active.headMismatch || active.migrationRequired
        ? false : active.slotCanEdit,
      ...(mismatch ? { profileMismatch: mismatch } : { profileMismatch: undefined }) };
    active.opened = active.editMode && !mismatch
      ? validateEditMode(refreshed) : validateOpenedDocument(refreshed);
    return active.opened;
  }

  async loadClientSettings() {
    try {
      this.clientSettings = validateClientSettings(JSON.parse(
        await this.fs.readFile(this.settingsPath, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.clientSettings = validateClientSettings();
    }
    this.#scheduleRegularSave();
    return this.clientSettings;
  }

  async saveClientSettings(settings) {
    this.clientSettings = validateClientSettings(settings);
    await this.fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
    await this.#atomicWrite(this.settingsPath,
      Buffer.from(`${JSON.stringify(this.clientSettings)}\n`, "utf8"), true);
    this.#scheduleRegularSave();
    return this.clientSettings;
  }

  async unresolvedJournalSummary() {
    return this.journals.discoverUnresolved();
  }

  /* Reports whether a publication, migration, compaction, or lease write is queued. */
  hasActivePublication() {
    return this.lifecycle.hasMaintenance;
  }

  /* Runs session abandonment only after earlier maintenance and before later work. */
  runLifecycleBarrier(operation) {
    return this.lifecycle.runExclusive(operation);
  }

  async createDocument(target, request) {
    const profile = await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    const input = validateCreateRequest(request);
    if (!proposedPasswordAccepted(this.native, input.ownerPassword)) {
      const error = new TypeError("Owner password does not meet policy");
      error.code = "OWNER_PASSWORD_WEAK"; throw error;
    }
    if (input.recoveryPassword
        && !proposedPasswordAccepted(this.native, input.recoveryPassword)) {
      const error = new TypeError("Recovery password does not meet policy");
      error.code = "RECOVERY_PASSWORD_WEAK"; throw error;
    }
    const createInput = { ...profile, ...input, timestampMs: Date.now() };
    // Lease publication remains on the legacy writer until its handle cutover.
    const candidate = this.native.createDocument(createInput);
    if (!Buffer.isBuffer(candidate) || candidate.length === 0) {
      this.closeContainer();
      throw new Error("Native bridge did not produce a container");
    }
    if (this.container) {
      this.container.open(candidate);
      this.container.unlock(input.ownerPassword);
      this.containerTarget = target;
      this.containerBytes = Buffer.from(candidate);
    }
    try {
      await this.#queuePublication(async () => {
        await this.#atomicWrite(target, candidate, false);
        const published = await this.fs.readFile(target);
        if (!published.equals(candidate)) throw new Error("Published container verification failed");
        this.createdTarget = target;
        this.createdBytes = Buffer.from(published);
        const opened = this.#validateNativeOpened(
          this.native.openDocument(published, input.ownerPassword));
        await this.witnesses.observe(target, this.#observation(opened));
        opened.journalKey.fill(0);
      });
    } catch (error) {
      this.closeContainer();
      throw error;
    }
    return { created: true };
  }

  async revalidateTargetForReplacement() {
    const active = this.active;
    if (!active) throw new Error("Open the replacement candidate first");
    const current = await this.fs.readFile(active.target);
    if (!current.equals(active.baseContainer)) {
      const error = new Error("The selected target changed before replacement completed");
      error.code = "DOCUMENT_REPLACEMENT_TARGET_CHANGED";
      throw error;
    }
    const verified = this.#validateNativeOpened(
      this.native.openDocument(current, active.password));
    try {
      if (verified.documentId !== active.documentId
          || verified.baseRevision !== active.baseRevision) {
        const error = new Error("The selected target changed before replacement completed");
        error.code = "DOCUMENT_REPLACEMENT_TARGET_CHANGED";
        throw error;
      }
    } finally {
      verified.journalKey.fill(0);
    }
    return Object.freeze({ unchanged: true });
  }

  async abandonCreatedDocument() {
    if (!this.createdTarget) return Object.freeze({ removed: false });
    const target = this.createdTarget;
    const expected = this.active?.target === target
      ? Buffer.from(this.active.baseContainer) : Buffer.from(this.createdBytes);
    if (this.active) {
      try {
        await this.lock("abandon-created-replacement");
      } catch {
        this.#cancelCheckpoint();
        this.#cancelRegularSave();
        if (this.inactivityTimer !== null) this.clearTimer(this.inactivityTimer);
        this.inactivityTimer = null;
        this.leaseGeneration += 1;
        try { await this.#stopHeartbeat(); } catch {}
        this.active?.journalKey?.fill(0);
        if (this.active) { this.active.password = ""; this.active.working = null; }
        this.active = null;
      }
    }
    const current = await this.fs.readFile(target);
    if (!current.equals(expected)) {
      throw new Error("Created target changed; refusing unsafe cleanup");
    }
    await this.fs.unlink(target);
    this.createdTarget = null;
    this.createdBytes.fill(0);
    this.createdBytes = null;
    return Object.freeze({ removed: true });
  }

  acceptCreatedDocument() {
    this.createdTarget = null;
    this.createdBytes?.fill(0);
    this.createdBytes = null;
  }

  async openDocument(target, password) {
    const validatedPassword = validatePassword(password);
    const bootstrap = await this.journals.findPublication(target);
    let bytes;
    let nativeOpened;
    if (bootstrap) {
      try {
        return await this.#openPendingDocument(target, validatedPassword, bootstrap);
      } catch (bootstrapError) {
        try {
          bytes = await this.fs.readFile(target);
          nativeOpened = this.#validateNativeOpened(
            this.native.openDocument(bytes, validatedPassword));
        } catch {
          throw bootstrapError;
        }
      }
    }
    bytes ??= await this.fs.readFile(target);
    let activePassword = validatedPassword;
    let recoveredPublication = false;
    try {
      nativeOpened ??= this.#validateNativeOpened(
        this.native.openDocument(bytes, activePassword));
    } catch (targetError) {
      const recoveryBase = await this.publications.readRecoveryBase(target);
      if (!recoveryBase) throw targetError;
      let baseOpened;
      try {
        baseOpened = this.#validateNativeOpened(
          this.native.openDocument(recoveryBase, validatedPassword));
        const journal = await this.journals.read(
          baseOpened.documentId, baseOpened.journalKey);
        if (!journal?.publication) throw targetError;
        const resumed = await this.publications.resume(
          baseOpened.documentId, baseOpened.journalKey, journal);
        if (!resumed.completed) {
          throw new Error("Interrupted publication could not be reconciled safely");
        }
        activePassword = journal.publication.reopenPassword ?? validatedPassword;
        nativeOpened = this.#validateNativeOpened(this.native.openDocument(
          await this.fs.readFile(target), activePassword));
        recoveredPublication = true;
        this.onJournalWarning("PUBLICATION_RECOVERED");
      } finally {
        baseOpened?.journalKey.fill(0);
      }
    }
    let recovery = null;
    let pendingPublication = false;
    let publicationCompleted = false;
    let pendingRecord = null;
    let publicationState = "target-published";
    let unresolvedJournal = false;
    let unreadableJournal = false;
    try {
      let journal = await this.journals.read(
        nativeOpened.documentId, nativeOpened.journalKey);
      unresolvedJournal = journal !== null;
      if (journal?.publication) {
        pendingPublication = true;
        pendingRecord = journal;
        publicationState = journal.state === "conflict" ? "conflict" : "pending-publication";
        const reopenPassword = journal.publication.reopenPassword ?? activePassword;
        this.#validateCandidate(journal, reopenPassword, nativeOpened.documentId);
        const resumed = journal.state === "conflict" ? { completed: false, reason: "changed" }
          : await this.publications.resume(
            nativeOpened.documentId, nativeOpened.journalKey, journal);
        if (resumed.completed) {
          publicationCompleted = true;
          pendingPublication = false;
          pendingRecord = null;
          publicationState = "target-published";
          unresolvedJournal = false;
          const published = await this.fs.readFile(target);
          bytes = published;
          nativeOpened.journalKey.fill(0);
          nativeOpened = this.#validateNativeOpened(
            this.native.openDocument(published, reopenPassword));
          journal = await this.journals.read(
            nativeOpened.documentId, nativeOpened.journalKey);
          unresolvedJournal = journal !== null;
          activePassword = reopenPassword;
          this.onJournalWarning("PUBLICATION_RECOVERED");
        } else if (resumed.reason === "changed") {
          pendingRecord = await this.publications.markDiverged(
            nativeOpened.documentId, nativeOpened.journalKey, journal);
          publicationState = "conflict";
          this.onJournalWarning("PUBLICATION_CONFLICT");
        } else if (resumed.reason === "ambiguous") {
          this.onJournalWarning("PUBLICATION_CONFIRMATION_REQUIRED");
        }
      }
      if (!nativeOpened.opened.invitationRequired && journal?.state === "unsaved"
          && journal.baseRevision === nativeOpened.baseRevision) {
        recovery = journal;
      }
      if (!nativeOpened.opened.invitationRequired && !nativeOpened.manuallySealed
          && !recovery) {
        recovery = { text: nativeOpened.opened.content,
          baseRevision: nativeOpened.baseRevision,
          cursor: { start: 0, end: 0 }, target, state: "unsaved",
          updateTime: Number.isSafeInteger(nativeOpened.revisionTimestampMs)
            ? nativeOpened.revisionTimestampMs : this.now(),
          authorName: nativeOpened.profileName ?? "",
          deviceName: nativeOpened.deviceName ?? "" };
        unresolvedJournal = true;
      }
      if (!journal && !recoveredPublication) {
        await this.publications.cleanupOrphanedRecoveryBase(target);
      }
    } catch (error) {
      if (publicationCompleted) throw error;
      unresolvedJournal = true;
      unreadableJournal = true;
      this.onJournalWarning("RECOVERY_READ_FAILED");
    }
    const targetOpened = nativeOpened.opened;
    const { headMismatch } = await this.#observeHead(target, nativeOpened);
    const profile = await this.loadProfile();
    const slotIdentityPresent = targetOpened.slotIdentityName !== undefined
      && targetOpened.slotIdentityEmail !== undefined;
    const profileMismatch = !targetOpened.recoverySlot && profile && slotIdentityPresent
      && (targetOpened.slotIdentityName !== profile.name
        || targetOpened.slotIdentityEmail !== profile.email)
      ? Object.freeze({ slotName: targetOpened.slotIdentityName,
        slotEmail: targetOpened.slotIdentityEmail, profileName: profile.name,
        profileEmail: profile.email, editingBlocked: true }) : null;
    const slotCanEdit = nativeOpened.opened.invitationRequired
      ? false : nativeOpened.opened.canEdit;
    const migrationRequired = nativeOpened.containerFormatVersion < 3;
    const opened = nativeOpened.opened.invitationRequired
      ? nativeOpened.opened
      : validateOpenedDocument({ ...nativeOpened.opened,
        lease: nativeOpened.lease.active ? nativeOpened.lease : undefined,
        canEdit: headMismatch || profileMismatch || migrationRequired || unreadableJournal
          ? false : slotCanEdit,
        ...(migrationRequired ? { migrationRequired: true,
          migrationCanEdit: slotCanEdit } : {}),
        ...(pendingRecord?.publication.purpose !== "invitation-claim"
          ? (pendingRecord ? { content: pendingRecord.text } : {}) : {}),
        publicationState,
        ...(headMismatch ? { headMismatch } : {}),
        ...(profileMismatch ? { profileMismatch } : {}),
        ...(unreadableJournal ? { unreadableJournal: true } : {}),
        ...(recovery ? { recovery: { content: recovery.text,
          cursor: recovery.cursor, state: "unsaved",
          updateTime: recovery.updateTime,
          ...(recovery.authorName ? { authorName: recovery.authorName } : {}),
          ...(recovery.deviceName ? { deviceName: recovery.deviceName } : {}) } } : {}) });
    this.#openActiveContainer(target, bytes, activePassword, nativeOpened);
    this.active = { target, password: activePassword, opened, editMode: false,
      documentId: nativeOpened.documentId, baseRevision: nativeOpened.baseRevision,
      revisionGraph: nativeOpened.revisionGraph, observation: this.#observation(nativeOpened),
      slotCanEdit, headMismatch, profileMismatch,
      migrationRequired,
      journalKey: Buffer.from(nativeOpened.journalKey), recovery,
      baseContainer: Buffer.from(bytes), targetContent: targetOpened.content,
      working: null, dirty: false, manuallySealed: nativeOpened.manuallySealed,
      pendingPublication, pendingRecord, unresolvedJournal,
      unreadableJournal,
      continuousDue: null, journalWarning: null };
    nativeOpened.journalKey.fill(0);
    this.notifyActivity();
    return opened;
  }

  #openActiveContainer(target, bytes, password, nativeOpened) {
    // The stateful ABI deliberately excludes unreleased v1/v2 migration inputs.
    if (!this.container || nativeOpened.containerFormatVersion < 3) return;
    if (this.active) throw new Error("Close the active document before opening another");
    const sameImage = this.containerTarget === target
      && this.containerBytes?.equals(bytes);
    if (this.containerTarget && !sameImage) this.closeContainer();
    let openedHere = false;
    try {
      if (sameImage && this.pendingNativeCandidate !== null) {
        this.container.finishSave(this.pendingNativeCandidate, "definite-failure");
        this.pendingNativeCandidate = null;
        const suspended = this.suspendedLeases.get(nativeOpened.documentId);
        if (suspended?.release) {
          suspended.release.journalKey?.fill(0);
          suspended.release = null;
        }
      }
      if (!sameImage) {
        this.container.open(bytes);
        this.containerTarget = target;
        this.containerBytes = Buffer.from(bytes);
        openedHere = true;
      }
      if (!sameImage || this.container.status().locked) this.container.unlock(password);
      if (!nativeOpened.opened.invitationRequired) {
        const snapshot = this.container.read();
        if (snapshot.documentId !== nativeOpened.documentId
            || snapshot.slotId !== nativeOpened.opened.slotId
            || snapshot.content !== nativeOpened.opened.content) {
          throw new Error("Native container handle disagrees with authenticated document");
        }
      }
    } catch (error) {
      try {
        if (openedHere) this.closeContainer();
        else if (sameImage && !this.container.status().locked) this.container.lock();
      } catch {
        this.#discardContainerContext();
        this.onJournalWarning("NATIVE_LOCK_FAILED");
      }
      throw error;
    }
  }

  closeContainer() {
    if (!this.containerTarget) return;
    for (const suspended of this.suspendedLeases.values()) {
      if (suspended.release?.operationId === this.pendingNativeCandidate) {
        suspended.release.journalKey.fill(0);
        suspended.release = null;
      }
    }
    this.container.close();
    this.containerTarget = null;
    this.containerBytes = null;
    this.pendingNativeCandidate = null;
  }

  #prepareSaveCandidate(active, current, kind, profile, content) {
    if (!this.container || typeof this.container.prepareSave !== "function"
        || active.migrationRequired) {
      const input = { ...profile, content, timestampMs: Date.now() };
      const bytes = kind === "regular"
        ? this.native.regularSaveDocument(current, active.password, input)
        : kind === "discard"
          ? this.native.discardProvisional(current, active.password)
          : this.native.saveDocument(current, active.password, input);
      return { bytes, operationId: null };
    }
    if (this.pendingNativeCandidate) {
      throw new Error("Resolve the pending candidate before preparing another save");
    }
    if (this.#nativeLeaseAvailable(active)) {
      this.#syncNativeLeaseSource(active, current);
      const mode = this.container.leaseMode();
      if (!mode.editing || mode.leaseStatus !== "held") {
        throw new Error("Editing lease is no longer held by this session");
      }
    } else if (this.containerTarget !== active.target
        || !this.containerBytes?.equals(current)) {
      if (this.containerTarget) this.closeContainer();
      this.container.open(current);
      this.container.unlock(active.password);
      this.containerTarget = active.target;
      this.containerBytes = Buffer.from(current);
    }
    if (!this.#nativeLeaseAvailable(active)) this.container.confirmEditLease();
    const result = this.container.prepareSave(kind, active.password, {
      ...profile, content, timestampMs: Date.now(),
      operationId: this.nextCandidateOperation++,
    });
    if (!Buffer.isBuffer(result?.bytes) || result.bytes.length === 0
        || !Number.isSafeInteger(result.operationId)) {
      throw new Error("Native bridge did not return an exact candidate");
    }
    this.pendingNativeCandidate = result.operationId;
    return result;
  }

  async #prepareSlotCandidate(active, current, kind, actorPassword, input,
    legacyCandidate) {
    if (!this.container?.prepareSlotChange) {
      return { bytes: legacyCandidate(), operationId: null };
    }
    if (this.pendingNativeCandidate !== null) {
      throw new Error("Resolve the pending candidate before changing a password slot");
    }
    if (this.containerTarget !== active.target || !this.containerBytes?.equals(current)) {
      if (this.containerTarget) this.closeContainer();
      this.container.open(current);
      this.container.unlock(actorPassword);
      this.containerTarget = active.target;
      this.containerBytes = Buffer.from(current);
    }
    const profile = await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    const prepared = this.container.prepareSlotChange(kind, actorPassword, {
      ...input, clientName: profile.name, clientEmail: profile.email,
      deviceName: profile.deviceName, timestampMs: this.now(),
      operationId: this.nextCandidateOperation++,
    });
    if (!Buffer.isBuffer(prepared?.bytes) || prepared.bytes.length === 0
        || !Number.isSafeInteger(prepared.operationId)) {
      throw new Error("Native bridge did not return an exact slot candidate");
    }
    this.pendingNativeCandidate = prepared.operationId;
    return prepared;
  }

  async #publishSlotCandidate(active, current, kind, actorPassword, input,
    legacyCandidate, purpose, reopenPassword) {
    const prepared = await this.#prepareSlotCandidate(
      active, current, kind, actorPassword, input, legacyCandidate);
    try {
      await this.publications.publish({ documentId: active.documentId,
        journalKey: active.journalKey, target: active.target, base: current,
        candidate: prepared.bytes, text: active.opened.content ?? "",
        cursor: { start: 0, end: 0 }, baseRevision: active.baseRevision,
        purpose, ...(reopenPassword ? { reopenPassword } : {}) });
      this.#finishSaveCandidate(prepared.operationId, "verified");
    } catch (error) {
      if (this.pendingNativeCandidate !== null) {
        this.#finishSaveCandidate(prepared.operationId,
          error.publicationPrepared ? "ambiguous" : "definite-failure");
      }
      if (!error.publicationPrepared || purpose === "invitation-claim") {
        throw error;
      }
      try {
        const record = await this.journals.read(active.documentId, active.journalKey);
        if (record?.publication?.purpose !== purpose) throw error;
        const resumed = await this.publications.resume(
          active.documentId, active.journalKey, record);
        if (!resumed.completed) throw error;
        this.#resolveSaveCandidate(true);
      } catch {
        throw error;
      }
    }
    return this.fs.readFile(active.target);
  }

  #finishSaveCandidate(operationId, outcome) {
    if (operationId === null) return;
    this.container.finishSave(operationId, outcome);
    if (outcome !== "ambiguous") {
      this.pendingNativeCandidate = null;
      if (outcome === "verified") this.containerBytes = this.container.bytes();
    }
  }

  #resolveSaveCandidate(published) {
    if (this.pendingNativeCandidate === null) return;
    this.container.resolveSave(this.pendingNativeCandidate, published);
    this.pendingNativeCandidate = null;
    if (published) this.containerBytes = this.container.bytes();
  }

  #withRevisionHistory(read) {
    const active = this.active;
    if (!active || this.lockOperation) throw new Error("Unlock a document to view activity");
    if (!this.native.createContainerContext || active.migrationRequired) {
      throw new Error("Revision activity is unavailable for this container");
    }
    const context = this.native.createContainerContext();
    let opened = false;
    try {
      context.open(active.baseContainer);
      opened = true;
      context.unlock(active.password);
      return read(context);
    } finally {
      if (opened) context.close();
    }
  }

  revisionActivityPage(offset, count) {
    try {
      return this.#withRevisionHistory((context) => context.historyPage(offset, count));
    } catch (error) {
      if (error?.code === "SCPEFE_NATIVE"
          && error.message === "SCPEFE operation failed with status 8") {
        return { items: [], nextOffset: offset, hasMore: false, unavailable: true };
      }
      throw error;
    }
  }

  revisionActivityComparison(beforeId, afterId) {
    return this.#withRevisionHistory((context) =>
      context.historyCompare(beforeId, afterId));
  }

  #discardContainerContext() {
    try { this.container = this.native.createContainerContext?.() ?? null; }
    catch { this.container = null; }
    this.containerTarget = null;
    this.containerBytes = null;
    this.pendingNativeCandidate = null;
  }

  async enterEditMode({ takeoverToken } = {}) {
    const active = this.active;
    if (!active) throw new Error("Open a document first");
    if (this.lockOperation) {
      const error = new Error("The document is being locked");
      error.code = "SESSION_LOCKED";
      throw error;
    }
    if (active.pendingPublication) {
      throw new Error("Resolve the interrupted publication before editing");
    }
    if (active.recovery) {
      throw new Error("Restore or discard recovered work before editing");
    }
    if (active.unreadableJournal) {
      throw new Error("Discard or preserve the unreadable journal before editing");
    }
    if (active.headMismatch) {
      throw new Error("Accept or resolve the head mismatch before editing");
    }
    if (active.profileMismatch) {
      throw new Error("Reconcile the password-slot identity before editing");
    }
    if (active.migrationRequired) {
      throw new Error("This older container must be migrated before editing or saving");
    }
    if (!active.opened.canEdit) {
      throw new Error("The active password slot does not permit editing");
    }
    await this.#acquireActiveLease(active,
      { takeoverToken, issueTakeoverToken: true });
    active.editMode = true;
    active.working = { content: active.opened.content,
      cursor: { start: 0, end: 0 } };
    active.dirty = !active.manuallySealed;
    this.#scheduleRegularSave();
    return validateEditMode({ ...active.opened, readOnly: false });
  }

  async changePassword(request) {
    const active = this.active;
    if (!active || active.opened.invitationRequired) {
      throw new Error("Open and claim a document first");
    }
    if (active.profileMismatch) {
      throw new Error("Reconcile the password-slot identity before administering passwords");
    }
    if (active.dirty || active.recovery || active.pendingPublication
        || active.unresolvedJournal) {
      throw new Error("Resolve or discard document changes before changing a password");
    }
    const currentPassword = validatePassword(request?.currentPassword);
    const newPassword = validatePassword(request?.newPassword);
    if (currentPassword !== active.password) {
      throw new Error("Current password does not match the active password slot");
    }
    if (!proposedPasswordAccepted(this.native, newPassword)) {
      const error = new TypeError("New password does not meet policy");
      error.code = "WEAK_PASSWORD"; throw error;
    }
    if (newPassword === currentPassword) {
      throw new TypeError("new password must differ from the current password");
    }
    let reopened;
    let published;
    await this.#queuePublication(async () => {
      const current = await this.fs.readFile(active.target);
      const inspected = this.#validateNativeOpened(
        this.native.openDocument(current, currentPassword));
      try {
        if (inspected.documentId !== active.documentId
            || inspected.baseRevision !== active.baseRevision) {
          throw new Error("The target changed before the password change completed");
        }
      } finally {
        inspected.journalKey.fill(0);
      }
      published = await this.#publishSlotCandidate(active, current, "password",
        currentPassword, { newPassword },
        () => this.native.changePassword(current, currentPassword, newPassword),
        "password-change", newPassword);
      reopened = this.#validateNativeOpened(
        this.native.openDocument(published, newPassword));
      if (reopened.documentId !== active.documentId
          || reopened.opened.slotId !== active.opened.slotId) {
        throw new Error("Published password change was not verified");
      }
    });
    active.password = newPassword;
    active.journalKey.fill(0);
    const passwordChangeBlocked = active.headMismatch || active.profileMismatch
      || active.migrationRequired;
    const reopenedView = validateOpenedDocument({ ...reopened.opened,
      canEdit: passwordChangeBlocked ? false : reopened.opened.canEdit,
      publicationState: "target-published",
      ...(active.profileMismatch ? { profileMismatch: active.profileMismatch } : {}),
      ...(active.headMismatch ? { headMismatch: active.headMismatch } : {}),
      ...(active.migrationRequired ? { migrationRequired: true,
        migrationCanEdit: active.slotCanEdit } : {}),
      ...(reopened.lease.active ? { lease: reopened.lease } : {}) });
    active.opened = active.editMode
      ? validateEditMode({ ...reopenedView, readOnly: false }) : reopenedView;
    active.baseContainer = Buffer.from(published);
    active.baseRevision = reopened.baseRevision;
    active.revisionGraph = reopened.revisionGraph;
    active.slotCanEdit = reopened.opened.canEdit;
    active.journalKey = Buffer.from(reopened.journalKey);
    active.observation = this.#observation(reopened);
    reopened.journalKey.fill(0);
    await this.witnesses.observe(active.target, active.observation);
    return active.opened;
  }

  async createInvitation(request) {
    const active = this.active;
    if (active?.profileMismatch) {
      throw new Error("Reconcile the password-slot identity before administering passwords");
    }
    if (!active?.editMode || !active.opened.canAddPasswords) {
      throw new Error("Enter edit mode with an add-password slot first");
    }
    const temporaryPassword = request.temporaryPassword
      ? validatePassword(request.temporaryPassword)
      : randomBytes(24).toString("base64url");
    if (!proposedPasswordAccepted(this.native, temporaryPassword)) {
      const error = new TypeError("Temporary password does not meet policy");
      error.code = "WEAK_PASSWORD"; throw error;
    }
    const input = { temporaryPassword,
      temporaryLabel: String(request.temporaryLabel ?? "").trim(),
      canEdit: request.canEdit === true,
      canAddPasswords: request.canAddPasswords === true,
      canRemovePasswords: request.canRemovePasswords === true };
    if (!input.temporaryLabel) throw new TypeError("temporary label is required");
    let reopened;
    let published;
    await this.#queuePublication(async () => {
      const current = await this.fs.readFile(active.target);
      const inspected = this.#validateNativeOpened(
        this.native.openDocument(current, active.password));
      if (!inspected.lease.active || !active.leaseSessionId
          || !Buffer.from(inspected.lease.sessionId, "hex").equals(active.leaseSessionId)
          || inspected.lease.heartbeatCounter !== active.leaseCounter) {
        throw new Error("Editing lease is no longer held by this session");
      }
      published = await this.#publishSlotCandidate(active, current, "invitation",
        active.password, { newPassword: temporaryPassword,
          name: input.temporaryLabel, canEdit: input.canEdit,
          canAddPasswords: input.canAddPasswords,
          canRemovePasswords: input.canRemovePasswords },
        () => this.native.addInvitation(current, active.password, input),
        "slot-administration");
      reopened = this.#validateNativeOpened(this.native.openDocument(
        published, active.password));
    });
    active.journalKey.fill(0);
    active.opened = validateEditMode({ ...reopened.opened,
      readOnly: false, canEdit: active.opened.canEdit });
    active.baseContainer = Buffer.from(published);
    active.baseRevision = reopened.baseRevision;
    active.revisionGraph = reopened.revisionGraph;
    active.observation = this.#observation(reopened);
    active.slotCanEdit = reopened.opened.canEdit;
    active.journalKey = Buffer.from(reopened.journalKey);
    reopened.journalKey.fill(0);
    await this.witnesses.observe(active.target, active.observation);
    return Object.freeze({ created: true, temporaryPassword, opened: active.opened });
  }

  async claimInvitation(newPassword) {
    const active = this.active;
    if (!active?.opened.invitationRequired) {
      throw new Error("The active password slot is not awaiting a claim");
    }
    const profile = await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    const replacement = validatePassword(newPassword);
    if (!proposedPasswordAccepted(this.native, replacement)) {
      const error = new TypeError("Replacement password does not meet policy");
      error.code = "WEAK_PASSWORD"; throw error;
    }
    let reopened;
    let published;
    await this.#queuePublication(async () => {
      const current = await this.fs.readFile(active.target);
      published = await this.#publishSlotCandidate(active, current, "claim",
        active.password, { newPassword: replacement,
          name: profile.name, email: profile.email },
        () => this.native.claimInvitation(current, active.password,
          { newPassword: replacement, name: profile.name, email: profile.email }),
        "invitation-claim", replacement);
      reopened = this.#validateNativeOpened(
        this.native.openDocument(published, replacement));
      if (reopened.documentId !== active.documentId
          || reopened.opened.invitationRequired) {
        throw new Error("Published invitation claim was not verified");
      }
    });
    const migrationRequired = reopened.containerFormatVersion < 3;
    active.password = replacement;
    active.journalKey.fill(0);
    active.opened = validateOpenedDocument({ ...reopened.opened,
      canEdit: migrationRequired ? false : reopened.opened.canEdit,
      publicationState: "target-published",
      ...(migrationRequired ? { migrationRequired: true,
        migrationCanEdit: reopened.opened.canEdit } : {}),
      ...(reopened.lease.active ? { lease: reopened.lease } : {}) });
    active.documentId = reopened.documentId;
    active.baseRevision = reopened.baseRevision;
    active.revisionGraph = reopened.revisionGraph;
    active.observation = this.#observation(reopened);
    active.slotCanEdit = reopened.opened.canEdit;
    active.headMismatch = null;
    active.profileMismatch = null;
    active.migrationRequired = migrationRequired;
    active.baseContainer = Buffer.from(published);
    active.targetContent = reopened.opened.content;
    active.journalKey = Buffer.from(reopened.journalKey);
    active.recovery = null;
    active.pendingPublication = false;
    active.pendingRecord = null;
    active.unresolvedJournal = false;
    active.unreadableJournal = false;
    active.manuallySealed = reopened.manuallySealed;
    active.editMode = false;
    active.working = null;
    active.dirty = false;
    reopened.journalKey.fill(0);
    await this.witnesses.observe(active.target, active.observation);
    return active.opened;
  }

  async reconcileIdentity() {
    const active = this.active;
    if (!active?.profileMismatch) throw new Error("No profile mismatch is available");
    if (!active.manuallySealed || active.recovery || active.pendingPublication
        || active.unresolvedJournal) {
      throw new Error("Resolve or discard document changes before reconciling identity");
    }
    const profile = await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    await this.#acquireActiveLease(active);
    active.editMode = true;
    active.working = { content: active.opened.content, cursor: { start: 0, end: 0 } };
    let published;
    let reopened;
    try {
      await this.#queuePublication(async () => {
        const current = await this.fs.readFile(active.target);
        const inspected = this.#validateNativeOpened(
          this.native.openDocument(current, active.password));
        if (!inspected.lease.active || !active.leaseSessionId
            || !Buffer.from(inspected.lease.sessionId, "hex").equals(active.leaseSessionId)
            || inspected.lease.heartbeatCounter !== active.leaseCounter) {
          throw new Error("Editing lease is no longer held by this session");
        }
        published = await this.#publishSlotCandidate(active, current, "identity",
          active.password, { name: profile.name, email: profile.email },
          () => {
            const identityCandidate = this.native.reconcileIdentity(
              current, active.password, profile);
            return this.native.saveDocument(identityCandidate, active.password, {
              ...profile, content: active.opened.content, timestampMs: this.now(),
            });
          }, "identity-reconciliation");
        reopened = this.#validateNativeOpened(
          this.native.openDocument(published, active.password));
        if (reopened.opened.slotIdentityName !== profile.name
            || reopened.opened.slotIdentityEmail !== profile.email) {
          throw new Error("Published identity reconciliation was not verified");
        }
      });
      active.journalKey.fill(0);
      active.opened = reopened.opened;
      active.documentId = reopened.documentId;
      active.baseRevision = reopened.baseRevision;
      active.revisionGraph = reopened.revisionGraph;
      active.observation = this.#observation(reopened);
      active.baseContainer = Buffer.from(published);
      active.journalKey = Buffer.from(reopened.journalKey);
      reopened.journalKey.fill(0);
      active.profileMismatch = null;
      active.slotCanEdit = active.opened.canEdit;
      active.dirty = false;
      active.manuallySealed = true;
      await this.witnesses.observe(active.target, active.observation);
      await this.exitEditMode();
      return active.opened;
    } catch (error) {
      active.editMode = false;
      await this.#stopHeartbeat();
      throw error;
    }
  }

  async updateSlotPermissions(request) {
    const active = this.active;
    if (active?.profileMismatch) {
      throw new Error("Reconcile the password-slot identity before administering passwords");
    }
    if (!active?.editMode || !active.opened.canAddPasswords
        || !active.opened.canRemovePasswords) {
      throw new Error("Enter edit mode with a full administrative slot first");
    }
    const slotId = String(request.slotId ?? "");
    if (!DOCUMENT_ID.test(slotId)) throw new TypeError("slot ID is invalid");
    const permissions = { slotId, canEdit: request.canEdit === true,
      canAddPasswords: request.canAddPasswords === true,
      canRemovePasswords: request.canRemovePasswords === true };
    if ((permissions.canAddPasswords || permissions.canRemovePasswords)
        && !permissions.canEdit) {
      throw new TypeError("password administration implies edit permission");
    }
    return this.#publishSlotAdministration("permissions", permissions,
      (current) => this.native.updateSlotPermissions(
        current, active.password, permissions));
  }

  async removeSlot(slotId) {
    const active = this.active;
    if (active?.profileMismatch) {
      throw new Error("Reconcile the password-slot identity before administering passwords");
    }
    if (!active?.editMode || !active.opened.canRemovePasswords) {
      throw new Error("Enter edit mode with a remove-password slot first");
    }
    const targetSlot = String(slotId ?? "");
    if (!DOCUMENT_ID.test(targetSlot)) throw new TypeError("slot ID is invalid");
    const opened = await this.#publishSlotAdministration("remove",
      { slotId: targetSlot },
      (current) => this.native.removeSlot(current, active.password, targetSlot));
    return Object.freeze({ removed: true,
      warningCode: "SLOT_REMOVED", opened });
  }

  async #publishSlotAdministration(kind, input, createLegacyCandidate) {
    const active = this.active;
    let reopened;
    let published;
    await this.#queuePublication(async () => {
      const current = await this.fs.readFile(active.target);
      const inspected = this.#validateNativeOpened(
        this.native.openDocument(current, active.password));
      if (!inspected.lease.active || !active.leaseSessionId
          || !Buffer.from(inspected.lease.sessionId, "hex").equals(active.leaseSessionId)
          || inspected.lease.heartbeatCounter !== active.leaseCounter) {
        throw new Error("Editing lease is no longer held by this session");
      }
      published = await this.#publishSlotCandidate(active, current, kind,
        active.password, input, () => createLegacyCandidate(current),
        "slot-administration");
      reopened = this.#validateNativeOpened(this.native.openDocument(
        published, active.password));
    });
    active.journalKey.fill(0);
    active.opened = validateEditMode({ ...reopened.opened,
      readOnly: false, canEdit: active.opened.canEdit });
    active.baseContainer = Buffer.from(published);
    active.baseRevision = reopened.baseRevision;
    active.revisionGraph = reopened.revisionGraph;
    active.observation = this.#observation(reopened);
    active.slotCanEdit = reopened.opened.canEdit;
    active.journalKey = Buffer.from(reopened.journalKey);
    reopened.journalKey.fill(0);
    await this.witnesses.observe(active.target, active.observation);
    return active.opened;
  }

  publicationCapabilities() {
    return this.publications.replacementCapabilities();
  }

  async restoreRecoveredWork({ takeoverToken } = {}) {
    const active = this.active;
    if (!active?.recovery) throw new Error("No recovered work is available");
    if (active.pendingPublication) {
      throw new Error("Resolve the interrupted publication before editing");
    }
    if (active.headMismatch) {
      throw new Error("Accept or resolve the head mismatch before editing");
    }
    if (!active.opened.canEdit) {
      throw new Error("The active password slot does not permit editing");
    }
    await this.#acquireActiveLease(active,
      { takeoverToken, issueTakeoverToken: true });
    active.editMode = true;
    active.working = { content: active.recovery.text,
      cursor: { ...active.recovery.cursor } };
    active.dirty = true;
    this.notifyActivity();
    return Object.freeze({ content: active.working.content, readOnly: false,
      canEdit: true, recoveredUnsaved: true,
      cursor: Object.freeze({ ...active.working.cursor }) });
  }

  async discardRecoveredWork() {
    if (!this.active?.recovery) throw new Error("No recovered work is available");
    if (!this.active.manuallySealed) {
      return this.#discardProvisional(this.active);
    }
    await this.journals.clear(this.active.documentId);
    this.active.recovery = null;
    this.active.unresolvedJournal = false;
    this.active.opened = validateOpenedDocument({ ...this.active.opened,
      recovery: undefined, readOnly: true,
      canEdit: this.active.headMismatch || this.active.profileMismatch
        || this.active.migrationRequired || this.active.unreadableJournal
        ? false : this.active.slotCanEdit });
    return this.active.opened;
  }

  async discardWorkingCopy() {
    const active = this.active;
    if (!active?.editMode || !active.dirty) {
      throw new Error("No unsaved working copy is available");
    }
    if (!active.manuallySealed) return this.#discardProvisional(active);
    this.#cancelCheckpoint();
    await this.journals.clear(active.documentId);
    active.dirty = false;
    active.unresolvedJournal = false;
    active.working = { content: active.opened.content, cursor: { start: 0, end: 0 } };
    await this.exitEditMode();
    return active.opened;
  }

  async acceptHeadMismatch() {
    const active = this.active;
    if (!active?.headMismatch) throw new Error("No head mismatch is available");
    await this.witnesses.accept(active.target, active.observation);
    active.headMismatch = null;
    active.opened = validateOpenedDocument({ ...active.opened,
      headMismatch: undefined, readOnly: true,
      canEdit: active.profileMismatch || active.migrationRequired
        || active.unreadableJournal ? false : active.slotCanEdit });
    return active.opened;
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
      this.#resolveSaveCandidate(true);
      await this.#adoptPublishedCandidate(active);
      return validatePublicationResult({ publicationState: "target-published",
        content: active.opened.content });
    }
    if (resumed.reason === "changed") {
      this.#resolveSaveCandidate(false);
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

  async beginDivergenceResolution({ takeoverToken, targetPassword } = {}) {
    const active = this.active;
    if (!active?.pendingPublication || active.pendingRecord?.state !== "conflict") {
      throw new Error("No divergent pending publication is available");
    }
    if (!active.slotCanEdit) {
      throw new Error("The active password slot does not permit editing");
    }
    const localPassword = active.password;
    const currentPassword = targetPassword === undefined
      ? localPassword : validatePassword(targetPassword);
    this.#validateCandidate(active.pendingRecord, localPassword, active.documentId);
    // Authenticate lineage and current target rights before changing its lease.
    // A denied merge leaves the encrypted conflict journal exactly as it was.
    const preflightTarget = await this.fs.readFile(active.target);
    const preflightLocal = Buffer.from(
      active.pendingRecord.publication.candidate, "base64");
    const profile = await this.loadProfile();
    if (this.active !== active || this.lockOperation) {
      const error = new Error("The document was locked during divergence preflight");
      error.code = "SESSION_LOCKED";
      throw error;
    }
    if (!profile) throw new Error("Configure name, email, and device name first");
    try {
      this.native.mergeDocument(preflightTarget, preflightLocal, localPassword,
        { ...profile, content: active.pendingRecord.text,
          timestampMs: this.now(), targetPassword: currentPassword });
    } catch (error) {
      throw mergeDecisionError(error);
    }
    active.password = currentPassword;
    active.mergeLocalPassword = localPassword;
    try {
      await this.#acquireActiveLease(active,
        { takeoverToken, issueTakeoverToken: true });
    } catch (error) {
      active.password = localPassword;
      active.mergeLocalPassword = null;
      throw error;
    }
    active.editMode = true;
    try {
      const currentBytes = await this.fs.readFile(active.target);
      const current = this.#validateNativeOpened(
        this.native.openDocument(currentBytes, active.password));
      const localBytes = Buffer.from(active.pendingRecord.publication.candidate, "base64");
      const local = this.#validateNativeOpened(
        this.native.openDocument(localBytes, localPassword));
      const ancestorBytes = Buffer.from(
        active.pendingRecord.publication.mergeAncestor
          ?? active.pendingRecord.publication.base, "base64");
      const ancestor = this.#validateNativeOpened(
        this.native.openDocument(ancestorBytes, localPassword));
      try {
        if (!current.journalKey.equals(local.journalKey)
            || !current.journalKey.equals(ancestor.journalKey)) {
          throw new Error("Divergent replicas do not share authenticated key material");
        }
        const calculated = createMergeDraft({ ancestor, local, current });
        const savedMerge = active.pendingRecord.merge;
        if (savedMerge && (savedMerge.ancestorRevision !== calculated.ancestorRevision
            || savedMerge.localRevision !== calculated.localRevision
            || savedMerge.currentRevision !== calculated.currentRevision)) {
          const error = new Error(
            "The target changed while the merge resolution was stored");
          error.code = "MERGE_TARGET_CHANGED";
          throw error;
        }
        const draft = savedMerge ? Object.freeze({ ...calculated,
          content: active.pendingRecord.text,
          hasConflicts: hasConflictMarkers(active.pendingRecord.text) }) : calculated;
        const cursor = savedMerge ? { ...active.pendingRecord.cursor }
          : { start: 0, end: 0 };
        const localContent = active.pendingRecord.merge?.localContent
          ?? active.pendingRecord.text;
        active.pendingRecord = { ...active.pendingRecord,
          text: draft.content, cursor,
          updateTime: this.now(),
          merge: { localContent, ancestorRevision: draft.ancestorRevision,
            localRevision: draft.localRevision,
            currentRevision: draft.currentRevision } };
        await this.journals.write(
          active.documentId, active.journalKey, active.pendingRecord);
        active.baseContainer = Buffer.from(currentBytes);
        active.baseRevision = current.baseRevision;
        active.revisionGraph = current.revisionGraph;
        active.observation = this.#observation(current);
        active.targetContent = current.opened.content;
        active.working = { content: draft.content, cursor };
        active.dirty = true;
        active.opened = validateOpenedDocument({ ...active.opened,
          content: draft.content, canEdit: true, publicationState: "conflict" });
        this.notifyActivity();
        return draft;
      } finally {
        current.journalKey.fill(0);
        local.journalKey.fill(0);
        ancestor.journalKey.fill(0);
      }
    } catch (error) {
      active.editMode = false;
      await this.#stopHeartbeat();
      active.password = localPassword;
      active.mergeLocalPassword = null;
      throw error;
    }
  }

  async saveDivergenceResolution(content, submittedVersion = null) {
    const active = this.active;
    if (!active?.editMode || !active.pendingPublication
        || active.pendingRecord?.state !== "conflict"
        || !active.pendingRecord.merge) {
      throw new Error("Begin divergence resolution before saving");
    }
    const canonical = canonicalizeDocumentText(content);
    if (hasConflictMarkers(canonical)) {
      throw new Error("Resolve every conflict marker before saving the merge");
    }
    const profile = await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    this.#cancelCheckpoint();
    await this.flushChain.catch(() => {});
    try {
      await this.#queuePublication(async () => {
        const currentBytes = await this.fs.readFile(active.target);
        const current = this.#validateNativeOpened(
          this.native.openDocument(currentBytes, active.password));
        try {
          const merge = active.pendingRecord.merge;
          if (current.documentId !== active.documentId
              || current.baseRevision !== merge.currentRevision
              || !current.lease.active || !active.leaseSessionId
              || !Buffer.from(current.lease.sessionId, "hex")
                .equals(active.leaseSessionId)
              || current.lease.heartbeatCounter !== active.leaseCounter) {
            const error = new Error(
              "The target changed while the merge was being resolved");
            error.code = "MERGE_TARGET_CHANGED";
            throw error;
          }
          const localBytes = Buffer.from(
            active.pendingRecord.publication.candidate, "base64");
          let candidate;
          try {
            candidate = this.native.mergeDocument(
              currentBytes, localBytes, active.mergeLocalPassword ?? active.password,
              { ...profile, content: canonical, timestampMs: Date.now(),
                targetPassword: active.password });
          } catch (error) {
            throw mergeDecisionError(error);
          }
          if (!Buffer.isBuffer(candidate) || candidate.length === 0) {
            throw new Error("Native bridge did not produce a merge container");
          }
          await this.publications.publish({ documentId: active.documentId,
            journalKey: active.journalKey, target: active.target,
            base: currentBytes, candidate, text: canonical,
            cursor: { start: 0, end: 0 }, baseRevision: current.baseRevision });
        } finally {
          current.journalKey.fill(0);
        }
      });
    } catch (error) {
      if (MERGE_STATUS_CODES[error?.cause?.status]
          || error?.code === "MERGE_TARGET_REAUTHENTICATION") {
        await this.#stopHeartbeat();
        active.editMode = false;
        if (active.mergeLocalPassword) {
          active.password = active.mergeLocalPassword;
          active.mergeLocalPassword = null;
        }
      }
      if (error.publicationPrepared) {
        active.pendingSubmittedVersion = submittedVersion;
        active.pendingRecord = await this.journals.read(
          active.documentId, active.journalKey);
        active.opened = validateOpenedDocument({ ...active.opened,
          content: canonical, publicationState: "pending-publication" });
        const newerWork = newerWorkingCopy(active.working, submittedVersion, canonical);
        if (!newerWork) {
          active.working = { content: canonical, cursor: { start: 0, end: 0 } };
        }
        active.dirty = newerWork;
      }
      throw error;
    }
    active.pendingSubmittedVersion = submittedVersion;
    await this.#adoptPublishedCandidate(active);
    this.notifyActivity();
    return validateSaveResult({ saved: true, content: canonical,
      publicationState: "target-published", ...(submittedVersion ?? {}) });
  }

  async discardPendingPublication() {
    const active = this.active;
    if (!active?.pendingPublication || !active.pendingRecord) {
      throw new Error("No pending publication is available");
    }
    if (active.editMode) {
      this.#cancelRegularSave();
      await this.#stopHeartbeat();
      active.editMode = false;
    }
    if (this.pendingNativeCandidate !== null) {
      const checked = await this.reconnectPendingPublication();
      if (checked.publicationState === "target-published") return active.opened;
      if (checked.publicationState !== "conflict") {
        const target = await this.fs.readFile(active.target);
        if (!target.equals(Buffer.from(active.pendingRecord.publication.base, "base64"))) {
          throw new Error("Resolve the pending candidate before discarding it");
        }
        this.#resolveSaveCandidate(false);
      }
    }
    await this.publications.discard(
      active.documentId, active.journalKey, active.pendingRecord);
    active.pendingPublication = false;
    active.pendingRecord = null;
    active.mergeLocalPassword = null;
    active.unresolvedJournal = false;
    active.working = null;
    active.dirty = false;
    active.opened = validateOpenedDocument({ content: active.targetContent,
      readOnly: true, canEdit: active.headMismatch ? false : active.slotCanEdit,
      publicationState: "target-published",
      ...(active.opened.lease ? { lease: active.opened.lease } : {}),
      ...(active.headMismatch ? { headMismatch: active.headMismatch } : {}) });
    return active.opened;
  }

  async discardUnsavedForClose() {
    if (!this.active) throw new Error("Open a document first");
    if (this.active.pendingPublication) {
      const resumed = await this.reconnectPendingPublication();
      if (resumed.publicationState !== "target-published") {
        const error = new Error(
          "The pending save cannot be discarded safely until its target is available and unchanged");
        error.code = "CLOSE_DISCARD_BLOCKED";
        throw error;
      }
    }
    const active = this.active;
    if (active.recovery) return this.discardRecoveredWork();
    if (!active.manuallySealed) return this.#discardProvisional(active);
    if (active.editMode && active.dirty) return this.discardWorkingCopy();
    return active.opened;
  }

  async discardUnreadableJournalForSwitch(confirmation) {
    const active = this.active;
    if (!active || !active.unreadableJournal || !active.unresolvedJournal
        || active.pendingPublication || active.pendingRecord || active.recovery) {
      throw new Error("No unreadable journal is available for this authenticated document");
    }
    if (confirmation !== DISCARD_UNREADABLE_JOURNAL_CONFIRMATION) {
      throw new Error("Unreadable journal discard was not explicitly confirmed");
    }
    await this.journals.clear(active.documentId);
    active.unreadableJournal = false;
    active.unresolvedJournal = false;
    active.opened = validateOpenedDocument({ ...active.opened,
      unreadableJournal: undefined,
      canEdit: active.headMismatch || active.profileMismatch || active.migrationRequired
        ? false : active.slotCanEdit });
    return Object.freeze({ discarded: true, documentId: active.documentId });
  }

  updateWorkingCopy(value) {
    if (!this.active?.editMode) throw new Error("Enter edit mode before editing");
    if (this.active.compactionInProgress) {
      throw new Error("Compaction is in progress; editing is unavailable");
    }
    if (this.active.pendingPublication && !this.active.pendingRecord?.merge) {
      throw new Error("Resolve the interrupted publication before editing");
    }
    const working = validateWorkingCopy(value);
    this.active.working = working;
    this.active.dirty = !this.active.manuallySealed
      || working.content !== this.active.opened.content
      || Boolean(this.active.sealedWorkingVersion
        && newerWorkingCopy(working, this.active.sealedWorkingVersion,
          this.active.opened.content));
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

  lock(reason = "app-lock") {
    const active = this.active;
    if (!active) return Promise.resolve(
      { locked: true, journalSaved: true, warningCode: null });
    if (this.lockOperation) return this.lockOperation;
    let resolveLock; let rejectLock;
    const tracked = new Promise((resolve, reject) => {
      resolveLock = resolve; rejectLock = reject;
    });
    this.lockOperation = tracked;
    tracked.then(() => {
      if (this.lockOperation === tracked) this.lockOperation = null;
    }, () => {
      if (this.lockOperation === tracked) this.lockOperation = null;
    });
    let startError = null;
    try { this.onLockStart(Object.freeze({ reason })); }
    catch (error) { startError = error; }
    this.#finishLock(active, reason).then((result) => {
      if (startError) rejectLock(startError); else resolveLock(result);
    }, rejectLock);
    return tracked;
  }

  async #finishLock(active, reason) {
    if (this.containerTarget) {
      try {
        if (this.pendingNativeCandidate !== null) this.closeContainer();
        else this.container.lock();
      }
      catch (error) {
        try { this.closeContainer(); }
        catch { this.#discardContainerContext(); }
        this.onJournalWarning("NATIVE_LOCK_FAILED");
      }
    }
    this.#cancelCheckpoint();
    this.#cancelRegularSave();
    if (this.inactivityTimer !== null) this.clearTimer(this.inactivityTimer);
    this.inactivityTimer = null;
    while (this.leaseAcquisitionOperations.size > 0) {
      await Promise.allSettled(this.leaseAcquisitionOperations);
    }
    await this.#stopHeartbeat();
    let journalSaved = true;
    let warningCode = null;
    try {
      await this.#flushActive(active);
    } catch (error) {
      journalSaved = false;
      warningCode = "LOCK_CHECKPOINT_FAILED";
    } finally {
      if (active.leaseSessionId) {
        let release = null;
        if (!active.pendingPublication) {
          try { release = this.#prepareSuspendedLeaseRelease(active); }
          catch { /* Lock must clear secrets even if release preparation fails. */ }
        }
        this.suspendedLeases.set(active.documentId, {
          target: active.target,
          sessionId: Buffer.from(active.leaseSessionId),
          counter: active.leaseCounter,
          release,
        });
      }
      active.journalKey.fill(0);
      active.working = null;
      active.recovery = null;
      active.password = "";
      this.active = null;
    }
    const result = Object.freeze({ locked: true, journalSaved, warningCode, reason });
    this.onLocked(result);
    return result;
  }

  async exitEditMode() {
    const active = this.active;
    if (!active?.editMode) return { released: false };
    this.#cancelRegularSave();
    await this.#stopHeartbeat();
    await this.#flushActive(active);
    try { await this.#queuePublication(async () => {
      const current = await this.fs.readFile(active.target);
      if (this.#nativeLeaseAvailable(active)) {
        this.#syncNativeLeaseSource(active, current);
        const lease = this.container.authenticatedLease();
        if (this.container.leaseMode().leaseStatus !== "held"
            || !lease.active || !active.leaseSessionId
            || lease.sessionId !== active.leaseSessionId.toString("hex")
            || lease.heartbeatCounter !== active.leaseCounter) {
          const error = new Error("Editing lease changed before it could be released");
          error.code = "LEASE_CHANGED";
          throw error;
        }
        await this.#publishNativeLease(active, current, "release",
          active.leaseSessionId, lease, {
            name: lease.holderName, email: lease.holderEmail,
            deviceName: lease.deviceName,
          });
        return;
      }
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
    }); } catch (error) {
      await this.lock("lease-release-failed");
      throw error;
    }
    active.editMode = false;
    active.working = null;
    active.leaseSessionId = null;
    this.suspendedLeases.delete(active.documentId);
    return { released: true };
  }

  // Carries a locked session's lease evidence into an authenticated replacement session.
  transferSuspendedLeaseTo(next, target) {
    const opened = next?.active;
    if (this.active || !opened || opened.target !== target) return false;
    const suspended = this.suspendedLeases.get(opened.documentId);
    if (!suspended || suspended.target !== target) return false;
    next.suspendedLeases.set(opened.documentId, {
      target, sessionId: Buffer.from(suspended.sessionId), counter: suspended.counter,
      release: suspended.release ? {
        base: Buffer.from(suspended.release.base),
        candidate: Buffer.from(suspended.release.candidate) } : null,
    });
    this.suspendedLeases.delete(opened.documentId);
    return true;
  }

  #prepareSuspendedLeaseRelease(active) {
    const base = Buffer.from(active.baseContainer);
    const opened = this.#validateNativeOpened(
      this.native.openDocument(base, active.password));
    try {
      if (opened.documentId !== active.documentId || !opened.lease.active
          || opened.lease.sessionId !== active.leaseSessionId.toString("hex")
          || opened.lease.heartbeatCounter !== active.leaseCounter) return null;
      if (this.#nativeLeaseAvailable(active)
          && this.containerTarget === active.target
          && this.containerBytes?.equals(base)
          && this.pendingNativeCandidate === null) {
        const pendingWork = this.#leasePendingWork(active);
        const lease = opened.lease;
        const candidate = this.container.prepareLeaseChange("release", active.password, {
          operationId: this.nextCandidateOperation++,
          sessionId: active.leaseSessionId.toString("hex"),
          expectedActive: true, expectedSessionId: lease.sessionId,
          expectedHeartbeatCounter: lease.heartbeatCounter,
          expectedHolderUtcMs: lease.holderUtcMs,
          expectedDurationMs: lease.durationMs,
          nowUtcMs: this.utcNow(), unchangedMonotonicMs: 0,
          durationMs: lease.durationMs,
          holderName: lease.holderName, holderEmail: lease.holderEmail,
          deviceName: lease.deviceName, explicitTakeover: false,
        });
        if ((candidate.effects & LEASE_PUBLISH_EFFECTS) !== LEASE_PUBLISH_EFFECTS) {
          this.container.finishSave(candidate.operationId, "definite-failure");
          throw new Error("Native lease release omitted required effects");
        }
        this.pendingNativeCandidate = candidate.operationId;
        return { base, candidate: Buffer.from(candidate.bytes),
          operationId: candidate.operationId,
          journalKey: Buffer.from(active.journalKey),
          text: pendingWork?.text ?? active.opened.content ?? "",
          cursor: pendingWork?.cursor ?? { start: 0, end: 0 },
          baseRevision: active.baseRevision, preserveWork: pendingWork !== null };
      }
      const candidate = this.native.updateLease(base, active.password,
        { ...opened.lease, active: false });
      if (Buffer.from(candidate).equals(base)) {
        // A no-op bridge cannot supply bytes for a later safe release.
        this.native.updateLease(base, active.password, opened.lease);
        return null;
      }
      return { base, candidate: Buffer.from(candidate) };
    } finally {
      opened.journalKey.fill(0);
    }
  }

  hasSuspendedLease() { return this.suspendedLeases.size > 0; }

  async releaseSuspendedLease(target) {
    const entry = [...this.suspendedLeases].find(([, value]) => value.target === target);
    if (!entry) return { released: false };
    const [documentId, suspended] = entry;
    if (!suspended.release) {
      this.suspendedLeases.delete(documentId);
      return { released: false };
    }
    try {
      await this.#queuePublication(async () => {
        if (suspended.release.operationId !== undefined) {
          await this.publications.publish({ documentId,
            journalKey: suspended.release.journalKey, target,
            base: suspended.release.base,
            candidate: suspended.release.candidate,
            text: suspended.release.text, cursor: suspended.release.cursor,
            baseRevision: suspended.release.baseRevision,
            purpose: "lease-change",
            preserveWork: suspended.release.preserveWork });
        } else {
          await this.#atomicWrite(target, suspended.release.candidate, true,
            () => this.suspendedLeases.get(documentId) === suspended,
            suspended.release.base);
        }
      });
    } catch (error) {
      if (error?.code !== "TARGET_CHANGED") throw error;
      if (suspended.release.operationId !== undefined) {
        this.container.finishSave(suspended.release.operationId, "definite-failure");
        this.pendingNativeCandidate = null;
      }
      this.suspendedLeases.delete(documentId);
      return { released: false, changed: true };
    }
    if (suspended.release.operationId !== undefined) {
      const effects = this.container.finishSave(suspended.release.operationId, "verified");
      if ((effects & LEASE_ADOPT_EFFECT) === 0) {
        throw new Error("Native lease release was not adopted");
      }
      this.pendingNativeCandidate = null;
      this.containerBytes = this.container.bytes();
      suspended.release.journalKey.fill(0);
    }
    this.suspendedLeases.delete(documentId);
    return { released: true };
  }

  async releaseSuspendedLeases() {
    for (const target of new Set(
      [...this.suspendedLeases.values()].map((value) => value.target))) {
      await this.releaseSuspendedLease(target);
    }
  }

  async regularSaveDocument() {
    const active = this.active;
    if (!this.clientSettings.regularSaveEnabled || !active?.editMode
        || !active.dirty || !active.working || active.pendingPublication
        || active.headMismatch) {
      return Object.freeze({ published: false });
    }
    const profile = await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    const source = active.working;
    const canonical = canonicalizeDocumentText(source.content);
    const mergeAncestor = this.#regularSaveMergeAncestor(active);
    await this.#flushActive(active);
    let published;
    let reopened;
    let candidate;
    try {
      await this.#queuePublication(async () => {
        const current = await this.fs.readFile(active.target);
        const inspected = this.#validateNativeOpened(
          this.native.openDocument(current, active.password));
        try {
          if (inspected.documentId !== active.documentId
              || inspected.baseRevision !== active.baseRevision
              || !inspected.lease.active || !active.leaseSessionId
              || !Buffer.from(inspected.lease.sessionId, "hex")
                .equals(active.leaseSessionId)
              || inspected.lease.heartbeatCounter !== active.leaseCounter) {
            const error = new Error(
              "The target changed before the regular save could be published");
            error.code = "REGULAR_SAVE_DIVERGED";
            throw error;
          }
          const prepared = this.#prepareSaveCandidate(
            active, current, "regular", profile, canonical);
          candidate = prepared.bytes;
          if (!Buffer.isBuffer(candidate) || candidate.length === 0) {
            throw new Error("Native bridge did not produce a provisional container");
          }
          await this.publications.publish({ documentId: active.documentId,
            journalKey: active.journalKey, target: active.target,
            base: current, candidate, text: canonical,
            cursor: { ...active.working.cursor }, baseRevision: active.baseRevision,
            purpose: "regular-save", state: "unsaved",
            ...(mergeAncestor ? { mergeAncestor } : {}) });
          this.#finishSaveCandidate(prepared.operationId, "verified");
          published = await this.fs.readFile(active.target);
          reopened = this.#validateNativeOpened(
            this.native.openDocument(published, active.password));
          if (reopened.opened.content !== canonical || reopened.manuallySealed) {
            throw new Error("Regular save verification failed");
          }
        } finally {
          inspected.journalKey.fill(0);
        }
      });
    } catch (error) {
      if (this.pendingNativeCandidate !== null) {
        this.#finishSaveCandidate(this.pendingNativeCandidate,
          error.publicationPrepared ? "ambiguous" : "definite-failure");
      }
      if (error?.code === "REGULAR_SAVE_DIVERGED") {
        return this.#preserveRegularSaveConflict(
          active, profile, canonical, mergeAncestor);
      }
      if (error.publicationPrepared) {
        active.pendingRecord = await this.journals.read(
          active.documentId, active.journalKey);
        if (active.pendingRecord?.publication) {
          let target = null;
          try { target = await this.fs.readFile(active.target); } catch {}
          const expectedBase = Buffer.from(active.pendingRecord.publication.base, "base64");
          const expectedCandidate = Buffer.from(
            active.pendingRecord.publication.candidate, "base64");
          if (target && !target.equals(expectedBase) && !target.equals(expectedCandidate)) {
            active.pendingRecord = await this.publications.markDiverged(
              active.documentId, active.journalKey, active.pendingRecord);
          }
          active.pendingPublication = true;
          active.unresolvedJournal = true;
          active.opened = validateOpenedDocument({ ...active.opened,
            content: canonical,
            publicationState: active.pendingRecord.state === "conflict"
              ? "conflict" : "pending-publication" });
        }
      }
      if (targetUnavailable(error)) {
        this.onJournalWarning("REGULAR_SAVE_TARGET_UNAVAILABLE");
        return Object.freeze({ published: false });
      }
      throw error;
    }
    active.journalKey.fill(0);
    active.opened = reopened.opened;
    active.baseRevision = reopened.baseRevision;
    active.revisionGraph = reopened.revisionGraph;
    active.observation = this.#observation(reopened);
    active.baseContainer = Buffer.from(published);
    active.targetContent = canonical;
    active.journalKey = Buffer.from(reopened.journalKey);
    reopened.journalKey.fill(0);
    active.manuallySealed = false;
    active.dirty = true;
    active.unresolvedJournal = true;
    const latestWorking = active.working;
    await this.journals.write(active.documentId, active.journalKey, {
      text: latestWorking.content, baseRevision: active.baseRevision,
      cursor: { ...latestWorking.cursor }, target: active.target,
      state: "unsaved", updateTime: this.now(),
    });
    const result = Object.freeze({ published: true, provisional: true,
      content: canonical });
    this.onRegularSave(Object.freeze({ ...result,
      journalScope: source.journalScope ?? null, revision: source.revision ?? null }));
    return result;
  }

  async saveDocument(content, submittedVersion = null) {
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
          const prepared = this.#prepareSaveCandidate(
            active, active.baseContainer, "manual", profile, canonical);
          const candidate = prepared.bytes;
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
          this.#finishSaveCandidate(prepared.operationId, "ambiguous");
          active.pendingPublication = true;
          active.pendingSubmittedVersion = submittedVersion;
          active.unresolvedJournal = true;
          const newerWork = newerWorkingCopy(active.working, submittedVersion, canonical);
          if (!newerWork) {
            active.working = { content: canonical, cursor: { start: 0, end: 0 } };
          }
          active.dirty = newerWork;
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
        const prepared = this.#prepareSaveCandidate(
          active, current, "manual", profile, canonical);
        const candidate = prepared.bytes;
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
        this.#finishSaveCandidate(prepared.operationId, "verified");
        published = await this.fs.readFile(active.target);
        return this.#validateNativeOpened(
          this.native.openDocument(published, active.password));
      });
    } catch (error) {
      if (this.pendingNativeCandidate !== null) {
        this.#finishSaveCandidate(this.pendingNativeCandidate,
          error.publicationPrepared ? "ambiguous" : "definite-failure");
      }
      if (error.publicationPrepared) {
        active.pendingPublication = true;
        active.pendingSubmittedVersion = submittedVersion;
        active.unresolvedJournal = true;
        active.pendingRecord = await this.journals.read(
          active.documentId, active.journalKey);
        active.opened = validateOpenedDocument({ ...active.opened,
          content: canonical, publicationState: "pending-publication" });
        const newerWork = newerWorkingCopy(active.working, submittedVersion, canonical);
        if (!newerWork) {
          active.working = { content: canonical, cursor: { start: 0, end: 0 } };
        }
        active.dirty = newerWork;
      }
      throw error;
    }
    if (!reopened) {
      return validateSaveResult({ saved: true, content: canonical,
        publicationState: "pending-publication", ...(submittedVersion ?? {}) });
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
    const latestWorking = this.active.working;
    const newerWork = newerWorkingCopy(latestWorking, submittedVersion, canonical);
    this.active.working = newerWork
      ? latestWorking : { content: canonical, cursor: { start: 0, end: 0 } };
    this.active.dirty = Boolean(newerWork);
    this.active.manuallySealed = true;
    this.active.sealedWorkingVersion = submittedVersion;
    this.active.pendingPublication = false;
    this.active.pendingSubmittedVersion = null;
    this.active.pendingRecord = null;
    this.active.unresolvedJournal = false;
    this.active.recovery = null;
    this.active.continuousDue = null;
    if (newerWork) this.#scheduleCheckpoint();
    this.notifyActivity();
    return validateSaveResult({ saved: true, content: canonical,
      publicationState: "target-published", ...(submittedVersion ?? {}) });
  }

  async exportPlaintext(target, request) {
    if (!this.active) throw new Error("Open a document first");
    if (typeof target !== "string" || target.length === 0 || target.includes("\0")) {
      throw new TypeError("A valid plaintext export target is required");
    }
    const validated = validatePlaintextExportRequest(request);
    const content = validated.lineEndings === "native"
      ? validated.content.replace(/\n/g, this.nativeLineEnding)
      : validated.content;
    await this.publications.publishPlaintext({
      target, protectedTarget: this.active.target,
      content: Buffer.from(content, "utf8"),
    });
    return validatePlaintextExportResult({ exported: true });
  }

  suggestedBackupTarget() {
    if (!this.active) throw new Error("Open a document first");
    const parsed = path.parse(this.active.target);
    const stem = parsed.ext.toLowerCase() === ".scpefe" ? parsed.name : parsed.base;
    const timestamp = new Date(this.now()).toISOString()
      .replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    return path.join(parsed.dir, `${stem}.backup-${timestamp}.scpefe`);
  }

  async backupDocument(target) {
    if (!this.active) throw new Error("Open a document first");
    if (!this.active.manuallySealed) {
      throw new Error("Manually save the document before creating a backup");
    }
    if (this.active.dirty || this.active.recovery || this.active.pendingPublication
        || this.active.unresolvedJournal) {
      throw new Error("Save or discard changes before creating a backup");
    }
    const activeTarget = this.active.target;
    const candidate = await this.fs.readFile(activeTarget);
    await this.publications.publishReplica({ target, candidate });
    if (this.active.target !== activeTarget) {
      throw new Error("Backup changed the active target");
    }
    return validateBackupResult({ backedUp: true });
  }

  async compactDocument(confirmation, backupTarget) {
    const active = this.active;
    if (!active?.editMode || !active.opened.canAddPasswords
        || !active.opened.canRemovePasswords) {
      throw new Error("Enter edit mode with a full administrative slot first");
    }
    if (!this.container?.prepareCompaction || active.migrationRequired) {
      throw new Error("The stateful compaction interface is unavailable");
    }
    if (confirmation !== COMPACTION_CONFIRMATION) {
      throw new Error("Confirm irreversible local history removal before compacting");
    }
    if (!active.manuallySealed || active.dirty || active.recovery
        || active.pendingPublication || active.unresolvedJournal
        || active.headMismatch || active.opened.publicationState !== "target-published") {
      throw new Error(
        "Compaction requires a clean, manually sealed, conflict-free document");
    }
    const selectedBackupTarget = backupTarget === undefined
      ? this.suggestedBackupTarget() : backupTarget;
    if (typeof selectedBackupTarget !== "string" || !selectedBackupTarget
        || selectedBackupTarget.includes("\0")
        || path.resolve(selectedBackupTarget) === path.resolve(active.target)) {
      throw new TypeError("A distinct pre-compaction backup target is required");
    }
    if (active.compactionInProgress) {
      throw new Error("Compaction is already in progress");
    }
    active.compactionInProgress = true;
    try {
      return await this.#performCompaction(active, selectedBackupTarget);
    } finally {
      active.compactionInProgress = false;
    }
  }

  async #performCompaction(active, selectedBackupTarget) {
    let reopened;
    let published;
    const previousHead = active.baseRevision;
    try {
      await this.#queuePublication(async () => {
        const current = await this.fs.readFile(active.target);
        const inspected = this.#validateNativeOpened(
          this.native.openDocument(current, active.password));
        try {
          if (inspected.documentId !== active.documentId
              || inspected.baseRevision !== previousHead
              || !inspected.manuallySealed
              || !inspected.lease.active || !active.leaseSessionId
              || !Buffer.from(inspected.lease.sessionId, "hex")
                .equals(active.leaseSessionId)
              || inspected.lease.heartbeatCounter !== active.leaseCounter) {
            throw new Error("The target or editing lease changed before compaction");
          }
          if (this.pendingNativeCandidate !== null) {
            throw new Error("Resolve the pending candidate before compacting");
          }
          const journal = await this.journals.read(
            active.documentId, active.journalKey);
          if (journal) throw new Error(
            "Compaction requires a clean, manually sealed, conflict-free document");
          const profile = await this.loadProfile();
          if (!profile) throw new Error("Configure name, email, and device name first");
          let backup;
          try {
            backup = await this.publications.publishReplica({
              target: selectedBackupTarget, candidate: current,
              returnVerifiedBytes: true });
          } catch (cause) {
            const error = new Error(
              "The required pre-compaction backup could not be created and verified");
            error.code = "COMPACTION_BACKUP_FAILED";
            error.cause = cause;
            throw error;
          }
          const revalidated = await this.fs.readFile(active.target);
          if (!revalidated.equals(current)) {
            throw new Error("The target changed after the pre-compaction backup");
          }
          if (!Buffer.isBuffer(backup?.verifiedBytes)
              || !backup.verifiedBytes.equals(current)) {
            throw new Error("The pre-compaction backup read-back is unavailable");
          }
          this.#syncNativeLeaseSource(active, current);
          const mode = this.container.leaseMode();
          if (!mode.editing || mode.leaseStatus !== "held") {
            throw new Error("Editing lease is no longer held by this session");
          }
          const prepared = this.container.prepareCompaction(active.password, {
            operationId: this.nextCandidateOperation++,
            sessionId: active.leaseSessionId.toString("hex"),
            heartbeatCounter: active.leaseCounter,
            explicitDecision: true, cleanStateConfirmed: true,
            backupVerified: true, verifiedBackupBytes: backup.verifiedBytes,
            clientName: profile.name, clientEmail: profile.email,
            deviceName: profile.deviceName, timestampMs: this.now(),
          });
          if (!Buffer.isBuffer(prepared?.bytes) || prepared.bytes.length === 0
              || !Number.isSafeInteger(prepared.operationId)) {
            throw new Error("Native bridge did not return an exact candidate");
          }
          this.pendingNativeCandidate = prepared.operationId;
          const candidate = prepared.bytes;
          if (!Buffer.isBuffer(candidate) || candidate.length === 0) {
            throw new Error("Native bridge did not produce a compacted container");
          }
          const candidateOpened = this.#validateNativeOpened(
            this.native.openDocument(candidate, active.password));
          try {
            this.#verifyCompaction(active, inspected, candidateOpened, previousHead);
          } finally {
            candidateOpened.journalKey.fill(0);
          }
          await this.publications.publish({ documentId: active.documentId,
            journalKey: active.journalKey, target: active.target,
            base: current, candidate, text: active.opened.content,
            cursor: { start: 0, end: 0 }, baseRevision: previousHead,
            purpose: "compaction" });
          this.#finishSaveCandidate(this.pendingNativeCandidate, "verified");
          published = await this.fs.readFile(active.target);
          reopened = this.#validateNativeOpened(
            this.native.openDocument(published, active.password));
          this.#verifyCompaction(active, inspected, reopened, previousHead);
        } finally {
          inspected.journalKey.fill(0);
        }
      });
    } catch (error) {
      if (this.pendingNativeCandidate !== null) {
        this.#finishSaveCandidate(this.pendingNativeCandidate,
          error.publicationPrepared ? "ambiguous" : "definite-failure");
      }
      if (error.publicationPrepared) {
        active.pendingPublication = true;
        active.unresolvedJournal = true;
        active.pendingRecord = await this.journals.read(
          active.documentId, active.journalKey);
        active.opened = validateEditMode({ ...active.opened,
          readOnly: false, publicationState: "pending-publication" });
      }
      throw error;
    }
    active.journalKey.fill(0);
    active.opened = validateEditMode({ ...reopened.opened, readOnly: false });
    active.baseRevision = reopened.baseRevision;
    active.revisionGraph = reopened.revisionGraph;
    active.observation = this.#observation(reopened);
    active.baseContainer = Buffer.from(published);
    active.journalKey = Buffer.from(reopened.journalKey);
    reopened.journalKey.fill(0);
    active.manuallySealed = true;
    active.dirty = false;
    await this.witnesses.observe(active.target, active.observation);
    return validateCompactionResult({ compacted: true, backupCreated: true,
      previousHead, head: active.baseRevision, opened: active.opened });
  }

  async migrateDocument(backupTarget, { takeoverToken } = {}) {
    const active = this.active;
    if (!active?.migrationRequired) throw new Error("No older container is open");
    if (!active.slotCanEdit || active.headMismatch || active.profileMismatch
        || active.recovery || active.pendingPublication || active.unresolvedJournal
        || !active.manuallySealed) {
      throw new Error("Migration requires a clean, editable, conflict-free document");
    }
    const profile = await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    const selectedBackupTarget = backupTarget === undefined
      ? this.suggestedBackupTarget() : backupTarget;
    if (typeof selectedBackupTarget !== "string" || !selectedBackupTarget
        || selectedBackupTarget.includes("\0")
        || path.resolve(selectedBackupTarget) === path.resolve(active.target)) {
      throw new TypeError("A distinct pre-migration backup target is required");
    }
    let acquisition;
    let published;
    let reopened;
    try {
      await this.#queuePublication(async () => {
        const current = await this.fs.readFile(active.target);
        const before = this.#validateNativeOpened(
          this.native.openDocument(current, active.password));
        try {
          if (takeoverToken !== undefined) {
            acquisition = this.#leaseAcquisition(active, before.lease,
              { takeoverToken, issueTakeoverToken: true,
                observedDocumentId: before.documentId });
          }
          if (before.containerFormatVersion !== 2
              || before.documentId !== active.documentId
              || before.baseRevision !== active.baseRevision) {
            throw new Error("The target changed before migration");
          }
          acquisition ??= this.#leaseAcquisition(active, before.lease,
            { issueTakeoverToken: true, observedDocumentId: before.documentId });
          try {
            await this.publications.publishReplica({
              target: selectedBackupTarget, candidate: current });
          } catch (cause) {
            const error = new Error(
              "The required pre-migration backup could not be created and verified");
            error.code = "MIGRATION_BACKUP_FAILED";
            error.cause = cause;
            if (takeoverToken !== undefined) {
              error.takeoverToken = this.#issueLeaseTakeoverToken(
                active, before.lease, before.documentId);
            }
            throw error;
          }
          if (!(await this.fs.readFile(active.target)).equals(current)) {
            throw new Error("The target changed after the pre-migration backup");
          }
          const nextLease = { active: true,
            sessionId: acquisition.sessionId.toString("hex"),
            heartbeatCounter: acquisition.heartbeatCounter, holderUtcMs: this.utcNow(),
            durationMs: before.lease.durationMs, holderName: profile.name,
            holderEmail: profile.email, deviceName: profile.deviceName };
          const candidate = this.native.migrateDocument(current, active.password, {
            ...profile, ...nextLease, timestampMs: this.now(),
          });
          const checked = this.#validateNativeOpened(
            this.native.openDocument(candidate, active.password));
          try {
            if (checked.containerFormatVersion !== 3
                || checked.documentId !== before.documentId
                || checked.opened.content !== before.opened.content
                || checked.historyEventType !== "format-migration"
                || checked.revisionGraph.find((node) => node.revisionId === checked.baseRevision)
                  ?.parentRevisionIds[0] !== before.baseRevision
                || !checked.journalKey.equals(before.journalKey)
                || checked.lease.sessionId !== nextLease.sessionId) {
              throw new Error("Migrated container verification failed");
            }
          } finally { checked.journalKey.fill(0); }
          await this.publications.publish({ documentId: active.documentId,
            journalKey: active.journalKey, target: active.target,
            base: current, candidate, text: active.opened.content,
            cursor: { start: 0, end: 0 }, baseRevision: active.baseRevision,
            purpose: "format-migration" });
          published = await this.fs.readFile(active.target);
          reopened = this.#validateNativeOpened(
            this.native.openDocument(published, active.password));
        } finally { before.journalKey.fill(0); }
      });
    } catch (error) {
      if (error.publicationPrepared) {
        active.pendingPublication = true;
        active.unresolvedJournal = true;
        active.pendingRecord = await this.journals.read(active.documentId, active.journalKey);
      }
      throw error;
    }
    active.journalKey.fill(0);
    active.opened = validateEditMode({ ...reopened.opened, readOnly: false });
    active.baseRevision = reopened.baseRevision;
    active.revisionGraph = reopened.revisionGraph;
    active.observation = this.#observation(reopened);
    active.baseContainer = Buffer.from(published);
    active.journalKey = Buffer.from(reopened.journalKey);
    reopened.journalKey.fill(0);
    active.migrationRequired = false;
    active.editMode = true;
    active.working = { content: active.opened.content, cursor: { start: 0, end: 0 } };
    active.dirty = false;
    active.leaseSessionId = Buffer.from(acquisition.sessionId);
    active.leaseCounter = acquisition.heartbeatCounter;
    this.leaseGeneration += 1;
    this.#scheduleHeartbeat(this.leaseGeneration);
    await this.witnesses.observe(active.target, active.observation);
    return Object.freeze({ migrated: true, backupCreated: true,
      compatibilityCode: "MIGRATION_COMPATIBILITY",
      opened: active.opened });
  }

  #verifyCompaction(active, before, after, previousHead) {
    const baseline = after.revisionGraph.find(
      (node) => node.revisionId === after.baseRevision);
    const oldIds = new Set(before.revisionGraph.map((node) => node.revisionId));
    const historyValid = after.revisionGraph.length === before.revisionGraph.length + 1
      && oldIds.size === before.revisionGraph.length
      && !oldIds.has(after.baseRevision)
      && [...oldIds].every((id) => after.revisionGraph.some(
        (node) => node.revisionId === id));
    if (after.documentId !== before.documentId
        || !after.journalKey.equals(before.journalKey)
        || after.opened.content !== before.opened.content
        || after.historyEventType !== "compaction"
        || !after.manuallySealed
        || !historyValid
        || !baseline || baseline.parentRevisionIds.length !== 1
        || baseline.parentRevisionIds[0] !== previousHead
        || after.lease.sessionId !== before.lease.sessionId
        || after.lease.heartbeatCounter !== before.lease.heartbeatCounter
        || after.opened.slotId !== before.opened.slotId
        || after.opened.recoverySlot !== before.opened.recoverySlot
        || after.opened.slotIdentityName !== before.opened.slotIdentityName
        || after.opened.slotIdentityEmail !== before.opened.slotIdentityEmail
        || after.opened.canAddPasswords !== active.opened.canAddPasswords
        || after.opened.canRemovePasswords !== active.opened.canRemovePasswords
        || JSON.stringify(after.opened.managedSlots ?? [])
          !== JSON.stringify(before.opened.managedSlots ?? [])) {
      throw new Error("Compacted document verification failed");
    }
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
    if (value.manuallySealed !== undefined
        && typeof value.manuallySealed !== "boolean") {
      throw new TypeError("native bridge returned invalid revision state");
    }
    const containerFormatVersion = value.containerFormatVersion ?? 3;
    const historyEventType = value.historyEventType ?? "";
    const historyEventDetail = value.historyEventDetail ?? "";
    if (![2, 3].includes(containerFormatVersion)
        || typeof historyEventType !== "string"
        || typeof historyEventDetail !== "string") {
      throw new TypeError("native bridge returned invalid format metadata");
    }
    return { opened, documentId: value.documentId,
      baseRevision: value.baseRevision, revisionGraph, journalKey: value.journalKey,
      lease: Object.freeze({ ...rawLease }), manuallySealed: value.manuallySealed ?? true,
      revisionTimestampMs: value.revisionTimestampMs,
      profileName: value.profileName, deviceName: value.deviceName,
      containerFormatVersion, historyEventType, historyEventDetail };
  }

  async #acquireLease({ takeoverToken, issueTakeoverToken = false } = {}) {
    const active = this.active;
    const profile = await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    await this.#queuePublication(async () => {
      const bytes = await this.fs.readFile(active.target);
      const latest = this.#validateNativeOpened(
        this.native.openDocument(bytes, active.password));
      if (this.#nativeLeaseAvailable(active)) {
        const suspended = this.suspendedLeases.get(active.documentId);
        if (suspended?.target === active.target && latest.lease.active
            && latest.lease.sessionId === suspended.sessionId.toString("hex")
            && latest.lease.heartbeatCounter !== suspended.counter) {
          const error = new Error("Editing lease changed while this session was locked");
          error.code = "LEASE_CHANGED";
          error.lease = latest.lease;
          throw error;
        }
        this.#syncNativeLeaseSource(active, bytes, { allowReplacement: true });
        const lease = this.container.authenticatedLease();
        if (takeoverToken !== undefined) {
          const valid = takeoverToken !== null
            && (typeof takeoverToken === "object" || typeof takeoverToken === "function")
            ? this.leaseTakeoverConfirmations.get(takeoverToken) : undefined;
          if (valid) this.leaseTakeoverConfirmations.delete(takeoverToken);
          if (!valid || valid.documentId !== active.documentId
              || valid.active !== active || valid.target !== active.target
              || valid.baseRevision !== active.baseRevision
              || valid.lease !== this.#leaseFingerprint(lease)) {
            const error = new Error("Editing lease changed after takeover confirmation");
            error.code = "LEASE_CHANGED";
            error.lease = lease;
            throw error;
          }
        }
        const key = `${active.documentId}:${lease.sessionId}:${lease.heartbeatCounter}`;
        const observedSince = this.leaseObservations.get(key) ?? this.monotonicNow();
        this.leaseObservations.set(key, observedSince);
        const elapsed = Math.max(0, this.monotonicNow() - observedSince);
        const advice = this.container.leaseAdvice({
          suspendedSessionId: suspended?.target === active.target
            ? suspended.sessionId.toString("hex") : "0".repeat(32),
          suspendedCounter: suspended?.target === active.target ? suspended.counter : 0,
          nowUtcMs: this.utcNow(), unchangedMonotonicMs: elapsed,
        });
        if (advice === "changed") {
          const error = new Error("Editing lease changed while this session was locked");
          error.code = "LEASE_CHANGED";
          error.lease = lease;
          throw error;
        }
        if (advice === "blocked" || (advice === "confirm-takeover"
            && takeoverToken === undefined)) {
          const error = new Error(`Editing lease held by ${lease.holderName || "another editor"}`);
          error.code = this.utcNow() < lease.holderUtcMs
            ? "LEASE_CLOCK_UNCERTAIN" : "LEASE_ACTIVE";
          error.lease = lease;
          if (advice === "confirm-takeover" && issueTakeoverToken) {
            error.takeoverToken = this.#issueLeaseTakeoverToken(active, lease);
          }
          throw error;
        }
        if (active !== this.active || this.lockOperation) {
          const error = new Error("The document was locked while acquiring its editing lease");
          error.code = "SESSION_LOCKED";
          throw error;
        }
        const action = advice === "confirm-takeover" ? "takeover" : advice;
        const sessionId = action === "resume" ? suspended.sessionId : this.randomSessionId();
        const published = await this.#publishNativeLease(active, bytes, action,
          sessionId, lease, profile, {
            explicitTakeover: action === "takeover",
            unchangedMonotonicMs: elapsed,
            isCurrent: () => active === this.active && !this.lockOperation,
          });
        if (!this.container.leaseMode().editing
            || this.container.leaseMode().leaseStatus !== "held") {
          throw new Error("Native lease acquisition did not enter Edit mode");
        }
        active.leaseSessionId = Buffer.from(sessionId);
        active.leaseCounter = published.heartbeatCounter;
        this.suspendedLeases.delete(active.documentId);
        return;
      }
      const lease = latest.lease;
      const acquisition = this.#leaseAcquisition(active, lease,
        { takeoverToken, issueTakeoverToken });
      const nextLease = {
        active: true, sessionId: acquisition.sessionId.toString("hex"),
        heartbeatCounter: acquisition.heartbeatCounter,
        holderUtcMs: this.utcNow(), durationMs: lease.durationMs,
        holderName: profile.name, holderEmail: profile.email,
        deviceName: profile.deviceName,
      };
      const candidate = this.native.updateLease(bytes, active.password, nextLease);
      await this.#atomicWrite(active.target, candidate, true, () => true, bytes);
      active.baseContainer = Buffer.from(candidate);
      active.leaseSessionId = Buffer.from(acquisition.sessionId);
      active.leaseCounter = nextLease.heartbeatCounter;
      this.suspendedLeases.delete(active.documentId);
    });
    this.leaseGeneration += 1;
    this.#scheduleHeartbeat(this.leaseGeneration);
  }

  async #acquireActiveLease(active, options = {}) {
    if (this.active !== active || this.lockOperation) {
      const error = new Error("The document was locked while acquiring its editing lease");
      error.code = "SESSION_LOCKED";
      throw error;
    }
    const acquisition = this.#acquireLease(options);
    this.leaseAcquisitionOperations.add(acquisition);
    try { await acquisition; }
    finally { this.leaseAcquisitionOperations.delete(acquisition); }
    if (this.active !== active || this.lockOperation) {
      const error = new Error("The document was locked while acquiring its editing lease");
      error.code = "SESSION_LOCKED";
      throw error;
    }
  }

  #leaseAcquisition(active, lease, {
    takeoverToken, issueTakeoverToken = false,
    observedDocumentId = active.documentId } = {}) {
    let confirmedTakeover = false;
    if (takeoverToken !== undefined) {
      // Object identity is the capability; a renderer-created lookalike cannot authorize.
      const validToken = takeoverToken !== null
        && (typeof takeoverToken === "object" || typeof takeoverToken === "function")
        ? this.leaseTakeoverConfirmations.get(takeoverToken) : undefined;
      if (validToken) this.leaseTakeoverConfirmations.delete(takeoverToken);
      if (!validToken || validToken.documentId !== active.documentId
          || validToken.documentId !== observedDocumentId
          || validToken.active !== active
          || validToken.target !== active.target
          || validToken.baseRevision !== active.baseRevision
          || validToken.lease !== this.#leaseFingerprint(lease)) {
        const error = new Error("Editing lease changed after takeover confirmation");
        error.code = "LEASE_CHANGED";
        error.lease = lease;
        throw error;
      }
      confirmedTakeover = true;
    }
    const suspended = this.suspendedLeases.get(active.documentId);
    const sessionMatches = lease.active && suspended?.target === active.target
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
      if (!reliableExpiry && !observedStale && !confirmedTakeover) {
        const error = new Error(`Editing lease held by ${lease.holderName || "another editor"}`);
        error.code = age < 0 ? "LEASE_CLOCK_UNCERTAIN" : "LEASE_ACTIVE";
        error.lease = lease;
        if (issueTakeoverToken && (error.code === "LEASE_CLOCK_UNCERTAIN"
            || (error.code === "LEASE_ACTIVE" && active.opened.recoverySlot))) {
          error.takeoverToken = this.#issueLeaseTakeoverToken(
            active, lease, observedDocumentId);
        }
        throw error;
      }
    }
    return { sessionId: sameSession ? suspended.sessionId : this.randomSessionId(),
      heartbeatCounter: sameSession ? lease.heartbeatCounter + 1 : 1 };
  }

  #leaseFingerprint(lease) {
    return JSON.stringify([lease.active, lease.sessionId, lease.heartbeatCounter,
      lease.holderUtcMs, lease.durationMs, lease.holderName, lease.holderEmail,
      lease.deviceName]);
  }

  #nativeLeaseAvailable(active) {
    return !active.migrationRequired && this.container
      && typeof this.container.prepareLeaseChange === "function";
  }

  #leasePendingWork(active) {
    if (active.dirty) {
      if (!active.working) throw new Error("Dirty lease work has no working copy");
      return { text: active.working.content, cursor: active.working.cursor };
    }
    if (active.recovery) {
      return { text: active.recovery.text, cursor: active.recovery.cursor };
    }
    return null;
  }

  #syncNativeLeaseSource(active, bytes, { allowReplacement = false } = {}) {
    if (this.containerTarget === active.target && this.containerBytes?.equals(bytes)) {
      if (this.container.status().locked) this.container.unlock(active.password);
      return;
    }
    if (this.containerTarget && !allowReplacement) {
      const error = new Error("Editing lease source changed before publication");
      error.code = "LEASE_CHANGED";
      throw error;
    }
    if (this.containerTarget) this.closeContainer();
    this.container.open(bytes);
    this.container.unlock(active.password);
    this.containerTarget = active.target;
    this.containerBytes = Buffer.from(bytes);
  }

  async #publishNativeLease(active, source, action, sessionId, lease,
    profile, { unchangedMonotonicMs = 0, explicitTakeover = false,
      isCurrent = () => true } = {}) {
    if (this.pendingNativeCandidate !== null) {
      throw new Error("Resolve the pending candidate before changing the lease");
    }
    // The revision head is unchanged by heartbeats; compare the exact image.
    if (!this.container.bytes().equals(source)) {
      const error = new Error("Editing lease source changed before publication");
      error.code = "LEASE_CHANGED";
      throw error;
    }
    const candidate = this.container.prepareLeaseChange(action, active.password, {
      operationId: this.nextCandidateOperation++,
      sessionId: sessionId.toString("hex"), expectedActive: lease.active,
      expectedSessionId: lease.sessionId,
      expectedHeartbeatCounter: lease.heartbeatCounter,
      expectedHolderUtcMs: lease.holderUtcMs,
      expectedDurationMs: lease.durationMs,
      nowUtcMs: this.utcNow(), unchangedMonotonicMs,
      durationMs: lease.durationMs,
      holderName: profile.name, holderEmail: profile.email,
      deviceName: profile.deviceName, explicitTakeover,
    });
    if (!Buffer.isBuffer(candidate.bytes)
        || (candidate.effects & LEASE_PUBLISH_EFFECTS) !== LEASE_PUBLISH_EFFECTS) {
      this.container.finishSave(candidate.operationId, "definite-failure");
      throw new Error("Native lease candidate omitted required publication effects");
    }
    this.pendingNativeCandidate = candidate.operationId;
    try {
      if (!isCurrent()) {
        const stale = new Error("Lease publication no longer belongs to this session");
        stale.code = "STALE_HEARTBEAT";
        throw stale;
      }
      const pendingWork = this.#leasePendingWork(active);
      await this.publications.publish({ documentId: active.documentId,
        journalKey: active.journalKey, target: active.target, base: source,
        candidate: candidate.bytes,
        text: pendingWork?.text ?? active.opened.content ?? "",
        cursor: pendingWork?.cursor ?? { start: 0, end: 0 },
        baseRevision: active.baseRevision, purpose: "lease-change",
        preserveWork: pendingWork !== null });
      const adopted = this.container.finishSave(candidate.operationId, "verified");
      this.pendingNativeCandidate = null;
      if ((adopted & LEASE_ADOPT_EFFECT) === 0) {
        throw new Error("Native lease candidate was not adopted");
      }
      this.containerBytes = this.container.bytes();
      active.baseContainer = Buffer.from(candidate.bytes);
      return this.container.authenticatedLease();
    } catch (error) {
      if (this.pendingNativeCandidate === candidate.operationId) {
        let observed;
        try { observed = await this.fs.readFile(active.target); } catch {}
        if (error.publicationPrepared) {
          this.container.finishSave(candidate.operationId, "ambiguous");
          active.pendingPublication = true;
          active.unresolvedJournal = true;
        } else if (observed?.equals(candidate.bytes)) {
          this.container.finishSave(candidate.operationId, "verified");
          this.containerBytes = this.container.bytes();
          active.baseContainer = Buffer.from(candidate.bytes);
        } else {
          this.container.finishSave(candidate.operationId, "definite-failure");
        }
        this.pendingNativeCandidate = error.publicationPrepared
          ? candidate.operationId : null;
      }
      throw error;
    }
  }

  #issueLeaseTakeoverToken(active, lease, observedDocumentId = active.documentId) {
    const token = Object.freeze({});
    this.leaseTakeoverConfirmations.set(token, {
      active, documentId: observedDocumentId, target: active.target,
      baseRevision: active.baseRevision, lease: this.#leaseFingerprint(lease) });
    return token;
  }

  cancelLeaseTakeover(takeoverToken) {
    if (takeoverToken === null
        || (typeof takeoverToken !== "object" && typeof takeoverToken !== "function")) {
      return false;
    }
    return this.leaseTakeoverConfirmations.delete(takeoverToken);
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
        this.onJournalWarning("LEASE_REFRESH_FAILED");
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
      if (this.#nativeLeaseAvailable(active)) {
        this.#syncNativeLeaseSource(active, bytes);
        const lease = this.container.authenticatedLease();
        const mode = this.container.leaseMode();
        if (!mode.editing || mode.leaseStatus !== "held"
            || !lease.active || lease.sessionId !== active.leaseSessionId.toString("hex")
            || lease.heartbeatCounter !== active.leaseCounter) {
          active.editMode = false;
          throw new Error("Editing lease was replaced by another client");
        }
        const profile = await this.loadProfile();
        this.#requireCurrentHeartbeat(active, generation);
        const published = await this.#publishNativeLease(active, bytes, "refresh",
          active.leaseSessionId, lease, profile, {
            isCurrent: () => active === this.active
              && generation === this.leaseGeneration,
          });
        active.leaseCounter = published.heartbeatCounter;
        this.#requireCurrentHeartbeat(active, generation);
        return;
      }
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
    const candidateHash = createHash("sha256").update(candidate).digest("hex");
    if (candidateHash !== record.publication.candidateHash) {
      throw new Error("Pending publication candidate hash does not match its journal");
    }
    const opened = this.#validateNativeOpened(this.native.openDocument(candidate, password));
    let mergeAncestor;
    let leaseBase;
    try {
      const invitationClaim = record.publication.purpose === "invitation-claim";
      const migration = record.publication.purpose === "format-migration";
      const leaseChange = record.publication.purpose === "lease-change";
      if (leaseChange) {
        leaseBase = this.#validateNativeOpened(this.native.openDocument(
          Buffer.from(record.publication.base, "base64"), password));
      }
      if (opened.documentId !== documentId
          || (invitationClaim && (record.publication.reopenPassword !== password
            || record.text !== "" || opened.opened.invitationRequired))
          || (leaseChange && (opened.opened.content !== leaseBase.opened.content
            || opened.baseRevision !== leaseBase.baseRevision
            || !opened.journalKey.equals(leaseBase.journalKey)))
          || (!invitationClaim && !leaseChange
            && opened.opened.content !== (record.merge?.localContent ?? record.text))
          || (migration && (opened.containerFormatVersion !== 3
            || opened.historyEventType !== "format-migration"))) {
        throw new Error("Pending publication candidate does not match its document");
      }
      if (record.publication.mergeAncestor) {
        const ancestor = Buffer.from(record.publication.mergeAncestor, "base64");
        mergeAncestor = this.#validateNativeOpened(
          this.native.openDocument(ancestor, password));
        if (mergeAncestor.documentId !== documentId
            || !mergeAncestor.manuallySealed
            || !mergeAncestor.journalKey.equals(opened.journalKey)) {
          throw new Error(
            "Pending publication merge ancestor does not match its document");
        }
      }
    } finally {
      mergeAncestor?.journalKey.fill(0);
      leaseBase?.journalKey.fill(0);
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
    const reopenPassword = record.publication.reopenPassword ?? password;
    this.#validateCandidate(record, reopenPassword, baseOpened.documentId);

    let targetBytes = null;
    let targetOpened = null;
    let targetPassword = password;
    let invalidTarget = false;
    let unavailable = false;
    try {
      targetBytes = await this.fs.readFile(target);
      try {
        targetOpened = this.#validateNativeOpened(
          this.native.openDocument(targetBytes, password));
      } catch (passwordError) {
        if (reopenPassword === password) throw passwordError;
        targetOpened = this.#validateNativeOpened(
          this.native.openDocument(targetBytes, reopenPassword));
        targetPassword = reopenPassword;
      }
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
      this.onJournalWarning("PUBLICATION_AUTH_CONFLICT");
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
          this.native.openDocument(published, reopenPassword));
        const { headMismatch, slotCanEdit } = await this.#observeHead(target, reopened);
        baseOpened.journalKey.fill(0);
        targetOpened?.journalKey.fill(0);
        const regularSave = record.publication.purpose === "regular-save"
          && !reopened.manuallySealed;
        const restoredWork = record.publication.preserveWork
          ? await this.journals.read(reopened.documentId, reopened.journalKey) : null;
        const recovery = restoredWork?.state === "unsaved"
          ? { content: restoredWork.text, cursor: restoredWork.cursor,
            state: "unsaved", updateTime: restoredWork.updateTime }
          : regularSave ? { content: reopened.opened.content,
          cursor: { start: 0, end: 0 }, state: "unsaved",
          updateTime: Number.isSafeInteger(reopened.revisionTimestampMs)
            ? reopened.revisionTimestampMs : this.now(),
          ...(reopened.profileName ? { authorName: reopened.profileName } : {}),
          ...(reopened.deviceName ? { deviceName: reopened.deviceName } : {}) } : null;
        const opened = validateOpenedDocument({ ...reopened.opened,
          canEdit: headMismatch ? false : slotCanEdit,
          publicationState: "target-published",
          ...(reopened.lease.active ? { lease: reopened.lease } : {}),
          ...(recovery ? { recovery } : {}),
          ...(headMismatch ? { headMismatch } : {}) });
        this.#openActiveContainer(target, published, reopenPassword, reopened);
        this.active = { target, password: reopenPassword, opened, editMode: false,
          documentId: reopened.documentId, baseRevision: reopened.baseRevision,
          revisionGraph: reopened.revisionGraph, observation: this.#observation(reopened),
          slotCanEdit, headMismatch, migrationRequired: false,
          journalKey: Buffer.from(reopened.journalKey), recovery,
          baseContainer: Buffer.from(published), targetContent: reopened.opened.content,
          working: null, dirty: false, manuallySealed: reopened.manuallySealed,
          pendingPublication: false, pendingRecord: null,
          unresolvedJournal: recovery !== null,
          continuousDue: null, journalWarning: null };
        reopened.journalKey.fill(0);
        this.onJournalWarning("PUBLICATION_RECOVERED");
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
      this.onJournalWarning("PUBLICATION_PENDING_TARGET_UNAVAILABLE");
    }

    const currentOpened = targetOpened && !invalidTarget ? targetOpened : baseOpened;
    const { headMismatch, slotCanEdit } = await this.#observeHead(target, currentOpened);
    const migrationRequired = currentOpened.containerFormatVersion < 3;
    const opened = validateOpenedDocument({ ...baseOpened.opened,
      content: record.text, canEdit: headMismatch ? false : slotCanEdit,
      publicationState,
      ...(migrationRequired ? { migrationRequired: true,
        migrationCanEdit: slotCanEdit } : {}),
      ...(currentOpened.lease.active ? { lease: currentOpened.lease } : {}),
      ...(headMismatch ? { headMismatch } : {}) });
    const currentBytes = targetOpened && !invalidTarget ? targetBytes : bootstrap.base;
    const currentPassword = targetOpened && !invalidTarget ? targetPassword : password;
    this.#openActiveContainer(target, currentBytes, currentPassword, currentOpened);
    this.active = { target, password: currentPassword, opened, editMode: false,
      documentId: baseOpened.documentId, baseRevision: currentOpened.baseRevision,
      revisionGraph: currentOpened.revisionGraph,
      observation: this.#observation(currentOpened), slotCanEdit, headMismatch,
      migrationRequired,
      journalKey: Buffer.from(baseOpened.journalKey), recovery: null,
      baseContainer: Buffer.from(currentBytes),
      targetContent: currentOpened.opened.content,
      working: null, dirty: false, manuallySealed: currentOpened.manuallySealed,
      pendingPublication: true, pendingRecord: record, unresolvedJournal: true,
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
    const migrationRequired = reopened.containerFormatVersion < 3;
    active.journalKey.fill(0);
    active.opened = validateOpenedDocument({ ...reopened.opened,
      canEdit: headMismatch || migrationRequired ? false : slotCanEdit,
      publicationState: "target-published",
      ...(migrationRequired ? { migrationRequired: true,
        migrationCanEdit: slotCanEdit } : {}),
      ...(reopened.lease.active ? { lease: reopened.lease } : {}),
      ...(headMismatch ? { headMismatch } : {}) });
    active.documentId = reopened.documentId;
    active.baseRevision = reopened.baseRevision;
    active.revisionGraph = reopened.revisionGraph;
    active.observation = this.#observation(reopened);
    active.slotCanEdit = slotCanEdit;
    active.headMismatch = headMismatch;
    active.migrationRequired = migrationRequired;
    active.baseContainer = Buffer.from(published);
    active.targetContent = reopened.opened.content;
    active.journalKey = Buffer.from(reopened.journalKey);
    reopened.journalKey.fill(0);
    const newerWork = newerWorkingCopy(active.working,
      active.pendingSubmittedVersion, active.opened.content);
    if (!newerWork) {
      active.working = { content: active.opened.content, cursor: { start: 0, end: 0 } };
    }
    active.dirty = newerWork || !reopened.manuallySealed;
    active.sealedWorkingVersion = active.pendingSubmittedVersion ?? null;
    active.pendingSubmittedVersion = null;
    active.pendingPublication = false;
    active.pendingRecord = null;
    active.mergeLocalPassword = null;
    active.manuallySealed = reopened.manuallySealed;
    active.unresolvedJournal = false;
    active.recovery = null;
    active.continuousDue = null;
    if (newerWork) this.#scheduleCheckpoint();
  }

  async #discardProvisional(active) {
    if (active.headMismatch) {
      throw new Error("Resolve the head mismatch before discarding provisional work");
    }
    if (!active.editMode) {
      await this.#acquireActiveLease(active);
      active.editMode = true;
    }
    const profile = await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    try {
      await this.#queuePublication(async () => {
        const current = await this.fs.readFile(active.target);
        const inspected = this.#validateNativeOpened(
          this.native.openDocument(current, active.password));
        try {
          if (inspected.baseRevision !== active.baseRevision
              || !inspected.lease.active || !active.leaseSessionId
              || !Buffer.from(inspected.lease.sessionId, "hex")
                .equals(active.leaseSessionId)
              || inspected.lease.heartbeatCounter !== active.leaseCounter) {
            throw new Error(
              "The target changed before provisional work could be discarded");
          }
          const prepared = this.#prepareSaveCandidate(active, current,
            "discard", profile, inspected.opened.content);
          const candidate = prepared.bytes;
          const candidateOpened = this.#validateNativeOpened(
            this.native.openDocument(candidate, active.password));
          try {
            if (!candidateOpened.manuallySealed) {
              throw new Error("Discard did not restore a manually sealed revision");
            }
            await this.publications.publish({ documentId: active.documentId,
              journalKey: active.journalKey, target: active.target,
              base: current, candidate, text: candidateOpened.opened.content,
              cursor: { start: 0, end: 0 }, baseRevision: active.baseRevision,
              purpose: "provisional-discard" });
            this.#finishSaveCandidate(prepared.operationId, "verified");
          } finally {
            candidateOpened.journalKey.fill(0);
          }
        } finally {
          inspected.journalKey.fill(0);
        }
      });
      await this.journals.clear(active.documentId);
      active.working = null;
      active.pendingSubmittedVersion = null;
      await this.#adoptPublishedCandidate(active);
      await this.exitEditMode();
      return active.opened;
    } catch (error) {
      if (this.pendingNativeCandidate !== null) {
        this.#finishSaveCandidate(this.pendingNativeCandidate,
          error.publicationPrepared ? "ambiguous" : "definite-failure");
      }
      if (error.publicationPrepared) {
        active.pendingRecord = await this.journals.read(
          active.documentId, active.journalKey);
        if (active.pendingRecord?.publication) {
          let target = null;
          try { target = await this.fs.readFile(active.target); } catch {}
          const expectedBase = Buffer.from(active.pendingRecord.publication.base, "base64");
          const expectedCandidate = Buffer.from(
            active.pendingRecord.publication.candidate, "base64");
          if (target && !target.equals(expectedBase) && !target.equals(expectedCandidate)) {
            active.pendingRecord = await this.publications.markDiverged(
              active.documentId, active.journalKey, active.pendingRecord);
          }
          active.pendingPublication = true;
          active.unresolvedJournal = true;
          active.opened = validateOpenedDocument({ ...active.opened,
            content: active.pendingRecord.text,
            publicationState: active.pendingRecord.state === "conflict"
              ? "conflict" : "pending-publication" });
        }
      }
      active.editMode = false;
      await this.#stopHeartbeat();
      throw error;
    }
  }

  #regularSaveMergeAncestor(active) {
    if (active.manuallySealed) return undefined;
    const mergeAncestor = this.native.discardProvisional(
      active.baseContainer, active.password);
    const ancestorOpened = this.#validateNativeOpened(
      this.native.openDocument(mergeAncestor, active.password));
    try {
      if (ancestorOpened.documentId !== active.documentId
          || !ancestorOpened.manuallySealed
          || !ancestorOpened.journalKey.equals(active.journalKey)) {
        throw new Error(
          "Provisional base did not restore the authenticated sealed ancestor");
      }
    } finally {
      ancestorOpened.journalKey.fill(0);
    }
    return mergeAncestor;
  }

  async #preserveRegularSaveConflict(active, profile, canonical, mergeAncestor) {
    const candidate = this.native.regularSaveDocument(
      active.baseContainer, active.password, {
        ...profile, content: canonical, timestampMs: Date.now(),
      });
    if (!Buffer.isBuffer(candidate) || candidate.length === 0) {
      throw new Error("Native bridge did not produce a provisional container");
    }
    let record = await this.publications.prepare({
      documentId: active.documentId, journalKey: active.journalKey,
      target: active.target, base: active.baseContainer, candidate,
      text: canonical, cursor: { ...active.working.cursor },
      baseRevision: active.baseRevision, purpose: "regular-save",
      ...(mergeAncestor ? { mergeAncestor } : {}), state: "unsaved",
    });
    record = await this.publications.markDiverged(
      active.documentId, active.journalKey, record);
    active.pendingPublication = true;
    active.pendingRecord = record;
    active.unresolvedJournal = true;
    active.opened = validateOpenedDocument({ ...active.opened,
      content: canonical, publicationState: "conflict" });
    this.onJournalWarning("REGULAR_SAVE_CONFLICT");
    return Object.freeze({ published: false, conflict: true, content: canonical });
  }

  async #observeHead(target, opened) {
    let headMismatch = null;
    try {
      const observation = this.#observation(opened);
      let result;
      if (opened.manuallySealed) {
        result = await this.witnesses.observe(target, observation);
      } else {
        const previous = await this.witnesses.read(target);
        result = { comparison: compareHeadWitness(previous, observation), previous };
      }
      const { comparison, previous } = result;
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
    this.#resolveSaveCandidate(false);
    active.opened = validateOpenedDocument({ ...active.opened,
      publicationState: "conflict" });
    return validatePublicationResult({ publicationState: "conflict",
      content: active.pendingRecord.text });
  }

  #scheduleCheckpoint() {
    const active = this.active;
    const journalScope = active.working?.journalScope ?? null;
    const now = this.now();
    if (active.continuousDue === null) {
      active.continuousDue = now + this.checkpointContinuousMs;
    }
    if (this.checkpointTimer !== null) this.clearTimer(this.checkpointTimer);
    const due = Math.min(now + this.checkpointIdleMs, active.continuousDue);
    this.checkpointTimer = this.setTimer(() => {
      this.checkpointTimer = null;
      void this.#flushActive(active).catch((error) => {
        active.journalWarning = "RECOVERY_CHECKPOINT_FAILED";
        this.onJournalWarning(active.journalWarning, journalScope);
      });
    }, Math.max(0, due - now));
    this.checkpointTimer?.unref?.();
  }

  async #flushActive(active) {
    if (!active?.dirty || !active.working
        || (active.pendingPublication && !active.pendingRecord?.merge)) return;
    const record = active.pendingRecord?.merge
      ? { ...active.pendingRecord, text: active.working.content,
        cursor: { ...active.working.cursor }, updateTime: this.now() }
      : { text: active.working.content, baseRevision: active.baseRevision,
        cursor: { ...active.working.cursor }, target: active.target,
        state: "unsaved", updateTime: this.now() };
    const operation = this.flushChain.catch(() => {}).then(() =>
      this.journals.write(active.documentId, active.journalKey, record));
    this.flushChain = operation;
    await operation;
    active.unresolvedJournal = true;
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

  #scheduleRegularSave() {
    this.#cancelRegularSave();
    const active = this.active;
    if (!this.clientSettings.regularSaveEnabled || !active?.editMode) return;
    this.regularSaveTimer = this.setTimer(() => {
      this.regularSaveTimer = null;
      void this.regularSaveDocument().catch((error) => {
        this.onJournalWarning("REGULAR_SAVE_FAILED");
      }).finally(() => {
        if (active === this.active && active.editMode) this.#scheduleRegularSave();
      });
    }, this.clientSettings.regularSaveIntervalMs);
    this.regularSaveTimer?.unref?.();
  }

  #cancelRegularSave() {
    if (this.regularSaveTimer !== null) this.clearTimer(this.regularSaveTimer);
    this.regularSaveTimer = null;
  }

  #queuePublication(operation) {
    this.publicationOperations += 1;
    const previous = this.publicationChain.catch(() => {});
    const queued = this.lifecycle.runMaintenance(async () => {
      await previous;
      return operation();
    })
      .finally(() => { this.publicationOperations -= 1; });
    this.publicationChain = queued;
    return queued;
  }

  async #atomicWrite(target, bytes, replace, isCurrent = () => true,
    expectedTarget = null) {
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
      if (expectedTarget !== null) {
        const observed = await this.fs.readFile(target);
        if (!observed.equals(expectedTarget)) {
          const error = new Error("Publication target changed before replacement");
          error.code = "TARGET_CHANGED";
          throw error;
        }
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
