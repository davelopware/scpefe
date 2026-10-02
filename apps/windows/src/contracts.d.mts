/** Validated creation form content passed to the host create capability. */
export function validateCreateFormRequest(value: unknown): {
  ownerPassword: string;
  ownerPasswordConfirmation: string;
  recoveryPassword: string;
  recoveryPasswordConfirmation: string;
  content: "";
  understandsIrrecoverable: true;
  storedRecoverySeparately: boolean;
};

/** Returns the validated canonical password or rejects invalid input. */
export function validatePassword(value: unknown): string;
