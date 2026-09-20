import path from "node:path";
import { canonicalizeDocumentText, validateCreateRequest, validateEditMode,
  validateOpenedDocument, validatePassword, validateProfile,
  validatePlaintextExportRequest, validatePlaintextExportResult,
  validateSaveResult, validateWorkingCopy } from "./contracts.mjs";
import { WorkJournalStore } from "./work-journal.mjs";
import { HeadWitnessStore } from "./head-witness.mjs";

const DOCUMENT_ID = /^[0-9a-f]{32}$/;
const REVISION_ID = /^[0-9a-f]{64}$/;

export class DocumentService {
  constructor({ native, fs, profilePath, journalDirectory,
    witnessDirectory,
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
    this.witnesses = new HeadWitnessStore({ fs,
      directory: witnessDirectory ?? path.join(path.dirname(profilePath), "head-witnesses") });
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
    const opened = this.#validateNativeOpened(
      this.native.openDocument(published, input.ownerPassword));
    await this.witnesses.observe(target, this.#observation(opened));
    opened.journalKey.fill(0);
    return { created: true };
  }

  async openDocument(target, password) {
    const bytes = await this.fs.readFile(target);
    const validatedPassword = validatePassword(password);
    const nativeOpened = this.#validateNativeOpened(
      this.native.openDocument(bytes, validatedPassword));
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
    const slotCanEdit = nativeOpened.opened.canEdit;
    const opened = validateOpenedDocument({ ...nativeOpened.opened,
      canEdit: headMismatch ? false : slotCanEdit,
      ...(headMismatch ? { headMismatch } : {}),
      ...(recovery ? { recovery: { content: recovery.text,
        cursor: recovery.cursor, state: "unsaved",
        updateTime: recovery.updateTime } } : {}) });
    this.active = { target, password: validatedPassword, opened, editMode: false,
      documentId: nativeOpened.documentId, baseRevision: nativeOpened.baseRevision,
      revisionGraph: nativeOpened.revisionGraph, observation: this.#observation(nativeOpened),
      slotCanEdit, headMismatch,
      journalKey: Buffer.from(nativeOpened.journalKey), recovery,
      working: null, dirty: false, continuousDue: null, journalWarning: null };
    nativeOpened.journalKey.fill(0);
    this.notifyActivity();
    return opened;
  }

  enterEditMode() {
    if (!this.active) throw new Error("Open a document first");
    if (this.active.recovery) {
      throw new Error("Restore or discard recovered work before editing");
    }
    if (this.active.headMismatch) {
      throw new Error("Accept or resolve the head mismatch before editing");
    }
    if (!this.active.opened.canEdit) {
      throw new Error("The active password slot does not permit editing");
    }
    this.active.editMode = true;
    this.active.working = { content: this.active.opened.content,
      cursor: { start: 0, end: 0 } };
    return validateEditMode({ ...this.active.opened, readOnly: false });
  }

  async restoreRecoveredWork() {
    if (!this.active?.recovery) throw new Error("No recovered work is available");
    if (this.active.headMismatch) {
      throw new Error("Accept or resolve the head mismatch before editing");
    }
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
      canEdit: this.active.headMismatch ? false : this.active.slotCanEdit,
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
      ...(this.active.opened.recovery ? { recovery: this.active.opened.recovery } : {}),
    });
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
    if (this.active.headMismatch) {
      throw new Error("Accept or resolve the head mismatch before saving");
    }
    if (!this.active.opened.canEdit) {
      throw new Error("The active password slot does not permit editing");
    }
    const profile = await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    const canonical = canonicalizeDocumentText(content);
    const current = await this.fs.readFile(this.active.target);
    const candidate = this.native.saveDocument(current, this.active.password, {
      ...profile, content: canonical, timestampMs: Date.now(),
    });
    if (!Buffer.isBuffer(candidate) || candidate.length === 0) {
      throw new Error("Native bridge did not produce a container");
    }
    await this.#atomicWrite(this.active.target, candidate, true);
    const published = await this.fs.readFile(this.active.target);
    if (!published.equals(candidate)) throw new Error("Published container verification failed");
    const reopened = this.#validateNativeOpened(
      this.native.openDocument(published, this.active.password));
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
    this.active.revisionGraph = reopened.revisionGraph;
    this.active.observation = this.#observation(reopened);
    await this.witnesses.observe(this.active.target, this.active.observation);
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
      baseRevision: value.baseRevision, revisionGraph,
      journalKey: value.journalKey };
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
