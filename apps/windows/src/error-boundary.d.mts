export class SafeBoundaryError extends Error {
  readonly code: string;
  readonly nextAction: string;
}

export function safeRendererErrorMessage(error: unknown): string;
export function catalogText(code: string, operation?: string): string;
export function isCatalogCode(code: unknown): boolean;
