import path from "node:path";
import { canonicalizeDocumentText, validateCreateRequest, validateEditMode,
  validateOpenedDocument, validatePassword, validateProfile,
  validatePlaintextExportRequest, validatePlaintextExportResult,
  validateSaveResult, validateWorkingCopy } from "./contracts.mjs";
import { WorkJournalStore } from "./work-journal.mjs";
import { PublicationService } from "./publication.mjs";

const DOCUMENT_ID = /^[0-9a-f]{32}$/;
const REVISION_ID = /^[0-9a-f]{64}$/;

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
    const bytes = await this.fs.readFile(target);
    const validatedPassword = validatePassword(password);
    let nativeOpened = this.#validateNativeOpened(
      this.native.openDocument(bytes, validatedPassword));
    let recovery = null;
    let pendingPublication = false;
    try {
      const journal = await this.journals.read(
        nativeOpened.documentId, nativeOpened.journalKey);
      if (journal?.publication) {
        pendingPublication = true;
        const resumed = await this.publications.resume(
          nativeOpened.documentId, nativeOpened.journalKey, journal);
        if (resumed.completed) {
          pendingPublication = false;
          const published = await this.fs.readFile(target);
          nativeOpened.journalKey.fill(0);
          nativeOpened = this.#validateNativeOpened(
            this.native.openDocument(published, validatedPassword));
          this.onJournalWarning("Interrupted publication was completed and verified.");
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
    const opened = validateOpenedDocument({ ...nativeOpened.opened,
      ...(recovery ? { recovery: { content: recovery.text,
        cursor: recovery.cursor, state: "unsaved",
        updateTime: recovery.updateTime } } : {}) });
    this.active = { target, password: validatedPassword, opened, editMode: false,
      documentId: nativeOpened.documentId, baseRevision: nativeOpened.baseRevision,
      journalKey: Buffer.from(nativeOpened.journalKey), recovery,
      working: null, dirty: false, pendingPublication,
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
    const current = await this.fs.readFile(this.active.target);
    const candidate = this.native.saveDocument(current, this.active.password, {
      ...profile, content: canonical, timestampMs: Date.now(),
    });
    if (!Buffer.isBuffer(candidate) || candidate.length === 0) {
      throw new Error("Native bridge did not produce a container");
    }
    try {
      await this.publications.publish({
        documentId: this.active.documentId,
        journalKey: this.active.journalKey,
        target: this.active.target,
        base: current,
        candidate,
        text: canonical,
        cursor: { start: 0, end: 0 },
        baseRevision: this.active.baseRevision,
      });
    } catch (error) {
      if (error.publicationPrepared) this.active.pendingPublication = true;
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
    this.active.journalKey = Buffer.from(reopened.journalKey);
    reopened.journalKey.fill(0);
    this.active.working = { content: canonical, cursor: { start: 0, end: 0 } };
    this.active.dirty = false;
    this.active.pendingPublication = false;
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
    return { opened, documentId: value.documentId,
      baseRevision: value.baseRevision, journalKey: value.journalKey };
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
