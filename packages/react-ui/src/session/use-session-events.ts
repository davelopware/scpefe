import { useEffect, type RefObject } from "react";
import type { DocumentSession, DocumentSessionSnapshot, SnapshotSource } from "@scpefe/frontend-core";
import { useSessionSnapshot } from "../use-session-snapshot.ts";
import type { ShellHost } from "../shell/shell-dialogs.tsx";
import type { SessionEventsHost } from "./host-roles.ts";
import type { DocumentOpened, Opened } from "./types.ts";
import type { SessionPresentation } from "./session-presentation.ts";

type FullSession = DocumentSession<DocumentOpened,
  Extract<Opened, { invitationRequired: true }>>;
type EventSession = SnapshotSource<DocumentSessionSnapshot<DocumentOpened>>
  & Pick<FullSession, "getSnapshot" | "observeRecoveryDiscovery"
    | "regularSavePublished" | "queueExternalOpen"
    | "stageProtection">;
type LockResult = { locked: true; journalSaved: boolean; warningCode: string | null };

/** Subscribes native lifecycle events and forwards only semantic presentation effects. */
export function useSessionEvents({ session, presentation, events, shellHost, completion,
  forwardJournalWarning, catalogText, safeRendererErrorMessage, modalBusy,
  returnFocus, canPresentQueued, onLocked, onRetained, onPresentExternal,
  onMessage }: {
  session: EventSession;
  presentation: Pick<SessionPresentation, "activateQueuedExternalOpen">;
  events: SessionEventsHost;
  shellHost: Pick<ShellHost, "getUnresolvedJournalSummary">;
  completion: { track<T>(operation: () => T | Promise<T>): Promise<T> };
  forwardJournalWarning(code: string, scope: string | null): void;
  catalogText(code: string): string;
  safeRendererErrorMessage(error: unknown): string;
  modalBusy: RefObject<boolean>;
  returnFocus: RefObject<HTMLElement | null>;
  canPresentQueued: boolean;
  onLocked(result: LockResult, closed?: boolean): void;
  onRetained(document: DocumentOpened): void;
  onPresentExternal(): void;
  onMessage(message: string): void;
}): void {
  const snapshot = useSessionSnapshot(session);
  const externalOpen = snapshot.externalOpen;
  useEffect(() => {
    void completion.track(() => shellHost.getUnresolvedJournalSummary()
      .then((summary) => { session.observeRecoveryDiscovery(summary); })
      .catch((error: unknown) => onMessage(safeRendererErrorMessage(error))));
  }, []);
  useEffect(() => {
    const stopLockStarted = events.onLockStarted?.(() => onLocked({
      locked: true, journalSaved: true, warningCode: null,
    })) ?? (() => {});
    const stopLocked = events.onLocked(onLocked);
    const stopWarning = events.onJournalWarning((code, scope) => {
      forwardJournalWarning(code, scope);
      onMessage(catalogText(code));
    });
    const stopRegularSave = events.onRegularSave((result) => {
      if (session.regularSavePublished(result)) {
        onMessage("Regular save published provisionally; changes remain unsaved until manual save.");
      }
    });
    const stopExternalOpen = events.onExternalOpenRequested((request) => {
      if (!session.queueExternalOpen(request)) return;
      const current = session.getSnapshot();
      if (modalBusy.current || (current.kind === "read-only" || current.kind === "edit")
        && current.publication.resolving) {
        onMessage("Another open request is waiting for the current dialog.");
      }
    });
    const stopJournalSummary = events.onUnresolvedJournalSummary(
      (summary) => { session.observeRecoveryDiscovery(summary); });
    const stopSwitchRetained = events.onSwitchRetained((result) => {
      onRetained(result);
      onMessage("The current document remains open with its manual save pending publication.");
    });
    const stopProtection = events.onProtectionRequested?.((request) => {
      returnFocus.current = document.activeElement as HTMLElement | null;
      session.stageProtection(request);
    }) ?? (() => {});
    const stopClosed = events.onDocumentClosed?.(() => {
      onLocked({ locked: true, journalSaved: true, warningCode: null }, true);
    }) ?? (() => {});
    const activity = () => { void events.activity(); };
    window.addEventListener("keydown", activity);
    window.addEventListener("pointerdown", activity);
    return () => {
      stopLockStarted(); stopLocked(); stopWarning(); stopRegularSave(); stopExternalOpen();
      stopJournalSummary(); stopSwitchRetained(); stopProtection(); stopClosed();
      window.removeEventListener("keydown", activity);
      window.removeEventListener("pointerdown", activity);
    };
  }, []);
  useEffect(() => {
    if (canPresentQueued && !externalOpen?.active && externalOpen?.queued) {
      if (presentation.activateQueuedExternalOpen()) {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body
          && active.isConnected) returnFocus.current = active;
        onPresentExternal();
      }
    }
  }, [canPresentQueued, externalOpen?.active, externalOpen?.queued, presentation]);
}
