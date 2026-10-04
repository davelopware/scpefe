import { BIP39_ENGLISH_WORDS } from "./bip39-english.ts";

type Assessment = Readonly<{ status: string; password?: string }>;

/** Draws eight independent BIP-39 words, giving 88 bits of source entropy. */
export function randomPassphrase(): string {
  const indices = new Uint16Array(8);
  globalThis.crypto.getRandomValues(indices);
  return Array.from(indices, (index) => BIP39_ENGLISH_WORDS[index & 2047]).join(" ");
}

/** Finds a fresh candidate accepted by the authoritative password policy. */
export async function generateAcceptedPassphrase(
  assess: (candidate: string) => Promise<Assessment>,
  excluded: readonly string[] = [],
): Promise<string> {
  for (let attempt = 0; attempt < 32; ++attempt) {
    const candidate = randomPassphrase();
    if (excluded.some((value) => value.trim() === candidate)) continue;
    const result = await assess(candidate);
    if (result.status === "accepted" && result.password === candidate) return candidate;
    if (result.status === "unavailable") break;
  }
  throw new Error("Could not generate a passphrase that meets password requirements. Try again.");
}
