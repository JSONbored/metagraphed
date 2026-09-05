/** Provider key IDs are identifiers, never the raw credential. */
export function isUnkeyKeyId(value: unknown): value is string {
  return typeof value === "string" && /^key_[a-zA-Z0-9_]+$/.test(value);
}

export type ApiKeyLedgerState =
  "active" | "pending" | "revoked" | "unmanaged" | "denied";
