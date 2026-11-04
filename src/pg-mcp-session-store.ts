import { randomUUID } from "node:crypto";
import { McpSessionStateSchema } from "../schemas-src/internal-wire.ts";
import { asJsonObject } from "../schemas-src/json-request.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { PgTransaction } from "./pg-pool.ts";

export interface McpStoreLimits {
  maxSessions: number;
  maxBytes: number;
  maxStateBytes: number;
  leaseMilliseconds: number;
}
export interface McpSessionLease {
  key: string;
  token: string;
  state: string;
  nowMs: number;
  expiresAtMs: number;
  alarmVersion: number;
}
export interface McpAlarmClaim {
  token: string;
  version: number;
}
interface SessionRow {
  state: string;
  owner_token: string | null;
  lease_until_ms: string | number;
  alarm_at_ms: string | number | null;
  alarm_version: string | number;
  alarm_attempts: number;
  alarm_run_token: string | null;
  alarm_owner_token: string | null;
  alarm_run_version: string | number | null;
}
const clock = async (tx: PgTransaction) =>
  Number(
    (await tx.first<{ now: string | number }>(
      "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now",
    ))!.now,
  );
export function mcpSessionKey(id: string): string {
  if (typeof id !== "string" || id.length < 1 || id.length > 128)
    throw new RangeError("Invalid native MCP session id");
  return JSON.stringify(id);
}
function parsedSessionId(text: string): string {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "string")
    throw new Error("Invalid stored MCP session key");
  mcpSessionKey(value);
  return value;
}
export function parseMcpSessionState(text: string) {
  let object: Record<string, unknown> | null = null;
  try {
    object = asJsonObject(JSON.parse(text));
  } catch {
    /* Refuse unavailable persisted state. */
  }
  if (!object || !McpSessionStateSchema.safeParse(object).success)
    throw new Error("Invalid native MCP session state");
  return object;
}

/** Short fenced transactions only; no connection stays resident with a stream. */
export async function createPgMcpSessionStore(
  runtime: Pick<PgStoreRuntime, "transaction">,
  requested: McpStoreLimits,
) {
  const limits = Object.freeze({ ...requested });
  for (const [name, value, max] of [
    ["maxSessions", limits.maxSessions, 100000],
    ["maxBytes", limits.maxBytes, 1073741824],
    ["maxStateBytes", limits.maxStateBytes, 131072],
    ["leaseMilliseconds", limits.leaseMilliseconds, 3600000],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new RangeError(`Invalid MCP ${name}`);
  const processId = randomUUID();
  const check = async (tx: PgTransaction) => {
    const row = await tx.first<{
      max_sessions: number;
      max_bytes: string | number;
      max_state_bytes: number;
    }>("SELECT * FROM realtime.mcp_capacity WHERE singleton FOR UPDATE");
    if (
      !row ||
      row.max_sessions !== limits.maxSessions ||
      Number(row.max_bytes) !== limits.maxBytes ||
      row.max_state_bytes !== limits.maxStateBytes
    )
      throw new Error("Native MCP capacity differs");
    if (
      !(
        await tx.first<{ ready: boolean }>(
          "SELECT COUNT(*)=1 AND bool_and(tgenabled IN ('O','A')) AS ready FROM pg_catalog.pg_trigger WHERE tgrelid=to_regclass('realtime.mcp_sessions') AND tgname='mcp_state_capacity' AND NOT tgisinternal",
        )
      )?.ready
    )
      throw new Error("Native MCP state enforcement is unavailable");
  };
  const transact = <T>(operation: (tx: PgTransaction) => Promise<T>) =>
    runtime.transaction(
      async (tx) => {
        await check(tx);
        return operation(tx);
      },
      { isolation: "read committed" },
    );
  await runtime.transaction(
    async (tx) => {
      await tx.run(
        "INSERT INTO realtime.mcp_capacity(singleton,max_sessions,max_bytes,max_state_bytes) VALUES(true,?,?,?) ON CONFLICT(singleton) DO NOTHING",
        [limits.maxSessions, limits.maxBytes, limits.maxStateBytes],
      );
      await check(tx);
    },
    { isolation: "read committed" },
  );
  const owned = async (
    tx: PgTransaction,
    lease: Pick<McpSessionLease, "key" | "token">,
  ) => {
    const row = await tx.first<SessionRow>(
      "SELECT * FROM realtime.mcp_sessions WHERE session_key=? FOR UPDATE",
      [lease.key],
    );
    const now = await clock(tx);
    if (
      !row ||
      row.owner_token !== lease.token ||
      Number(row.lease_until_ms) <= now
    )
      throw new Error("Native MCP session ownership was lost");
    return { row, now };
  };
  return {
    limits,
    acquire(id: string): Promise<McpSessionLease | null> {
      const key = mcpSessionKey(id);
      return transact(async (tx) => {
        const now = await clock(tx);
        await tx.run(
          "INSERT INTO realtime.mcp_sessions(session_key,updated_at_ms) VALUES(?,?) ON CONFLICT(session_key) DO NOTHING",
          [key, now],
        );
        const row = (await tx.first<SessionRow>(
          "SELECT * FROM realtime.mcp_sessions WHERE session_key=? FOR UPDATE",
          [key],
        ))!;
        if (row.owner_token !== null && Number(row.lease_until_ms) > now)
          return null;
        const state = parseMcpSessionState(row.state);
        if (state.sessionId != null && state.sessionId !== id)
          throw new Error("MCP session identity differs from its key");
        const token = randomUUID(),
          expiresAtMs = now + limits.leaseMilliseconds;
        await tx.run(
          "UPDATE realtime.mcp_sessions SET owner_process=?,owner_token=?,lease_until_ms=? WHERE session_key=?",
          [processId, token, expiresAtMs, key],
        );
        return {
          key,
          token,
          state: row.state,
          nowMs: now,
          expiresAtMs,
          alarmVersion: Number(row.alarm_version),
        };
      });
    },
    renew(lease: McpSessionLease) {
      return transact(async (tx) => {
        const { now } = await owned(tx, lease);
        const expiresAtMs = now + limits.leaseMilliseconds;
        await tx.run(
          "UPDATE realtime.mcp_sessions SET lease_until_ms=? WHERE session_key=? AND owner_token=?",
          [expiresAtMs, lease.key, lease.token],
        );
        return { nowMs: now, expiresAtMs };
      });
    },
    save(lease: McpSessionLease, state: string) {
      const parsed = parseMcpSessionState(state);
      if (
        parsed.sessionId != null &&
        parsed.sessionId !== parsedSessionId(lease.key)
      )
        return Promise.reject(
          new Error("MCP session identity differs from its key"),
        );
      if (Buffer.byteLength(state) > limits.maxStateBytes)
        return Promise.reject(
          new RangeError("Native MCP state exceeds configured capacity"),
        );
      return transact(async (tx) => {
        const { now } = await owned(tx, lease);
        await tx.run(
          "UPDATE realtime.mcp_sessions SET state=?,updated_at_ms=? WHERE session_key=? AND owner_token=?",
          [state, now, lease.key, lease.token],
        );
      });
    },
    setAlarm(lease: McpSessionLease, when: number) {
      if (!Number.isSafeInteger(when) || when < 0)
        return Promise.reject(new RangeError("Invalid native MCP alarm time"));
      return transact(async (tx) => {
        const { row } = await owned(tx, lease);
        await tx.run(
          "UPDATE realtime.mcp_sessions SET alarm_at_ms=?,alarm_version=alarm_version+1,alarm_attempts=0,alarm_outcome='pending' WHERE session_key=? AND owner_token=?",
          [when, lease.key, lease.token],
        );
        return Number(row.alarm_version) + 1;
      });
    },
    due(limit: number) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        return Promise.reject(new RangeError("Invalid MCP alarm batch limit"));
      return transact(async (tx) => {
        const now = await clock(tx);
        return (
          await tx.query<{ session_key: string }>(
            "SELECT session_key FROM realtime.mcp_sessions WHERE alarm_at_ms<=? AND (alarm_run_token IS NULL OR alarm_owner_token IS DISTINCT FROM owner_token OR lease_until_ms<=?) AND (owner_token IS NULL OR lease_until_ms<=? OR owner_process=?) ORDER BY alarm_at_ms,session_key LIMIT ?",
            [now, now, now, processId, limit],
          )
        ).map((row) => parsedSessionId(row.session_key));
      });
    },
    claimAlarm(lease: McpSessionLease): Promise<McpAlarmClaim | null> {
      return transact(async (tx) => {
        const { row, now } = await owned(tx, lease);
        if (
          row.alarm_at_ms === null ||
          Number(row.alarm_at_ms) > now ||
          row.alarm_owner_token === lease.token
        )
          return null;
        if (row.alarm_attempts >= 6) {
          await tx.run(
            "UPDATE realtime.mcp_sessions SET alarm_at_ms=NULL,alarm_outcome='exhausted',alarm_run_token=NULL,alarm_owner_token=NULL,alarm_run_version=NULL WHERE session_key=?",
            [lease.key],
          );
          return null;
        }
        const token = randomUUID(),
          version = Number(row.alarm_version);
        await tx.run(
          "UPDATE realtime.mcp_sessions SET alarm_attempts=alarm_attempts+1,alarm_run_token=?,alarm_owner_token=?,alarm_run_version=?,alarm_outcome='running' WHERE session_key=?",
          [token, lease.token, version, lease.key],
        );
        return { token, version };
      });
    },
    settleAlarm(lease: McpSessionLease, claim: McpAlarmClaim, failed: boolean) {
      return transact(async (tx) => {
        const { row, now } = await owned(tx, lease);
        if (
          row.alarm_run_token !== claim.token ||
          row.alarm_owner_token !== lease.token ||
          Number(row.alarm_run_version) !== claim.version
        )
          return false;
        const rearmed = Number(row.alarm_version) !== claim.version;
        const exhausted = !rearmed && failed && row.alarm_attempts >= 6;
        const next = rearmed
          ? row.alarm_at_ms
          : failed && !exhausted
            ? now + 2000 * 2 ** (row.alarm_attempts - 1)
            : null;
        const outcome = rearmed
          ? "pending"
          : failed
            ? exhausted
              ? "exhausted"
              : "retry"
            : "completed";
        await tx.run(
          "UPDATE realtime.mcp_sessions SET alarm_at_ms=?,alarm_outcome=?,alarm_run_token=NULL,alarm_owner_token=NULL,alarm_run_version=NULL WHERE session_key=?",
          [next, outcome, lease.key],
        );
        return true;
      });
    },
    release(lease: McpSessionLease) {
      return transact(async (tx) => {
        // Token identity fences release even after expiry; a new owner is untouched.
        await tx.run(
          "UPDATE realtime.mcp_sessions SET owner_process=NULL,owner_token=NULL,lease_until_ms=0 WHERE session_key=? AND owner_token=?",
          [lease.key, lease.token],
        );
      });
    },
    dropEmpty(lease: McpSessionLease) {
      return transact(async (tx) => {
        const { changes } = await tx.run(
          "DELETE FROM realtime.mcp_sessions WHERE session_key=? AND owner_token=? AND state='{}' AND alarm_at_ms IS NULL",
          [lease.key, lease.token],
        );
        return changes === 1;
      });
    },
  };
}
