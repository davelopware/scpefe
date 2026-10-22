export type CsvParseResult = { valid: true; rows: string[][] } | {
  valid: false; message: string; offset: number; line: number; column: number };
export function parseCsvSource(source: string): CsvParseResult;
export function writeCsvSource(rows: string[][]): string;
export function requireValidCsvSource(source: string): string;
export function serializeCsvSource(source: string): string;
