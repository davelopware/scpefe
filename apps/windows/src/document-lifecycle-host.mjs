import path from "node:path";
import { randomUUID } from "node:crypto";
import { CreationTargetFlow } from "./creation-flow.mjs";
import { ExternalOpenLifecycle } from "./external-open-lifecycle.mjs";
import { LeaseTakeoverAuthorizations, runLeaseOperation } from "./lease-takeover.mjs";
import { NativeLifecycleCoordinator } from "./native-lifecycle.mjs";
import { ReplacementCoordinator } from "./replacement-coordinator.mjs";
import { SecureLockCoordinator } from "./secure-lock-coordinator.mjs";
import { SessionGeneration } from "./session-generation.mjs";
import { SessionProtectionCoordinator } from "./session-protection.mjs";
import { OrderedOpenRequests } from "./single-instance.mjs";
import { OpenRequestQueue } from "./switch-document.mjs";
import { registerNativeWindowClose } from "./window-lifecycle.mjs";

const AUTOMATIC_LOCK_REASONS = Object.freeze([
  "inactivity", "lease-refresh-failed", "screen-lock", "background", "app-lock",
]);

/* Owns the production document session and every replacement/termination lifecycle boundary. */
export class DocumentLifecycleHost {
  constructor({ ipc, window, serviceFactory, picker, closeWindow = () => window.close(),
    acknowledge = async () => {}, record = async () => {}, randomToken = randomUUID,
    basename = path.basename, externalPresentation = (request) => ({ token: request.token }),
    completeExternalWithoutOpen = false, observe = async () => {} }) {
    this.ipc = ipc;
    this.window = window;
    this.serviceFactory = serviceFactory;
    this.picker = picker;
    this.closeWindow = closeWindow;
    this.acknowledge = acknowledge;
    this.record = record;
    this.basename = basename;
    this.externalPresentation = externalPresentation;
    this.completeExternalWithoutOpen = completeExternalWithoutOpen;
    this.observe = observe;
    this.openRequests = new OpenRequestQueue();
    this.externalRequests = new OrderedOpenRequests({ randomToken });
    this.generation = new SessionGeneration();
    this.creation = new CreationTargetFlow();
    this.leaseTakeovers = new LeaseTakeoverAuthorizations();
    this.currentTarget = null;
    this.lockedTarget = null;
    this.selectedOpenTarget = null;
    this.externalDrainRunning = false;
    this.externalOpenInProgress = false;
    this.lockStartedServices = new WeakSet();
    this.rendererLockStarted = false;
    this.ready = false;
  }

  async start() {
    this.service = this.#makeService();
    await this.service.loadClientSettings();
    this.protections = new SessionProtectionCoordinator({ getService: () => this.service,
      generation: this.generation,
      present: (request) => this.#emit("document:protection-requested", request) });
    this.replacements = new ReplacementCoordinator({ makeCandidate: () => this.#makeService(),
      authorizeCurrent: (operation, commit, validateCandidate) =>
        this.protections.authorize(operation, commit, validateCandidate),
      adopt: (staged, target) => this.#adopt(staged, target), generation: this.generation });
    this.secureLocks = new SecureLockCoordinator({ getService: () => this.service,
      replacements: this.replacements, creationFlow: this.creation,
      clearOpenTarget: () => { this.selectedOpenTarget = null; },
      rememberLockedTarget: (target) => {
        if (target) { this.currentTarget = target; this.lockedTarget = target; }
        else if (this.currentTarget) this.lockedTarget = this.currentTarget;
      },
      emitLocked: (result) => {
        this.#emit("document:locked", result); this.rendererLockStarted = false;
        void this.sendJournalSummary();
      } });
    this.externalLifecycle = new ExternalOpenLifecycle({ requests: this.externalRequests,
      acknowledge: this.acknowledge, record: this.record,
      drain: () => this.drainExternalRequests() });
    this.lifecycle = new NativeLifecycleCoordinator({ getService: () => this.service,
      protections: this.protections, lockActive: (reason) => this.lockActive(reason),
      closeWindow: this.closeWindow,
      hasExternalRequests: () => this.externalRequests.size > 0,
      cancelExternalRequests: () => this.externalLifecycle.terminateAll("application-exit"),
      report: (warning) => this.#emit("document:journal-warning", warning) });
    this.#registerHandlers();
    registerNativeWindowClose(this.window, this.lifecycle);
    return this;
  }

  get liveService() {
    const host = this;
    return new Proxy({}, { get(_target, property) {
      const value = host.service[property];
      return typeof value === "function" ? value.bind(host.service) : value;
    } });
  }

  setReady() { this.ready = true; this.externalRequests.setReady(); return this.drainExternalRequests(); }

  enqueueExternal({ target = null, acknowledgement = null, source = "external" }) {
    const request = this.externalRequests.enqueue({ target, acknowledgement, source });
    void this.acknowledge(request, "queued", 1).then(() => this.observe("queued", request))
      .then(() => this.drainExternalRequests())
      .catch((error) => this.#emit("document:journal-warning",
        `Could not handle the open request: ${error.message}`));
    return request;
  }

  async drainExternalRequests() {
    if (!this.ready || this.externalDrainRunning || this.externalOpenInProgress) return;
    const request = this.externalRequests.take();
    if (!request) return;
    this.externalDrainRunning = true;
    this.window.show?.(); if (this.window.isMinimized?.()) this.window.restore?.();
    this.window.focus?.();
    await this.observe("presented", request);
    if (!request.target) {
      await this.acknowledge(request, "focused", 3);
      this.externalRequests.complete(request.token); this.externalDrainRunning = false;
      return this.drainExternalRequests();
    }
    this.#emit("document:external-open-requested", this.externalPresentation(request));
    await this.acknowledge(request, "presented", 2);
    this.externalDrainRunning = false;
  }

  lockActive(reason) {
    const current = this.service;
    this.#beginServiceLock(current);
    return current.runLifecycleBarrier(() => this.secureLocks.lock(reason));
  }

  async closeDocument() {
    const closed = await this.protections.authorize("close", async () => {
      if (this.service.active?.editMode) await this.service.exitEditMode();
      if (this.service.active) {
        const result = await this.service.lock("document-close");
        if (!result.journalSaved) throw new Error(result.warning
          ?? "The document could not be checkpointed before closing");
      }
      this.currentTarget = null; this.lockedTarget = null; this.selectedOpenTarget = null;
    });
    if (closed) {
      this.generation.invalidate();
      await this.externalLifecycle.cancelForLock();
      this.rendererLockStarted = false;
      this.#emit("document:closed"); await this.sendJournalSummary();
    }
    return closed;
  }

  async sendJournalSummary() {
    try { this.#emit("journal:summary", await this.service.unresolvedJournalSummary()); }
    catch (error) { this.#emit("document:journal-warning",
      `Unresolved journals could not be inspected: ${error.message}`); }
  }

  #makeService() {
    let created;
    created = this.serviceFactory({
      onLockStart: ({ reason }) => {
        const staged = this.replacements?.hasStagedCandidate(created)
          && AUTOMATIC_LOCK_REASONS.includes(reason);
        if (reason !== "document-close" && (created === this.service || staged)) {
          this.#beginServiceLock(created);
        }
      },
      onLocked: (result) => {
        if (result.reason === "document-close") {
          this.lockStartedServices.delete(created);
          return;
        }
        void this.secureLocks?.serviceLocked(created, result).catch((error) =>
          this.#emit("document:journal-warning",
            `Secure lock cleanup needs attention: ${error.message}`)).finally(() => {
          this.lockStartedServices.delete(created);
        });
      },
      onJournalWarning: (warning) => {
        if (created === this.service) this.#emit("document:journal-warning", warning);
      },
      onRegularSave: (result) => {
        if (created === this.service) this.#emit("document:regular-saved", result);
      },
    });
    return created;
  }

  #beginServiceLock(created) {
    if (!created.active || this.lockStartedServices.has(created)) return false;
    this.lockStartedServices.add(created);
    if (!this.rendererLockStarted) {
      this.rendererLockStarted = true; this.generation.invalidate();
      this.protections?.cancelForLock(); this.leaseTakeovers.clear();
      this.#emit("document:lock-started");
      void this.externalLifecycle?.cancelForLock().catch((error) =>
        this.#emit("document:journal-warning",
          `External open cancellation needs attention: ${error.message}`));
    }
    return true;
  }

  #adopt(staged, target) {
    this.leaseTakeovers.clear(); const previous = this.service;
    this.service = staged.candidate; staged.candidate.acceptCreatedDocument?.();
    this.currentTarget = target; this.lockedTarget = target;
    if (previous !== this.service && previous.active) {
      void previous.lock("document-replaced").catch((error) =>
        this.#emit("document:journal-warning",
          `The replaced session cleanup needs attention: ${error.message}`));
    }
  }

  #emit(channel, value) { this.window.webContents.send(channel, value); }

  #register(channel, handler) { this.ipc.handle(channel, (_event, value) => handler(value)); }

  #registerHandlers() {
    this.#register("profile:get", () => this.service.loadProfile());
    this.#register("profile:save", (profile) => this.service.saveProfile(profile));
    this.#register("profile:reconcile-active", () => this.service.reconcileProfile());
    this.#register("settings:get", () => this.service.loadClientSettings());
    this.#register("settings:save", (settings) => this.service.saveClientSettings(settings));
    this.#register("journal:summary", () => this.service.unresolvedJournalSummary());
    this.#register("document:choose-create-target", () => this.creation.chooseTarget(
      () => this.picker.chooseCreateTarget()));
    this.#register("document:cancel-create-target", () => this.creation.cancel());
    this.#register("document:create", (request) => this.creation.create(request,
      async (target, validated) => ({ created: true,
        opened: await this.replacements.create(target, validated),
        name: this.basename(target) })));
    this.#register("document:choose-open-target", async () => {
      this.selectedOpenTarget = await this.picker.chooseOpenTarget();
      return this.selectedOpenTarget
        ? Object.freeze({ selected: true, name: this.basename(this.selectedOpenTarget) }) : null;
    });
    this.#register("document:cancel-open-target", () => { this.selectedOpenTarget = null; });
    this.#register("document:open-selected", (password) => this.#openSelected(password));
    this.#register("document:unlock", (password) => this.#unlock(password));
    this.#register("document:open-external", (request) => this.#openExternal(request));
    this.#register("document:cancel-external-open", (request) => {
      if (!request || typeof request.token !== "string") {
        throw new TypeError("invalid external open cancellation");
      }
      return this.externalLifecycle.cancel(request.token,
        { blocked: this.externalOpenInProgress });
    });
    this.#register("document:enter-edit-mode", (request = {}) => {
      const current = this.service;
      return runLeaseOperation({ authorizations: this.leaseTakeovers, operation: "edit",
        service: current, authorization: request.authorization,
        perform: (takeoverToken) => current.enterEditMode({ takeoverToken }) });
    });
    this.#register("document:update-working-copy", (working) =>
      this.service.updateWorkingCopy(working));
    this.#register("document:activity", () => this.service.notifyActivity());
    this.#register("document:save", async (content) => {
      let result;
      try { result = await this.service.saveDocument(content); }
      catch (error) {
        if (!error?.publicationPrepared || !this.service.active?.opened) throw error;
        result = { saved: true, content,
          publicationState: this.service.active.opened.publicationState };
      }
      await this.sendJournalSummary(); return result;
    });
    this.#register("document:reconnect-publication", async () => {
      const result = await this.service.reconnectPendingPublication();
      await this.sendJournalSummary(); return result;
    });
    this.#register("document:begin-divergence-resolution", (request = {}) => {
      const current = this.service;
      return runLeaseOperation({ authorizations: this.leaseTakeovers, operation: "divergence",
        service: current, authorization: request.authorization,
        perform: (takeoverToken) => current.beginDivergenceResolution({ takeoverToken }) });
    });
    this.#register("document:save-divergence-resolution", async (content) => {
      const result = await this.service.saveDivergenceResolution(content);
      await this.sendJournalSummary(); return result;
    });
    this.#register("document:discard-publication", async () => {
      const result = await this.service.discardPendingPublication();
      await this.sendJournalSummary(); return result;
    });
    this.#register("document:restore-recovery", async (request = {}) => {
      const current = this.service;
      const result = await runLeaseOperation({ authorizations: this.leaseTakeovers,
        operation: "recovery", service: current, authorization: request.authorization,
        perform: (takeoverToken) => current.restoreRecoveredWork({ takeoverToken }) });
      await this.sendJournalSummary(); return result;
    });
    this.#register("document:discard-recovery", async () => {
      const result = await this.service.discardRecoveredWork();
      await this.sendJournalSummary(); return result;
    });
    this.#register("document:accept-head-mismatch", () => this.service.acceptHeadMismatch());
    this.#register("document:cancel-lease-takeover", (authorization) =>
      this.leaseTakeovers.cancel(authorization, this.service));
    this.#register("document:claim-invitation", (password) => this.#claim(password));
    this.#register("document:cancel-invitation-claim", async () => {
      const canceled = await this.replacements.cancelClaim();
      if (canceled && this.externalLifecycle.invitation) {
        await this.externalLifecycle.finishInvitation("canceled", "claim-canceled");
      }
      return canceled;
    });
    this.#register("document:lock", () => this.lockActive("app-lock"));
    this.#register("document:resolve-protection", (request) => this.protections.decide(request));
    this.#register("document:close", () => this.closeDocument());
    this.#register("application:exit", () => this.lifecycle.requestExit());
  }

  async #openSelected(password) {
    if (!this.selectedOpenTarget) throw new Error("Choose a document first");
    const target = this.selectedOpenTarget;
    return this.openRequests.run(async () => {
      const opened = await this.replacements.open(target, password);
      this.selectedOpenTarget = null; await this.sendJournalSummary();
      return { ...opened, targetName: this.basename(target) };
    });
  }

  async #unlock(password) {
    if (!this.lockedTarget) throw new Error("No locked document is available");
    const opened = await this.replacements.open(this.lockedTarget, password);
    await this.sendJournalSummary();
    return { ...opened, targetName: this.basename(this.lockedTarget) };
  }

  async #openExternal(request) {
    if (!request || typeof request.token !== "string" || typeof request.password !== "string"
        || !this.externalRequests.current(request.token) || this.externalOpenInProgress) {
      throw new TypeError("invalid external open request");
    }
    const pending = this.externalRequests.current(request.token);
    this.externalOpenInProgress = true;
    try {
      if (this.completeExternalWithoutOpen) {
        await this.externalLifecycle.finish(pending, "canceled", "renderer-canceled");
        return null;
      }
      let opened;
      try { opened = await this.openRequests.run(() => this.replacements.open(
        pending.target, request.password, "external-open")); }
      catch (error) {
        if (error?.code === "DOCUMENT_REPLACEMENT_CANCELED") opened = null;
        else throw error;
      }
      if (opened?.invitationRequired) {
        this.externalLifecycle.stageInvitation(pending);
        return { ...opened, targetName: this.basename(pending.target) };
      }
      await this.externalLifecycle.finish(pending, opened ? "opened" : "canceled",
        opened ? "opened" : "canceled");
      await this.sendJournalSummary();
      return opened ? { ...opened, targetName: this.basename(pending.target) } : null;
    } finally {
      this.externalOpenInProgress = false; void this.drainExternalRequests();
    }
  }

  async #claim(password) {
    let opened;
    try { opened = await this.replacements.claim(password); }
    catch (error) {
      if (this.externalLifecycle.invitation
          && error?.code === "DOCUMENT_REPLACEMENT_CANCELED") {
        await this.replacements.cancelClaim();
        await this.externalLifecycle.finishInvitation("canceled", "claim-canceled");
      }
      throw error;
    }
    if (this.externalLifecycle.invitation) {
      await this.externalLifecycle.finishInvitation("opened", "claim-opened");
    }
    await this.sendJournalSummary();
    return { ...opened, targetName: this.basename(this.currentTarget) };
  }
}
