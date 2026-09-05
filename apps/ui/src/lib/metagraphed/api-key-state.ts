export interface ApiKeyRow {
  key_id: string;
  tier: string;
  created_at: number;
  revoked_at: number | null;
  revocation_requested_at?: number | null;
  revocation_state?: "active" | "pending" | "revoked";
  last_used_at: number | null;
}

export function keyRevocationState(key: ApiKeyRow): "active" | "pending" | "revoked" {
  if (key.revoked_at != null || key.revocation_state === "revoked") return "revoked";
  if (key.revocation_requested_at != null || key.revocation_state === "pending") return "pending";
  return "active";
}

/** Revocation cannot be undone. A delayed list must not reverse a known outcome.
 * Previous rows come only from the query cache for the same session token.
 */
export function reconcileApiKeys(incoming: ApiKeyRow[], previous: ApiKeyRow[] = []): ApiKeyRow[] {
  const known = new Map(previous.map((key) => [key.key_id, keyRevocationState(key)]));
  const next = incoming.map((key) => {
    const before = known.get(key.key_id);
    const current = keyRevocationState(key);
    if (before === "revoked" || (before === "pending" && current === "active")) {
      return { ...key, revocation_state: before };
    }
    return key;
  });
  // An older list can predate the key itself. Keep pending evidence and hidden
  // completion records so a later stale active row cannot erase either outcome.
  const present = new Set(incoming.map((key) => key.key_id));
  return next.concat(
    previous.filter((key) => !present.has(key.key_id) && keyRevocationState(key) !== "active"),
  );
}
