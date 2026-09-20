import path from "node:path";
import { randomBytes } from "node:crypto";
import { canonicalizeDocumentText, validateCreateRequest, validateEditMode,
  validateOpenedDocument, validatePassword, validateProfile,
  validatePlaintextExportRequest, validatePlaintextExportResult,
  validateSaveResult, validateWorkingCopy } from "./contracts.mjs";
import { WorkJournalStore } from "./work-journal.mjs";

const DOCUMENT_ID = /^[0-9a-f]{32}$/;
const REVISION_ID = /^[0-9a-f]{64}$/;
const HEARTBEAT_MS = 120_000;
const DEFAULT_LEASE_DURATION_MS = 600_000;

export class DocumentService {
  constructor({ native, fs, profilePath, journalDirectory,
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
    });
    return { created: true };
  }

  async openDocument(target, password) {
    const bytes = await this.fs.readFile(target);
    const validatedPassword = validatePassword(password);
    const nativeOpened = this.#validateNativeOpened(
      this.native.openDocument(bytes, validatedPassword));
    let recovery = null;
    try {
      const journal = await this.journals.read(
        nativeOpened.documentId, nativeOpened.journalKey);
      if (journal?.state === "unsaved"
          && journal.baseRevision === nativeOpened.baseRevision) {
        recovery = journal;
      }
    } catch (error) {
      this.onJournalWarning(`Recovered work could not be read: ${error.message}`);
    }
    const opened = validateOpenedDocument({ ...nativeOpened.opened,
      lease: nativeOpened.lease.active ? nativeOpened.lease : undefined,
      ...(recovery ? { recovery: { content: recovery.text,
        cursor: recovery.cursor, state: "unsaved",
        updateTime: recovery.updateTime } } : {}) });
    this.active = { target, password: validatedPassword, opened, editMode: false,
      documentId: nativeOpened.documentId, baseRevision: nativeOpened.baseRevision,
      journalKey: Buffer.from(nativeOpened.journalKey), recovery,
      working: null, dirty: false, continuousDue: null, journalWarning: null };
    nativeOpened.journalKey.fill(0);
    this.notifyActivity();
    return opened;
  }

  async enterEditMode({ forceTakeover = false } = {}) {
    if (!this.active) throw new Error("Open a document first");
    if (this.active.recovery) {
      throw new Error("Restore or discard recovered work before editing");
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

  async restoreRecoveredWork() {
    if (!this.active?.recovery) throw new Error("No recovered work is available");
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
      canEdit: this.active.opened.canEdit, lease: this.active.opened.lease });
    return this.active.opened;
  }

  updateWorkingCopy(value) {
    if (!this.active?.editMode) throw new Error("Enter edit mode before editing");
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
    if (!this.active.opened.canEdit) {
      throw new Error("The active password slot does not permit editing");
    }
    const profile = await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    const canonical = canonicalizeDocumentText(content);
    const active = this.active;
    const reopened = await this.#queuePublication(async () => {
      const current = await this.fs.readFile(active.target);
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
      if (!Buffer.isBuffer(candidate) || candidate.length === 0)
        throw new Error("Native bridge did not produce a container");
      await this.#atomicWrite(active.target, candidate, true);
      const published = await this.fs.readFile(active.target);
      if (!published.equals(candidate))
        throw new Error("Published container verification failed");
      return this.#validateNativeOpened(
        this.native.openDocument(published, active.password));
    });
    if (reopened.opened.content !== canonical) {
      reopened.journalKey.fill(0);
      throw new Error("Saved document verification failed");
    }
    this.#cancelCheckpoint();
    await this.flushChain.catch(() => {});
    await this.journals.clear(this.active.documentId);
    this.active.journalKey.fill(0);
    this.active.opened = reopened.opened;
    this.active.documentId = reopened.documentId;
    this.active.baseRevision = reopened.baseRevision;
    this.active.journalKey = Buffer.from(reopened.journalKey);
    reopened.journalKey.fill(0);
    this.active.working = { content: canonical, cursor: { start: 0, end: 0 } };
    this.active.dirty = false;
    this.active.recovery = null;
    this.active.continuousDue = null;
    this.notifyActivity();
    return validateSaveResult({ saved: true, content: canonical });
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
    return { opened, documentId: value.documentId,
      baseRevision: value.baseRevision, journalKey: value.journalKey,
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
      await this.#atomicWrite(active.target,
        this.native.updateLease(bytes, active.password, nextLease), true,
        () => active === this.active && generation === this.leaseGeneration);
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
    if (!active?.dirty || !active.working) return;
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
