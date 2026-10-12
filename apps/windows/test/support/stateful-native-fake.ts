// @ts-nocheck -- preserve the legacy fixture shapes during the source-language cutover.
export function statefulFake(native) {
  if (!native || native.createContainerContext) return native;
  const generated = new Map();
  let serial = 0;
  const key = (bytes) => Buffer.from(bytes).toString("hex");
  const leaseMarker = Buffer.from("|stateful-lease:");
  const logicalSource = (bytes) => {
    const value = Buffer.from(bytes);
    const entry = generated.get(key(value));
    if (entry) return entry.source;
    const marker = value.indexOf(leaseMarker);
    return marker < 0 ? value : value.subarray(0, marker);
  };
  const syntheticBytes = (source, label) => {
    const text = Buffer.from(source).toString();
    try {
      const object = JSON.parse(text);
      if (object && typeof object === "object" && !Array.isArray(object)) {
        return Buffer.from(JSON.stringify({ ...object,
          __testPublication: `${label}:${++serial}` }));
      }
    } catch { /* Non-JSON test images retain their byte prefix. */ }
    return Buffer.concat([Buffer.from(source),
      Buffer.from(`|stateful-lease:${++serial}:${label}`)]);
  };
  const cloneOpened = (opened) => ({ ...opened,
    ...(Buffer.isBuffer(opened?.journalKey)
      ? { journalKey: Buffer.from(opened.journalKey) } : {}) });
  const inspectDocument = (bytes, password) => {
    const entry = generated.get(key(bytes));
    if (entry) return { ...cloneOpened(entry.opened),
      ...(native.currentLease ? { lease: native.currentLease() } : {}) };
    return native.openDocument(logicalSource(bytes), password);
  };
  return { ...native, inspectDocument, createContainerContext() {
    let committed = null;
    let password = null;
    let locked = true;
    let editing = false;
    let pending = null;
    const opened = () => inspectDocument(committed, password);
    const prepare = (bytes, operationId, extra = {}) => {
      pending = { bytes: Buffer.from(bytes), operationId, ...extra };
      return { bytes: Buffer.from(bytes), operationId, effects: 7 };
    };
    return {
      create(input) { committed = native.createDocument(input);
        password = null; locked = true; editing = false;
        return Buffer.from(committed); },
      open(bytes) { committed = Buffer.from(bytes); password = null;
        locked = true; editing = false; pending = null; },
      unlock(value) { inspectDocument(committed, value); password = value; locked = false; },
      lock() { locked = true; editing = false; },
      close() { committed = null; password = null; locked = true;
        editing = false; pending = null; },
      status() { return { locked }; },
      read() { const value = opened(); return { documentId: value.documentId,
        slotId: value.slotId, content: value.content }; },
      bytes() { return Buffer.from(committed); },
      authenticatedLease() { return opened().lease; },
      leaseMode() { return { editing, leaseStatus: editing ? "held" : "none" }; },
      leaseAdvice({ suspendedSessionId, suspendedCounter, nowUtcMs,
        unchangedMonotonicMs = 0 } = {}) {
        const lease = opened().lease;
        if (!lease?.active) return "acquire";
        if (nowUtcMs >= lease.holderUtcMs + lease.durationMs
            || unchangedMonotonicMs >= lease.durationMs) return "takeover";
        if (lease.sessionId === suspendedSessionId
            && lease.heartbeatCounter === suspendedCounter) return "resume";
        if (lease.sessionId === suspendedSessionId) return "changed";
        return "confirm-takeover";
      },
      prepareLeaseChange(action, actorPassword, input) {
        if (native.failLeasePreparation) throw new Error(native.failLeasePreparation);
        const prior = opened().lease ?? { active: false,
          sessionId: "0".repeat(32), heartbeatCounter: 0, holderUtcMs: 0,
          durationMs: 600_000, holderName: "", holderEmail: "", deviceName: "" };
        const next = action === "release"
          ? { ...prior, active: false, sessionId: "0".repeat(32),
            heartbeatCounter: prior.heartbeatCounter + 1 }
          : { active: true, sessionId: input.sessionId,
            heartbeatCounter: action === "acquire" || action === "takeover"
              ? 1 : prior.heartbeatCounter + 1,
            holderUtcMs: input.nowUtcMs, durationMs: input.durationMs,
            holderName: input.holderName, holderEmail: input.holderEmail,
            deviceName: input.deviceName };
        const source = Buffer.from(logicalSource(committed));
        const bytes = native.leaseEncodedInBytes
          ? native.updateLease(source, actorPassword, next)
          : syntheticBytes(committed, action);
        generated.set(key(bytes), { source,
          opened: { ...inspectDocument(committed, actorPassword), lease: next } });
        return prepare(bytes, input.operationId, { lease: next, source,
          actorPassword });
      },
      confirmEditLease() { editing = true; },
      prepareSave(kind, actorPassword, input) {
        const source = logicalSource(committed);
        const method = kind === "regular" ? "regularSaveDocument"
          : kind === "discard" ? "discardProvisional" : "saveDocument";
        return prepare(native[method](source, actorPassword, input), input.operationId);
      },
      prepareSlotChange(kind, actorPassword, input) {
        const source = logicalSource(committed);
        let bytes;
        if (kind === "password") {
          bytes = native.changePassword(source, actorPassword, input.newPassword);
        } else if (kind === "invitation") {
          bytes = native.addInvitation(source, actorPassword, {
            temporaryPassword: input.newPassword, temporaryLabel: input.name,
            canEdit: input.canEdit, canAddPasswords: input.canAddPasswords,
            canRemovePasswords: input.canRemovePasswords });
        } else if (kind === "claim") {
          bytes = native.claimInvitation(source, actorPassword, input);
        } else if (kind === "identity") {
          bytes = native.reconcileIdentity(source, actorPassword, input);
        } else {
          throw new Error(`Unsupported fake slot operation: ${kind}`);
        }
        return prepare(bytes, input.operationId);
      },
      prepareActivity(phase, _actorPassword, input) {
        const bytes = syntheticBytes(committed, `activity-${phase}`);
        const current = opened();
        generated.set(key(bytes), { source: logicalSource(committed),
          opened: { ...current } });
        return prepare(bytes, input.operationId, { activity: { phase,
          kind: input.kind, attemptHead: current.baseRevision } });
      },
      activityStatus() { return this.pendingActivity ?? { hasPending: false }; },
      completeActivity(operationId, succeeded) {
        if (this.pendingActivity?.attemptOperationId !== operationId) {
          throw new Error("stale activity attempt");
        }
        this.pendingActivity.succeeded = succeeded;
      },
      restoreActivity(record) { this.pendingActivity = { hasPending: true,
        kind: record.kind, attemptOperationId: record.attemptOperationId,
        attemptHead: record.attemptHead, succeeded: record.succeeded }; },
      assessMerge(local, localPassword, targetPassword, input) {
        native.mergeDocument(logicalSource(committed), local, targetPassword,
          { ...input, localPassword });
      },
      prepareMerge(local, targetPassword, localPassword, input) {
        return prepare(native.mergeDocument(logicalSource(committed), local,
          targetPassword, { ...input, localPassword }), input.operationId);
      },
      finishSave(operationId, outcome) {
        if (!pending || pending.operationId !== operationId) {
          throw new Error("stale native candidate");
        }
        if (outcome === "verified") {
          committed = Buffer.from(pending.bytes);
          if (pending.lease) {
            if (!native.leaseEncodedInBytes) {
              native.updateLease?.(pending.source, pending.actorPassword, pending.lease);
            }
            editing = pending.lease.active;
          }
          if (pending.activity?.phase === "attempt") {
            this.pendingActivity = { hasPending: true,
              kind: pending.activity.kind, attemptOperationId: operationId,
              attemptHead: pending.activity.attemptHead };
          } else if (pending.activity?.phase === "outcome") {
            this.pendingActivity = { hasPending: false };
          }
        }
        if (outcome !== "ambiguous") pending = null;
        return outcome === "verified" ? 8 : 0;
      },
      resolveSave(operationId, published) {
        return this.finishSave(operationId,
          published ? "verified" : "definite-failure");
      },
    };
  } };
}
