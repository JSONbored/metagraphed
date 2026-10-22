import { AGENT_AUTH_ASSERTION_SECONDS } from "./agent-auth-store.ts";

export const AGENT_AUTH_PRUNE_MAX_CHILDREN = 1000;
export const AGENT_AUTH_PRUNE_MAX_REGISTRATIONS = 100;

export type AgentAuthPruneResult =
  | {
      status: "pruned";
      deleted: { tokens: number; ceremonies: number; registrations: number };
    }
  | { status: "not-configured" | "invalid-time" | "unavailable" };

function deletedCount(result: unknown, limit: number): number | null {
  if (typeof result !== "object" || result === null) return null;
  const value = result as Record<string, unknown>;
  if (
    value.success !== true ||
    !Array.isArray(value.results) ||
    value.results.length > limit ||
    !value.results.every(
      (row: unknown) =>
        typeof row === "object" &&
        row !== null &&
        (row as Record<string, unknown>).deleted === 1,
    )
  )
    return null;
  return value.results.length;
}

/** Bounded, private-state retention; no credential or owner data is returned. */
export async function pruneAgentAuthState(
  db: D1Database | undefined,
  nowSeconds: number,
): Promise<AgentAuthPruneResult> {
  if (db === undefined) return { status: "not-configured" };
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0)
    return { status: "invalid-time" };
  try {
    const session =
      typeof db.withSession === "function"
        ? db.withSession("first-primary")
        : db;
    const results: unknown = await session.batch([
      session
        .prepare(
          `DELETE FROM agent_auth_tokens WHERE token_hash IN (
            SELECT token_hash FROM agent_auth_tokens WHERE expires_at<=?
            ORDER BY expires_at,token_hash LIMIT ?
          ) RETURNING 1 AS deleted`,
        )
        .bind(nowSeconds, AGENT_AUTH_PRUNE_MAX_CHILDREN),
      session
        .prepare(
          `DELETE FROM agent_auth_ceremonies WHERE state_hash IN (
            SELECT state_hash FROM agent_auth_ceremonies WHERE expires_at<=?
            ORDER BY expires_at,state_hash LIMIT ?
          ) RETURNING 1 AS deleted`,
        )
        .bind(nowSeconds, AGENT_AUTH_PRUNE_MAX_CHILDREN),
      session
        .prepare(
          `DELETE FROM agent_auth_registrations WHERE id IN (
            SELECT id FROM agent_auth_registrations WHERE expires_at<=?
            ORDER BY expires_at,id LIMIT ?
          ) AND NOT EXISTS (
            SELECT 1 FROM agent_auth_tokens t
            WHERE t.registration_id=agent_auth_registrations.id
          ) AND NOT EXISTS (
            SELECT 1 FROM agent_auth_ceremonies c
            WHERE c.registration_id=agent_auth_registrations.id
          ) RETURNING 1 AS deleted`,
        )
        // Approval precedes claim expiry. Waiting the full assertion lifetime
        // beyond it also protects assertions that have no current access token.
        .bind(
          nowSeconds - AGENT_AUTH_ASSERTION_SECONDS,
          AGENT_AUTH_PRUNE_MAX_REGISTRATIONS,
        ),
    ]);
    if (!Array.isArray(results) || results.length !== 3)
      return { status: "unavailable" };
    const tokens = deletedCount(results[0], AGENT_AUTH_PRUNE_MAX_CHILDREN);
    const ceremonies = deletedCount(results[1], AGENT_AUTH_PRUNE_MAX_CHILDREN);
    const registrations = deletedCount(
      results[2],
      AGENT_AUTH_PRUNE_MAX_REGISTRATIONS,
    );
    if (tokens === null || ceremonies === null || registrations === null)
      return { status: "unavailable" };
    return { status: "pruned", deleted: { tokens, ceremonies, registrations } };
  } catch {
    return { status: "unavailable" };
  }
}
