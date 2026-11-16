import { randomUUID } from "node:crypto";
import { asJsonObject } from "../schemas-src/json-request.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { PgTransaction } from "./pg-pool.ts";

export interface ChainStateLimits {
  maxStateBytes: number;
  leaseMilliseconds: number;
}
export interface ChainOwnerLease {
  token: string;
  state: string;
  nowMs: number;
  expiresAtMs: number;
  alarmVersion: number;
}
export interface ChainAlarmClaim {
  token: string;
  version: number;
}
interface ChainRow {
  max_state_bytes: number;
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
const nowMs = async (tx: PgTransaction) =>
  Number(
    (await tx.first<{ now: string | number }>(
      "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now",
    ))!.now,
  );

export function parseChainState(text: string): Record<string, unknown> {
  let state: Record<string, unknown> | null = null;
  try {
    state = asJsonObject(JSON.parse(text));
  } catch {
    /* Refuse damaged custody state. */
  }
  if (!state) throw new Error("Invalid native chain state");
  for (const key of Object.keys(state))
    if (
      ![
        "mcp:subscribed-sessions",
        "head:last_seen",
        "head:write_next",
      ].includes(key)
    )
      throw new Error("Unsupported native chain state key");
  const members = state["mcp:subscribed-sessions"];
  if (
    members !== undefined &&
    (!Array.isArray(members) ||
      members.some((id) => typeof id !== "string" || !id))
  )
    throw new Error("Invalid native chain membership");
  // The source head poller owns validation and repair of its numeric cursors.
  return state;
}

/** One fenced owner; each operation releases its transaction before returning. */
export async function createPgChainFirehoseStore(
  runtime: Pick<PgStoreRuntime, "transaction">,
  requested: ChainStateLimits,
) {
  const limits = Object.freeze({ ...requested });
  for (const [key, value, max] of [
    ["maxStateBytes", limits.maxStateBytes, 131072],
    ["leaseMilliseconds", limits.leaseMilliseconds, 3600000],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new RangeError(`Invalid chain ${key}`);
  const transaction = <T>(
    operation: (tx: PgTransaction, row: ChainRow) => Promise<T>,
  ) =>
    runtime.transaction(
      async (tx) => {
        const row = await tx.first<ChainRow>(
          "SELECT * FROM realtime.chain_firehose_actor WHERE singleton FOR UPDATE",
        );
        if (!row || row.max_state_bytes !== limits.maxStateBytes)
          throw new Error("Native chain state capacity differs");
        return operation(tx, row);
      },
      { isolation: "read committed" },
    );
  await runtime.transaction(
    async (tx) => {
      await tx.run(
        "INSERT INTO realtime.chain_firehose_actor(singleton,max_state_bytes) VALUES(true,?) ON CONFLICT(singleton) DO NOTHING",
        [limits.maxStateBytes],
      );
    },
    { isolation: "read committed" },
  );
  await transaction(async () => {});
  const owned = async (
    tx: PgTransaction,
    row: ChainRow,
    lease: ChainOwnerLease,
  ) => {
    const now = await nowMs(tx);
    if (row.owner_token !== lease.token || Number(row.lease_until_ms) <= now)
      throw new Error("Native chain ownership was lost");
    return now;
  };
  return {
    limits,
    acquire(): Promise<ChainOwnerLease | null> {
      return transaction(async (tx, row) => {
        const now = await nowMs(tx);
        if (row.owner_token !== null && Number(row.lease_until_ms) > now)
          return null;
        parseChainState(row.state);
        const token = randomUUID(),
          expiresAtMs = now + limits.leaseMilliseconds;
        await tx.run(
          "UPDATE realtime.chain_firehose_actor SET owner_token=?,lease_until_ms=? WHERE singleton",
          [token, expiresAtMs],
        );
        return {
          token,
          state: row.state,
          nowMs: now,
          expiresAtMs,
          alarmVersion: Number(row.alarm_version),
        };
      });
    },
    renew(lease: ChainOwnerLease) {
      return transaction(async (tx, row) => {
        const now = await owned(tx, row, lease),
          expiresAtMs = now + limits.leaseMilliseconds;
        await tx.run(
          "UPDATE realtime.chain_firehose_actor SET lease_until_ms=? WHERE singleton",
          [expiresAtMs],
        );
        return { nowMs: now, expiresAtMs };
      });
    },
    save(lease: ChainOwnerLease, state: string) {
      parseChainState(state);
      if (Buffer.byteLength(state) > limits.maxStateBytes)
        return Promise.reject(
          new RangeError("Native chain state exceeds configured capacity"),
        );
      return transaction(async (tx, row) => {
        await owned(tx, row, lease);
        await tx.run(
          "UPDATE realtime.chain_firehose_actor SET state=? WHERE singleton",
          [state],
        );
      });
    },
    alarmTime(lease: ChainOwnerLease) {
      return transaction(async (tx, row) => {
        await owned(tx, row, lease);
        return row.alarm_at_ms === null ? null : Number(row.alarm_at_ms);
      });
    },
    setAlarm(lease: ChainOwnerLease, when: number) {
      if (!Number.isSafeInteger(when) || when < 0)
        return Promise.reject(
          new RangeError("Invalid native chain alarm time"),
        );
      return transaction(async (tx, row) => {
        await owned(tx, row, lease);
        await tx.run(
          "UPDATE realtime.chain_firehose_actor SET alarm_at_ms=?,alarm_version=alarm_version+1,alarm_attempts=0,alarm_outcome='pending' WHERE singleton",
          [when],
        );
        return Number(row.alarm_version) + 1;
      });
    },
    claimAlarm(lease: ChainOwnerLease): Promise<ChainAlarmClaim | null> {
      return transaction(async (tx, row) => {
        const now = await owned(tx, row, lease);
        if (
          row.alarm_at_ms === null ||
          Number(row.alarm_at_ms) > now ||
          row.alarm_owner_token === lease.token
        )
          return null;
        if (row.alarm_attempts >= 6) {
          await tx.run(
            "UPDATE realtime.chain_firehose_actor SET alarm_at_ms=NULL,alarm_outcome='exhausted',alarm_run_token=NULL,alarm_owner_token=NULL,alarm_run_version=NULL WHERE singleton",
          );
          return null;
        }
        const token = randomUUID(),
          version = Number(row.alarm_version);
        await tx.run(
          "UPDATE realtime.chain_firehose_actor SET alarm_attempts=alarm_attempts+1,alarm_run_token=?,alarm_owner_token=?,alarm_run_version=?,alarm_outcome='running' WHERE singleton",
          [token, lease.token, version],
        );
        return { token, version };
      });
    },
    settleAlarm(
      lease: ChainOwnerLease,
      claim: ChainAlarmClaim,
      failed: boolean,
    ) {
      return transaction(async (tx, row) => {
        const now = await owned(tx, row, lease);
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
          "UPDATE realtime.chain_firehose_actor SET alarm_at_ms=?,alarm_outcome=?,alarm_run_token=NULL,alarm_owner_token=NULL,alarm_run_version=NULL WHERE singleton",
          [next, outcome],
        );
        return true;
      });
    },
    release(lease: ChainOwnerLease) {
      return transaction(async (tx) => {
        await tx.run(
          "UPDATE realtime.chain_firehose_actor SET owner_token=NULL,lease_until_ms=0 WHERE singleton AND owner_token=?",
          [lease.token],
        );
      });
    },
  };
}
