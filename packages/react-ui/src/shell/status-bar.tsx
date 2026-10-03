import React from "react";
import type { DocumentSessionSnapshot, SessionDocument, SnapshotSource } from "@scpefe/frontend-core";
import { useSessionSnapshot } from "../use-session-snapshot.ts";
import type { ShellCommands } from "./shell-commands.ts";

/** Compact status projection for the current document session. */
export function StatusBar<Doc extends SessionDocument>({ session, active, message }: {
  session: SnapshotSource<DocumentSessionSnapshot<Doc>>; active: boolean; message: string;
  commands: ShellCommands<Doc>;
}): React.ReactElement {
  const snapshot = useSessionSnapshot(session);
  const opened = snapshot.kind === "read-only" || snapshot.kind === "edit"
    ? snapshot.document : null;
  const working = snapshot.kind === "read-only" || snapshot.kind === "edit"
    ? snapshot.working : null;
  const locked = snapshot.kind === "locked";
  const state = opened && "invitationRequired" in opened ? "Invitation"
    : locked ? "Locked" : !active ? "No document"
      : opened?.readOnly ? "Read-only" : "Edit mode";
  const cleanliness = !active && !locked ? "—" : working?.dirty ? "Dirty" : "Clean";
  const publicationState = snapshot.kind === "closed" ? null : snapshot.publication.state;
  const publication = !active && !locked ? "—"
    : publicationState === "pending-publication" ? "Pending publication"
      : publicationState === "conflict" ? "Publication conflict"
        : publicationState === "provisional" ? "Provisional publication" : "Published";
  const total = snapshot.discovery?.total ?? 0;
  return <footer className="status-bar" role="status" aria-live="polite" aria-atomic="true">
    <span aria-label="Document state">{state}</span>
    <span aria-label="Working copy state">{cleanliness}</span>
    {active && <span aria-label="Recovery journal state">
      {working?.journal.failed ? "Checkpoint needs attention"
        : working?.journal.pending ? "Checkpoint pending" : "Checkpoint ready"}
    </span>}
    <span aria-label="Publication state">{publication}</span>
    <span>{total > 0 ? `${total} recovery item${total === 1 ? "" : "s"} need attention. ` : ""}{message}</span>
  </footer>;
}
