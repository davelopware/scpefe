import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// @ts-expect-error The JavaScript host has no generated declaration file.
import { DocumentService } from "../src/document-service.mjs";

interface Slot {
  slotId: string;
  role: number;
  canEdit: boolean;
  canAddPasswords: boolean;
  mustBeChanged: boolean;
  identityName: string;
}

interface ContainerContext {
  create(request: object): Buffer;
  open(bytes: Buffer): Buffer;
  unlock(password: string): true;
  lock(): true;
  close(): true;
  bytes(): Buffer;
  read(): { content: string };
  slots(): Slot[];
  status(): { locked: boolean; canEdit: boolean;
    canAddPasswords: boolean; mustChangePassword: boolean };
  prepareSlotChange(kind: string, password: string, input: object):
    { bytes: Buffer; operationId: number; effects: number };
  finishSave(operationId: number, outcome: string): number;
  resolveSave(operationId: number, published: boolean): number;
}

interface NativeAddon {
  createDocument(request: object): Buffer;
  assessPasswordPolicy(password: string): string;
  createContainerContext(): ContainerContext;
  inspectDocument(bytes: Buffer, password: string): {
    content: string; documentId: string; baseRevision: string;
    invitationRequired?: boolean; mustBeChanged: boolean;
    canEdit: boolean; recoverySlot: boolean; managedSlots: Slot[];
    journalKey: Buffer;
  };
}

const addonPath = process.env.SCPEFE_NATIVE_ADDON_PATH;
const native = addonPath
  ? createRequire(import.meta.url)(addonPath) as NativeAddon : null;

const owner = "owner passphrase with independent words";
const recovery = "recovery passphrase with different words";
const temporary = "temporary passphrase for invited colleague";
const claimed = "claimed passphrase with private words";
const rotated = "rotated passphrase with distinct words";

function input(operationId: number, extra: object = {}) {
  return { operationId, clientName: "Ada", clientEmail: "ada@example.test",
    deviceName: "Ada PC", timestampMs: operationId + 100, ...extra };
}

test("revised-v3 native slot bridge owns exact candidates and projects each role", {
  skip: !native && "native addon path was not supplied",
}, () => {
  assert.ok(native);
  const context = native.createContainerContext();
  const created = context.create({ name: "Ada", email: "ada@example.test",
    deviceName: "Ada PC", content: "shared words", ownerPassword: owner,
    recoveryPassword: recovery, timestampMs: 1 });
  const first = native.inspectDocument(created, owner);
  assert.equal(first.content, "shared words");
  assert.equal(first.canEdit, true);
  assert.equal(first.recoverySlot, false);
  assert.equal(first.journalKey.length, 32);
  assert.equal(context.slots().length, 2);

  const invitation = context.prepareSlotChange("invitation", owner,
    input(1, { newPassword: temporary, name: "Guest", canEdit: false }));
  assert.notDeepEqual(context.bytes(), invitation.bytes);
  assert.equal(native.inspectDocument(invitation.bytes, temporary).mustBeChanged, true);
  assert.throws(() => context.prepareSlotChange("invitation", owner,
    input(2, { newPassword: temporary, name: "Other" })),
  (error: any) => error.status === 14);
  context.finishSave(invitation.operationId, "verified");
  assert.deepEqual(context.bytes(), invitation.bytes);
  const guest = context.slots().find((slot) => slot.role === 1);
  assert.ok(guest);
  assert.equal(guest.mustBeChanged, true);
  assert.equal(guest.canEdit, false);

  context.lock();
  context.unlock(temporary);
  assert.equal(context.status().mustChangePassword, true);
  assert.throws(() => context.read(), (error: any) => error.status === 19);
  assert.throws(() => context.slots(), (error: any) => error.status === 19);
  const claim = context.prepareSlotChange("claim", temporary,
    input(2, { newPassword: claimed, name: "Grace",
      email: "grace@example.test" }));
  context.finishSave(claim.operationId, "ambiguous");
  assert.notDeepEqual(context.bytes(), claim.bytes);
  context.resolveSave(claim.operationId, true);
  assert.deepEqual(context.bytes(), claim.bytes);
  assert.throws(() => context.prepareSlotChange("password", temporary,
    input(3, { newPassword: rotated })), (error: any) => error.status === 10);
  assert.equal(native.inspectDocument(claim.bytes, claimed).content, "shared words");

  context.lock();
  context.unlock(claimed);
  const view = context.status();
  assert.equal(view.canEdit, false);
  assert.equal(view.canAddPasswords, false);
  assert.equal(context.slots().length, 1);
  assert.throws(() => context.prepareSlotChange("invitation", claimed,
    input(3, { newPassword: rotated, name: "Denied" })),
  (error: any) => error.status === 1);
  const ownChange = context.prepareSlotChange("password", claimed,
    input(3, { newPassword: rotated }));
  context.finishSave(ownChange.operationId, "verified");
  assert.equal(native.inspectDocument(ownChange.bytes, rotated).canEdit, false);

  context.lock();
  context.unlock(recovery);
  const recovered = native.inspectDocument(context.bytes(), recovery);
  assert.equal(recovered.recoverySlot, true);
  assert.equal(recovered.managedSlots.length, 1);
  const permissions = context.prepareSlotChange("permissions", recovery,
    input(4, { slotId: guest.slotId, canEdit: true }));
  context.finishSave(permissions.operationId, "verified");
  assert.equal(context.slots().find((slot) => slot.slotId === guest.slotId)?.canEdit, true);
  const removed = context.prepareSlotChange("remove", recovery,
    input(5, { slotId: guest.slotId }));
  context.finishSave(removed.operationId, "verified");
  assert.equal(context.slots().some((slot) => slot.slotId === guest.slotId), false);
  context.close();
});

test("Windows publishes a revised-v3 password candidate and claims an invitation", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  assert.ok(native);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-slot-bridge-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profilePath = path.join(directory, "profile.json");
  const target = path.join(directory, "document.scpefe");
  await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
    email: "ada@example.test", deviceName: "Ada PC" }));
  const source = native.createContainerContext();
  const created = source.create({ name: "Ada", email: "ada@example.test",
    deviceName: "Ada PC", content: "private words", ownerPassword: owner,
    timestampMs: 1 });
  await fs.writeFile(target, created);
  source.close();
  const service = new DocumentService({ native, fs, profilePath,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" } });
  const opened = await service.openDocument(target, owner);
  assert.equal(opened.canEdit, true);
  await assert.rejects(service.changePassword({ currentPassword: "wrong",
    newPassword: rotated }), /Current password/);
  const changed = await service.changePassword({ currentPassword: owner,
    newPassword: rotated });
  assert.equal(changed.content, "private words");
  assert.notEqual(service.active.baseRevision,
    native.inspectDocument(created, owner).baseRevision);
  assert.equal(native.inspectDocument(await fs.readFile(target), rotated).content,
    "private words");
  service.closeContainer();

  const invitationSource = native.createContainerContext();
  invitationSource.open(await fs.readFile(target));
  invitationSource.unlock(rotated);
  const invitation = invitationSource.prepareSlotChange("invitation", rotated,
    input(1, { newPassword: temporary, name: "Guest", canEdit: false }));
  invitationSource.finishSave(invitation.operationId, "verified");
  await fs.writeFile(target, invitationSource.bytes());
  invitationSource.close();
  await fs.writeFile(profilePath, JSON.stringify({ name: "Grace",
    email: "grace@example.test", deviceName: "Grace PC" }));
  const claimant = new DocumentService({ native, fs, profilePath,
    journalDirectory: path.join(directory, "claim-journals"),
    witnessDirectory: path.join(directory, "claim-witnesses"),
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" } });
  const staged = await claimant.openDocument(target, temporary);
  assert.equal(staged.invitationRequired, true);
  const claimedView = await claimant.claimInvitation(claimed);
  assert.equal(claimedView.canEdit, false);
  assert.equal(claimedView.content, "private words");
  assert.equal(native.inspectDocument(await fs.readFile(target), claimed).content,
    "private words");
  claimant.closeContainer();
});

test("Windows-created containers administer slots through the native candidate bridge", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  assert.ok(native);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scpefe-legacy-slots-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profilePath = path.join(directory, "profile.json");
  const target = path.join(directory, "document.scpefe");
  await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
    email: "ada@example.test", deviceName: "Ada PC" }));
  const service = new DocumentService({ native, fs, profilePath,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" } });
  await service.createDocument(target, { ownerPassword: owner,
    content: "private words", understandsIrrecoverable: true });
  await service.openDocument(target, owner);
  const changed = await service.changePassword({ currentPassword: owner,
    newPassword: rotated });
  assert.equal(changed.canAddPasswords, true);
  assert.deepEqual(service.container.bytes(), await fs.readFile(target));
  await service.enterEditMode();
  const invited = await service.createInvitation({ temporaryPassword: temporary,
    temporaryLabel: "Guest", canEdit: false });
  assert.equal(invited.created, true);
  const guest = invited.opened.managedSlots.find(
    (slot: Slot) => slot.identityName === "Guest");
  assert.ok(guest);
  assert.equal(guest.canEdit, false);
  assert.deepEqual(service.container.bytes(), await fs.readFile(target));
  await service.exitEditMode();
  await service.lock("app-lock");
  await fs.writeFile(profilePath, JSON.stringify({ name: "Grace",
    email: "grace@example.test", deviceName: "Grace PC" }));
  const claimant = new DocumentService({ native, fs, profilePath,
    journalDirectory: path.join(directory, "guest-journals"),
    witnessDirectory: path.join(directory, "guest-witnesses"),
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" } });
  assert.equal((await claimant.openDocument(target, temporary)).invitationRequired, true);
  const guestOpened = await claimant.claimInvitation(claimed);
  assert.equal(guestOpened.canEdit, false);
  claimant.closeContainer();
  await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
    email: "ada@example.test", deviceName: "Ada PC" }));
  await service.openDocument(target, rotated);
  await service.enterEditMode();
  const updated = await service.updateSlotPermissions({ slotId: guest.slotId,
    canEdit: true });
  assert.equal(updated.managedSlots.find((slot: Slot) => slot.slotId === guest.slotId)
    ?.canEdit, true);
  const removed = await service.removeSlot(guest.slotId);
  assert.equal(removed.removed, true);
  assert.equal(removed.opened.managedSlots.length, 0);
  assert.deepEqual(service.container.bytes(), await fs.readFile(target));
  await service.exitEditMode();
  await service.lock("app-lock");
  await fs.writeFile(profilePath, JSON.stringify({ name: "Ada Changed",
    email: "ada@example.test", deviceName: "Ada PC" }));
  const mismatched = await service.openDocument(target, rotated);
  assert.ok(mismatched.profileMismatch);
  const reconciled = await service.reconcileIdentity();
  assert.equal(reconciled.slotIdentityName, "Ada Changed");
  service.closeContainer();
});

test("password-slot publications retain exact candidates across interrupted workflows", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  assert.ok(native);
  const cases = [
    { kind: "password", stage: "prepared" },
    { kind: "invitation", stage: "replaced" },
    { kind: "claim", stage: "replaced" },
    { kind: "identity", stage: "prepared" },
    { kind: "permissions", stage: "prepared" },
    { kind: "remove", stage: "replaced" },
  ] as const;
  for (const { kind, stage } of cases) {
    await t.test(`${kind} after journal stage ${stage}`, async (t) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(),
        `scpefe-slot-${kind}-interrupted-`));
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      const profilePath = path.join(directory, "profile.json");
      const target = path.join(directory, "document.scpefe");
      const writeProfile = (name: string) => fs.writeFile(profilePath,
        JSON.stringify({ name, email: `${name.toLowerCase().replaceAll(" ", "-")}@example.test`,
          deviceName: "Test PC" }));
      await writeProfile("Ada");
      const createService = (suffix: string) => new DocumentService({ native, fs,
        profilePath, journalDirectory: path.join(directory, `journals-${suffix}`),
        witnessDirectory: path.join(directory, `witnesses-${suffix}`),
        publicationCapabilities: { sameFilesystemTransaction: true,
          replacementGuarantee: "atomic-replace" } });
      const ownerService = createService("owner");
      await ownerService.createDocument(target, { ownerPassword: owner,
        content: "protected words", understandsIrrecoverable: true });
      await ownerService.openDocument(target, owner);

      let service = ownerService;
      let operation: () => Promise<unknown>;
      let reopenPassword = owner;
      if (["invitation", "claim", "permissions", "remove"].includes(kind)) {
        await ownerService.enterEditMode();
      }
      if (["claim", "permissions", "remove"].includes(kind)) {
        const invited = await ownerService.createInvitation({
          temporaryPassword: temporary, temporaryLabel: "Guest", canEdit: false });
        const slot = invited.opened.managedSlots.find(
          (entry: Slot) => entry.identityName === "Guest");
        assert.ok(slot);
        if (kind === "claim") {
          await ownerService.exitEditMode();
          ownerService.closeContainer();
          await writeProfile("Grace");
          service = createService("claimant");
          assert.equal((await service.openDocument(target, temporary))
            .invitationRequired, true);
          reopenPassword = claimed;
          operation = () => service.claimInvitation(claimed);
        } else if (kind === "permissions") {
          await ownerService.exitEditMode();
          await ownerService.lock("app-lock");
          await writeProfile("Grace");
          const claimant = createService("claimant");
          await claimant.openDocument(target, temporary);
          await claimant.claimInvitation(claimed);
          claimant.closeContainer();
          await writeProfile("Ada");
          await ownerService.openDocument(target, owner);
          await ownerService.enterEditMode();
          operation = () => service.updateSlotPermissions({
            slotId: slot.slotId, canEdit: true });
        } else {
          operation = () => service.removeSlot(slot.slotId);
        }
      } else if (kind === "password") {
        reopenPassword = rotated;
        operation = () => service.changePassword({ currentPassword: owner,
          newPassword: rotated });
      } else if (kind === "invitation") {
        operation = () => service.createInvitation({ temporaryPassword: temporary,
          temporaryLabel: "Second guest", canEdit: false });
      } else {
        await ownerService.lock("app-lock");
        await writeProfile("Ada Changed");
        assert.ok((await ownerService.openDocument(target, owner)).profileMismatch);
        operation = () => service.reconcileIdentity();
      }

      const before = await fs.readFile(target);
      const beforeHead = service.active.baseRevision;
      const write = service.journals.write.bind(service.journals);
      const expectedPurpose = kind === "password" ? "password-change"
        : kind === "claim" ? "invitation-claim"
          : kind === "identity" ? "identity-reconciliation"
            : "slot-administration";
      const expectedEvent = { password: "password-changed",
        invitation: "invitation-created", claim: "invitation-claimed",
        identity: "identity-reconciled", permissions: "permissions-updated",
        remove: "slot-removed" }[kind];
      let interrupted = false;
      let retainedCandidate: Buffer | null = null;
      service.journals.write = async (...args: any[]) => {
        await write(...args);
        if (!interrupted && args[2]?.publication?.stage === stage
            && args[2].publication.purpose === expectedPurpose) {
          interrupted = true;
          retainedCandidate = Buffer.from(args[2].publication.candidate, "base64");
          assert.deepEqual(service.container.bytes(), before,
            "the native container must not adopt an unverified candidate");
          assert.deepEqual(await fs.readFile(target),
            stage === "prepared" ? before : retainedCandidate);
          if (kind === "permissions") {
            assert.equal(native.inspectDocument(await fs.readFile(target),
              claimed).canEdit, false,
            "an unpublished permission candidate must grant no new access");
          }
          throw new Error("simulated slot publication interruption");
        }
      };

      if (kind === "claim") {
        await assert.rejects(operation(), /simulated slot publication interruption/);
        assert.equal(service.pendingNativeCandidate !== null, true);
        const pending = await service.journals.read(service.active.documentId,
          service.active.journalKey);
        assert.equal(pending.publication.purpose, "invitation-claim");
        assert.equal(pending.publication.reopenPassword, claimed);
        assert.deepEqual(Buffer.from(pending.publication.candidate, "base64"),
          retainedCandidate);
        const restarted = createService("claimant");
        const opened = await restarted.openDocument(target, temporary);
        assert.equal(opened.invitationRequired, undefined);
        assert.equal(opened.content, "protected words");
        assert.equal(restarted.active.password, claimed);
        assert.equal(restarted.revisionActivityPage(0, 1).items[0].eventType,
          expectedEvent);
        assert.equal(await restarted.journals.read(restarted.active.documentId,
          restarted.active.journalKey), null);
        restarted.closeContainer();
      } else {
        const result = await operation();
        assert.ok(result);
        assert.equal(service.pendingNativeCandidate, null);
        assert.deepEqual(service.container.bytes(), await fs.readFile(target));
        assert.notEqual(service.active.baseRevision, beforeHead);
        assert.equal(await service.journals.read(service.active.documentId,
          service.active.journalKey), null);
        assert.equal(native.inspectDocument(await fs.readFile(target),
          reopenPassword).content, "protected words");
        assert.equal(service.revisionActivityPage(0, 1).items[0].eventType,
          expectedEvent);
      }
      assert.equal(interrupted, true);
      assert.ok(retainedCandidate);
      assert.notDeepEqual(before, retainedCandidate);
      service.closeContainer();
    });
  }
});

test("slot publication releases a definitely failed native candidate for retry", {
  skip: !native && "native addon path was not supplied",
}, async (t) => {
  assert.ok(native);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),
    "scpefe-slot-definite-failure-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "document.scpefe");
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(profilePath, JSON.stringify({ name: "Ada",
    email: "ada@example.test", deviceName: "Test PC" }));
  const service = new DocumentService({ native, fs, profilePath,
    journalDirectory: path.join(directory, "journals"),
    witnessDirectory: path.join(directory, "witnesses"),
    publicationCapabilities: { sameFilesystemTransaction: true,
      replacementGuarantee: "atomic-replace" } });
  await service.createDocument(target, { ownerPassword: owner,
    content: "protected words", understandsIrrecoverable: true });
  await service.openDocument(target, owner);
  const before = await fs.readFile(target);
  const originalWrite = service.journals.write.bind(service.journals);
  let rejected = false;
  service.journals.write = async (...args: any[]) => {
    if (!rejected && args[2]?.publication?.purpose === "password-change") {
      rejected = true;
      throw new Error("journal write failed before persistence");
    }
    return originalWrite(...args);
  };
  const request = { currentPassword: owner, newPassword: rotated };
  await assert.rejects(service.changePassword(request),
    /journal write failed before persistence/);
  assert.equal(rejected, true);
  assert.equal(service.pendingNativeCandidate, null);
  assert.deepEqual(service.container.bytes(), before);
  assert.deepEqual(await fs.readFile(target), before);
  assert.equal(await service.journals.read(service.active.documentId,
    service.active.journalKey), null);
  const changed = await service.changePassword(request);
  assert.equal(changed.content, "protected words");
  assert.deepEqual(service.container.bytes(), await fs.readFile(target));
  service.closeContainer();
});
