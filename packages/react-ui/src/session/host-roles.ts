import type { DocumentSessionHost, WorkingCopyUpdate } from "@scpefe/frontend-core";
import type { DocumentOpened, ExternalOpenRequest, JournalSummary,
  Opened, ProtectionRequest } from "./types.ts";

type Invitation = Extract<Opened, { invitationRequired: true }>;

/** Portable document commands consumed only by DocumentSession. */
export type SessionHost = DocumentSessionHost<DocumentOpened, Invitation>;

/** Renderer transport for one scheduled recovery-journal update. */
export interface JournalTransportHost {
  updateWorkingCopy(update: WorkingCopyUpdate): Promise<unknown>;
}

/** Native lifecycle notifications consumed by the session presentation bridge. */
export interface SessionEventsHost {
  activity(): Promise<unknown>;
  onLockStarted?(listener: () => void): () => void;
  onLocked(listener: (result: { locked: true; journalSaved: boolean;
    warningCode: string | null }) => void): () => void;
  onJournalWarning(listener: (code: string, journalScope: string | null) => void): () => void;
  onRegularSave(listener: (result: { published: true; provisional: true;
    content: string; journalScope: string; revision: number }) => void): () => void;
  onExternalOpenRequested(listener: (request: ExternalOpenRequest) => void): () => void;
  onUnresolvedJournalSummary(listener: (summary: JournalSummary) => void): () => void;
  onSwitchRetained(listener: (opened: DocumentOpened) => void): () => void;
  onProtectionRequested?(listener: (request: ProtectionRequest) => void): () => void;
  onDocumentClosed?(listener: () => void): () => void;
}

/** Native clipboard capability used only by one-time invitation presentation. */
export interface SecurityClipboardHost {
  copyInvitationPassphrase(password: string): Promise<boolean>;
}
