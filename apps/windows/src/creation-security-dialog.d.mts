import type { ReactElement } from "react";

export type CreationFormRequest = {
  ownerPassword: string;
  ownerPasswordConfirmation: string;
  recoveryPassword: string;
  recoveryPasswordConfirmation: string;
  content: "";
  understandsIrrecoverable: true;
  storedRecoverySeparately: boolean;
};

export function CreationSecurityDialog(props: {
  onCreate(request: CreationFormRequest): Promise<void>;
  onCancel(): void | Promise<void>;
  returnFocus?: HTMLElement | null;
}): ReactElement;

export function CreateDocumentControl(props: {
  onCreated(): void;
  onError(error: unknown): void;
}): ReactElement;
