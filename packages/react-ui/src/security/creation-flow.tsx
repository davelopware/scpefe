import React, { useImperativeHandle, useState } from "react";
import type { DocumentSession, DocumentSessionSnapshot, SnapshotSource } from "@scpefe/frontend-core";
import type { CreationFormRequest } from "./types.ts";
import type { DocumentOpened, Opened } from "../session/types.ts";

type FullSession = DocumentSession<DocumentOpened,
  Extract<Opened, { invitationRequired: true }>>;
type CreationSession = SnapshotSource<DocumentSessionSnapshot<DocumentOpened>>
  & Pick<FullSession, "getSnapshot" | "create">;

/** Target-picker capabilities needed by the creation form. */
export interface CreationTargetHost {
  chooseCreateTarget(): Promise<{ selected: true } | null>;
  cancelCreateTarget(): Promise<void>;
}

/** Menu and lifecycle commands for a creation flow. */
export interface CreationFlowHandle { open(): Promise<void>; reset(): void }

/** Owns target selection and creation presentation without duplicating session policy. */
export function CreationFlow({ session, targetHost, completion, Dialog,
  catalogText, safeRendererErrorMessage, onAdopted, onMessage, onFocusEditor,
  onVisibilityChange, suppressed, returnFocus, ref }: {
  session: CreationSession;
  targetHost: CreationTargetHost;
  completion: { track<T>(operation: () => T | Promise<T>): Promise<T> };
  Dialog: React.ComponentType<{ onCreate(request: CreationFormRequest): Promise<void>;
    onCancel(): void | Promise<void>; returnFocus?: HTMLElement | null }>;
  catalogText(code: string): string;
  safeRendererErrorMessage(error: unknown): string;
  onAdopted(document: DocumentOpened): void;
  onMessage(message: string): void;
  onFocusEditor(): void;
  onVisibilityChange(visible: boolean): void;
  suppressed: boolean;
  returnFocus: HTMLElement | null;
  ref?: React.Ref<CreationFlowHandle>;
}): React.ReactElement | null {
  const [creating, setCreating] = useState(false);
  function changeVisibility(visible: boolean) {
    setCreating(visible); onVisibilityChange(visible);
  }
  async function open() {
    try {
      if (await targetHost.chooseCreateTarget()) changeVisibility(true);
    } catch (error) { onMessage(safeRendererErrorMessage(error)); }
  }
  useImperativeHandle(ref, () => ({ open, reset: () => changeVisibility(false) }));
  if (!creating || suppressed) return null;
  return <Dialog returnFocus={returnFocus} onCancel={() => completion.track(async () => {
    await targetHost.cancelCreateTarget(); changeVisibility(false);
  })} onCreate={(request) => completion.track(async () => {
    const outcome = await session.create(request);
    if (outcome.status === "created") {
      const current = session.getSnapshot();
      if (current.kind !== "read-only" && current.kind !== "edit") return;
      onAdopted(current.document);
      changeVisibility(false);
      onMessage("Encrypted blank document published successfully.");
      onFocusEditor();
    } else if (outcome.status === "failed") throw new Error(catalogText(outcome.code));
  })} />;
}
