/** Validated creation form content passed to the host create capability. */
export function validateCreateFormRequest(value: unknown): {
  ownerPassword: string;
  ownerPasswordConfirmation: string;
  recoveryPassword: string;
  recoveryPasswordConfirmation: string;
  content: "" | '""';
  contentType?: "plain-text" | "csv";
  understandsIrrecoverable: true;
  storedRecoverySeparately: boolean;
};

/** Returns the validated canonical password or rejects invalid input. */
export function validatePassword(value: unknown): string;

/** Validates bounded pagination sent to the native history bridge. */
export function validateRevisionActivityRequest(offset: unknown, count: unknown): {
  offset: number; count: number };
/** Validates and copies one newest-first metadata page. */
export function validateRevisionActivityPage(value: unknown, offset?: number,
  count?: number): { items: Array<Record<string, unknown>>;
    nextOffset: number; hasMore: boolean; unavailable?: true };
/** Validates an explicit comparison availability result. */
export function validateRevisionActivityComparison(value: unknown):
  { available: true; text: string } | { available: false };
