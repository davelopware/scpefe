import React, { useState } from "react";
import type { SessionCommands } from "@scpefe/frontend-core";
import type { DocumentOpened, ManagedSlot } from "../session/types.ts";

function ManagedSlotControls({ slot, canUpdate, canRemove, onUpdate, onRemove }: {
  slot: ManagedSlot; canUpdate: boolean; canRemove: boolean;
  onUpdate(slot: ManagedSlot, canEdit: boolean, canAddPasswords: boolean,
    canRemovePasswords: boolean): Promise<void>;
  onRemove(slot: ManagedSlot): Promise<void>;
}) {
  const [canEdit, setCanEdit] = useState(slot.canEdit);
  const [canAddPasswords, setCanAddPasswords] = useState(slot.canAddPasswords);
  const [canRemovePasswords, setCanRemovePasswords] = useState(slot.canRemovePasswords);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const label = slot.identityKnown === false
    ? slot.identityName : `${slot.identityName} · ${slot.identityEmail}`;
  const updateEdit = (enabled: boolean) => {
    setCanEdit(enabled);
    if (!enabled) { setCanAddPasswords(false); setCanRemovePasswords(false); }
  };
  const updateAdministration = (kind: "add" | "remove", enabled: boolean) => {
    if (enabled) setCanEdit(true);
    if (kind === "add") setCanAddPasswords(enabled);
    else setCanRemovePasswords(enabled);
  };
  return <li className="managed-slot"><h4>{label}</h4>
    {slot.identityKnown === false && <p>Identity is unknown until this legacy slot authenticates and reconciles.</p>}
    {slot.permissionsKnown === false && <p>Current permissions are unknown. Saving replaces them with the choices below.</p>}
    {slot.mustBeChangedKnown === false
      ? <p>Claim state is protected by the slot password and is not yet known administratively.</p>
      : slot.mustBeChanged && <p>Invitation not yet claimed; its temporary password must be replaced.</p>}
    <form onSubmit={(event) => { event.preventDefault(); void onUpdate(slot,
      canEdit, canAddPasswords, canRemovePasswords); }}>
      <fieldset disabled={!canUpdate}><legend>Permissions for {label}</legend>
        <label className="check"><input type="checkbox" checked={canEdit}
          onChange={(event) => updateEdit(event.target.checked)} /> May edit</label>
        <label className="check"><input type="checkbox" checked={canAddPasswords}
          onChange={(event) => updateAdministration("add", event.target.checked)} /> May add passwords</label>
        <label className="check"><input type="checkbox" checked={canRemovePasswords}
          onChange={(event) => updateAdministration("remove", event.target.checked)} /> May remove passwords</label>
        <small>Password administration always implies edit permission.</small>
        <button type="submit">Publish permission changes</button>
      </fieldset>
    </form>
    {canRemove && !confirmRemoval && <button type="button"
      onClick={() => setConfirmRemoval(true)}>Remove this password slot…</button>}
    {canRemove && confirmRemoval && <div className="warning" role="alert">
      <p>Removal blocks this password only in the updated document. It cannot revoke plaintext, keys already obtained, or older replicas.</p>
      <div className="toolbar"><button type="button" onClick={() => { setConfirmRemoval(false);
        void onRemove(slot); }}>Confirm slot removal</button>
        <button type="button" onClick={() => setConfirmRemoval(false)}>Cancel</button></div>
    </div>}
  </li>;
}

export function SlotAdministration({ opened, commands, onUpdate, onRemove, onCompact, CompactionControls }: {
  opened: DocumentOpened;
  commands: Pick<SessionCommands, "updateSlotPermissions" | "removeSlot" | "compact">;
  onUpdate(slot: ManagedSlot, canEdit: boolean, canAddPasswords: boolean,
    canRemovePasswords: boolean): Promise<void>;
  onRemove(slot: ManagedSlot): Promise<void>;
  onCompact(): Promise<void>;
  CompactionControls: React.ComponentType<{ onCompact(): Promise<void> }>;
}) {
  const slots = opened.managedSlots ?? [];
  const canUpdate = commands.updateSlotPermissions;
  const canRemove = commands.removeSlot;
  return <aside className="slot-administration" aria-labelledby="slot-administration-heading">
    <h2 id="slot-administration-heading">Password-slot administration</h2>
    <p>The permanent owner remains a full administrator and cannot be demoted or removed. The recovery password is also permanent and is never listed as an ordinary slot.</p>
    {opened.readOnly && <p>Enter edit mode to publish permission changes or remove a slot.</p>}
    {commands.compact && <CompactionControls onCompact={onCompact} />}
    <p className="warning">Removing a slot affects only this updated document and does not revoke older copies or information already obtained.</p>
    {slots.length === 0 ? <p>No ordinary invitation slots exist.</p>
      : <ul className="managed-slots">{slots.map((slot) =>
        <ManagedSlotControls key={`${slot.slotId}-${slot.canEdit}-${slot.canAddPasswords}-${slot.canRemovePasswords}`}
          slot={slot} canUpdate={canUpdate} canRemove={canRemove}
          onUpdate={onUpdate} onRemove={onRemove} />)}</ul>}
  </aside>;
}
