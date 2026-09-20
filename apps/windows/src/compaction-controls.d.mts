import type { ReactElement } from "react";

export function compactionAvailable(opened: {
  readOnly: boolean;
  canAddPasswords?: boolean;
  canRemovePasswords?: boolean;
} | null | undefined): boolean;

export function CompactionControls(props: {
  onCompact(): Promise<void>;
}): ReactElement;
