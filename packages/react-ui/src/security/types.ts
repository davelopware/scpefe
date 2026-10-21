/** Native password-policy verdict with no secret in rejected outcomes. */
export type ProposedPasswordOutcome =
  | Readonly<{ status: "empty" | "unavailable" }>
  | Readonly<{ status: "rejected"; reason: "invalid" | "minimum-length"
    | "maximum-size" | "predictable" }>
  | Readonly<{ status: "accepted"; password: string }>;

/** Security fields passed to the platform's create target command. */
export type CreationFormRequest = {
  ownerPassword: string; ownerPasswordConfirmation: string;
  recoveryPassword: string; recoveryPasswordConfirmation: string;
  content: "" | '""'; contentType?: "plain-text" | "csv";
  understandsIrrecoverable: true; storedRecoverySeparately: boolean;
};
