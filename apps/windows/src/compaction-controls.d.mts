import type { ReactElement } from "react";

export function compactionAvailable(opened: {
  readOnly: boolean;
  canAddPasswords?: boolean;
  canRemovePasswords?: boolean;
} | null | undefined): boolean;

export function CompactionConfirmation(props: {
  open: boolean;
  onCancel(): void;
  onConfirm(): void;
}): ReactElement | null;

export function CompactionControls(props: {
  onCompact(): Promise<void>;
}): ReactElement;
