import path from "node:path";
import { canonicalizeDocumentText, validateCreateRequest, validateEditMode,
  validateOpenedDocument, validatePassword, validateProfile,
  validatePlaintextExportRequest, validatePlaintextExportResult,
  validatePublicationResult, validateSaveResult, validateWorkingCopy } from "./contracts.mjs";
import { WorkJournalStore } from "./work-journal.mjs";
import { PublicationService } from "./publication.mjs";

const DOCUMENT_ID = /^[0-9a-f]{32}$/;
const REVISION_ID = /^[0-9a-f]{64}$/;
const UNAVAILABLE_CODES = new Set([
  "ENOENT", "ENOTDIR", "EACCES", "EIO", "ENODEV", "ESTALE", "ETIMEDOUT",
  "ECONNRESET",
]);

function targetUnavailable(error) {
  return UNAVAILABLE_CODES.has(error?.code);
}

export class DocumentService {
  constructor({ native, fs, profilePath, journalDirectory,
    publicationCapabilities,
    nativeLineEnding = process.platform === "win32" ? "\r\n" : "\n",
    checkpointIdleMs = 10_000, checkpointContinuousMs = 30_000,
    inactivityMs = 120_000, now = () => Date.now(),
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
    this.checkpointIdleMs = checkpointIdleMs;
    this.checkpointContinuousMs = checkpointContinuousMs;
    this.inactivityMs = inactivityMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onLocked = onLocked;
    this.onJournalWarning = onJournalWarning;
    this.checkpointTimer = null;
    this.inactivityTimer = null;
    this.flushChain = Promise.resolve();
    this.active = null;
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
    await this.#atomicWrite(target, candidate, false);
    const published = await this.fs.readFile(target);
    if (!published.equals(candidate)) throw new Error("Published container verification failed");
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
    const opened = validateOpenedDocument({ ...nativeOpened.opened,
      ...(pendingRecord ? { content: pendingRecord.text } : {}), publicationState,
      ...(recovery ? { recovery: { content: recovery.text,
        cursor: recovery.cursor, state: "unsaved",
        updateTime: recovery.updateTime } } : {}) });
    this.active = { target, password: validatedPassword, opened, editMode: false,
      documentId: nativeOpened.documentId, baseRevision: nativeOpened.baseRevision,
      journalKey: Buffer.from(nativeOpened.journalKey), recovery,
      baseContainer: Buffer.from(bytes), targetContent: targetOpened.content,
      working: null, dirty: false,
      pendingPublication, pendingRecord,
      continuousDue: null, journalWarning: null };
    nativeOpened.journalKey.fill(0);
    this.notifyActivity();
    return opened;
  }

  enterEditMode() {
    if (!this.active) throw new Error("Open a document first");
    if (this.active.pendingPublication) {
      throw new Error("Resolve the interrupted publication before editing");
    }
    if (this.active.recovery) {
      throw new Error("Restore or discard recovered work before editing");
    }
    if (!this.active.opened.canEdit) {
      throw new Error("The active password slot does not permit editing");
    }
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
    if (!this.active.opened.canEdit) {
      throw new Error("The active password slot does not permit editing");
    }
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
      canEdit: this.active.opened.canEdit });
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
      readOnly: true, canEdit: active.opened.canEdit,
      publicationState: "target-published" });
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
    this.#cancelTimers();
    let journalSaved = true;
    let warning = null;
    try {
      await this.#flushActive(active);
    } catch (error) {
      journalSaved = false;
      warning = `Latest changes could not be checkpointed: ${error.message}`;
    } finally {
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

  async saveDocument(content) {
    if (!this.active) throw new Error("Open a document first");
    if (!this.active.editMode) throw new Error("Enter edit mode before saving");
    if (this.active.pendingPublication) {
      throw new Error("Resolve the interrupted publication before saving");
    }
    if (!this.active.opened.canEdit) {
      throw new Error("The active password slot does not permit editing");
    }
    const profile = await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    const canonical = canonicalizeDocumentText(content);
    this.#cancelCheckpoint();
    await this.flushChain.catch(() => {});
    const base = this.active.baseContainer;
    const baseRevision = this.active.baseRevision;
    const candidate = this.native.saveDocument(base, this.active.password, {
      ...profile, content: canonical, timestampMs: Date.now(),
    });
    if (!Buffer.isBuffer(candidate) || candidate.length === 0) {
      throw new Error("Native bridge did not produce a container");
    }
    let current;
    try {
      current = await this.fs.readFile(this.active.target);
    } catch (error) {
      if (!targetUnavailable(error)) throw error;
      this.active.pendingRecord = await this.publications.prepare({
        documentId: this.active.documentId,
        journalKey: this.active.journalKey,
        target: this.active.target,
        base,
        candidate,
        text: canonical,
        cursor: { start: 0, end: 0 },
        baseRevision,
      });
      this.active.pendingPublication = true;
      this.active.working = { content: canonical, cursor: { start: 0, end: 0 } };
      this.active.dirty = false;
      this.active.opened = validateOpenedDocument({ ...this.active.opened,
        publicationState: "pending-publication" });
      return validateSaveResult({ saved: true, content: canonical,
        publicationState: "pending-publication" });
    }
    if (!current.equals(base)) {
      const observed = this.#validateNativeOpened(
        this.native.openDocument(current, this.active.password));
      observed.journalKey.fill(0);
      if (observed.documentId !== this.active.documentId) {
        throw new Error("The publication target is a different document");
      }
      this.active.baseContainer = Buffer.from(current);
      this.active.baseRevision = observed.baseRevision;
      this.active.targetContent = observed.opened.content;
      this.active.pendingRecord = await this.publications.prepare({
        documentId: this.active.documentId, journalKey: this.active.journalKey,
        target: this.active.target, base, candidate, text: canonical,
        cursor: { start: 0, end: 0 }, baseRevision,
      });
      this.active.pendingRecord = await this.publications.markDiverged(
        this.active.documentId, this.active.journalKey, this.active.pendingRecord);
      this.active.pendingPublication = true;
      this.active.working = { content: canonical, cursor: { start: 0, end: 0 } };
      this.active.dirty = false;
      this.active.opened = validateOpenedDocument({ ...this.active.opened,
        content: canonical, publicationState: "conflict" });
      return validateSaveResult({ saved: true, content: canonical,
        publicationState: "conflict" });
    }
    try {
      await this.publications.publish({
        documentId: this.active.documentId,
        journalKey: this.active.journalKey,
        target: this.active.target,
        base,
        candidate,
        text: canonical,
        cursor: { start: 0, end: 0 },
        baseRevision,
      });
    } catch (error) {
      if (error.publicationPrepared) {
        this.active.pendingPublication = true;
        this.active.pendingRecord = await this.journals.read(
          this.active.documentId, this.active.journalKey);
        this.active.opened = validateOpenedDocument({ ...this.active.opened,
          content: canonical, publicationState: "pending-publication" });
        this.active.working = { content: canonical, cursor: { start: 0, end: 0 } };
        this.active.dirty = false;
      }
      throw error;
    }
    const published = await this.fs.readFile(this.active.target);
    const reopened = this.#validateNativeOpened(
      this.native.openDocument(published, this.active.password));
    if (reopened.opened.content !== canonical) {
      reopened.journalKey.fill(0);
      throw new Error("Saved document verification failed");
    }
    this.active.journalKey.fill(0);
    this.active.opened = reopened.opened;
    this.active.documentId = reopened.documentId;
    this.active.baseRevision = reopened.baseRevision;
    this.active.baseContainer = Buffer.from(published);
    this.active.targetContent = canonical;
    this.active.journalKey = Buffer.from(reopened.journalKey);
    reopened.journalKey.fill(0);
    this.active.working = { content: canonical, cursor: { start: 0, end: 0 } };
    this.active.dirty = false;
    this.active.pendingPublication = false;
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
    return { opened, documentId: value.documentId,
      baseRevision: value.baseRevision, journalKey: value.journalKey };
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
        baseOpened.journalKey.fill(0);
        targetOpened?.journalKey.fill(0);
        const opened = validateOpenedDocument({ ...reopened.opened,
          publicationState: "target-published" });
        this.active = { target, password, opened, editMode: false,
          documentId: reopened.documentId, baseRevision: reopened.baseRevision,
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
    const opened = validateOpenedDocument({ ...baseOpened.opened,
      content: record.text, publicationState });
    this.active = { target, password, opened, editMode: false,
      documentId: baseOpened.documentId, baseRevision: currentOpened.baseRevision,
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
    active.journalKey.fill(0);
    active.opened = validateOpenedDocument({ ...reopened.opened,
      publicationState: "target-published" });
    active.documentId = reopened.documentId;
    active.baseRevision = reopened.baseRevision;
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

  #cancelTimers() {
    this.#cancelCheckpoint();
    if (this.inactivityTimer !== null) this.clearTimer(this.inactivityTimer);
    this.inactivityTimer = null;
  }

  #cancelCheckpoint() {
    if (this.checkpointTimer !== null) this.clearTimer(this.checkpointTimer);
    this.checkpointTimer = null;
  }

  async #atomicWrite(target, bytes, replace) {
    const transaction = `${target}.scpefe-txn-${process.pid}-${Date.now()}`;
    let handle;
    try {
      handle = await this.fs.open(transaction, "wx");
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
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
