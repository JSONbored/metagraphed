import { randomUUID } from "node:crypto";
import { NativeScheduledBackgroundError } from "./native-api-process.ts";
import { parseNativeCron } from "./native-cron.ts";
import { createNativeWorkGroup } from "./native-work-group.ts";
import type { PgTransaction } from "./pg-pool.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";

export type NativeCronOwner = "api" | "data" | "registry";
export interface NativeCronDefinition {
  owner: NativeCronOwner;
  cron: string;
}
export interface NativeCronLimits {
  maxConcurrent: number;
  leaseMilliseconds: number;
  executionTimeoutMillis: number;
  drainTimeoutMillis: number;
  maxAttempts: number;
  historyLimit: number;
}
export interface NativeCronEvent {
  cron: string;
  scheduledTime: number;
}
export type NativeCronOutcome =
  "succeeded" | "declined" | "handler-failed" | "background-failed" | "aborted";
export type NativeCronRunResult =
  | { status: "empty" | "capacity" }
  | (NativeCronDefinition & {
      status: "lease-exhausted";
      scheduledTime: number;
    })
  | (NativeCronDefinition & {
      status: "completed" | "stale";
      scheduledTime: number;
      outcome: NativeCronOutcome;
      result: unknown;
      error?: unknown;
    });
interface ScheduleRow extends NativeCronDefinition {
  start_at_ms: string | number;
  cursor_ms: string | number;
  pending_at_ms: string | number | null;
}
interface ClaimRow extends ScheduleRow {
  active_at_ms: string | number | null;
  attempts: number | null;
}
const clockSql =
  "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now";
const key = ({ owner, cron }: NativeCronDefinition) => `${owner}:${cron}`;
const clock = async (tx: PgTransaction) =>
  Number((await tx.first<{ now: string | number }>(clockSql))!.now);
const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";
function resultFlags(result: unknown) {
  const object =
    result !== null && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  return {
    ok: isBoolean(object.ok) ? object.ok : null,
    skipped: isBoolean(object.skipped) ? object.skipped : null,
  };
}

/** Explicit durable cron custody; no registration, timer, loop or process activation. */
export async function createPgCronScheduler(
  runtime: Pick<PgStoreRuntime, "transaction">,
  requestedDefinitions: readonly NativeCronDefinition[],
  requestedLimits: NativeCronLimits,
) {
  const definitions = requestedDefinitions.map((definition) => ({
    ...definition,
  }));
  const limits = { ...requestedLimits };
  for (const [name, value, max] of [
    ["maxConcurrent", limits.maxConcurrent, 100],
    ["leaseMilliseconds", limits.leaseMilliseconds, 3600000],
    ["executionTimeoutMillis", limits.executionTimeoutMillis, 3600000],
    ["drainTimeoutMillis", limits.drainTimeoutMillis, 3600000],
    ["maxAttempts", limits.maxAttempts, 100],
    ["historyLimit", limits.historyLimit, 10000],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new RangeError(`Invalid cron ${name}`);
  if (limits.executionTimeoutMillis >= limits.leaseMilliseconds)
    throw new RangeError("Cron execution deadline must precede lease expiry");
  if (definitions.length < 1 || definitions.length > 100)
    throw new RangeError(
      "Native cron inventory must contain 1 to 100 definitions",
    );
  const inventory = new Map<string, ReturnType<typeof parseNativeCron>>();
  for (const definition of definitions) {
    if (
      !["api", "data", "registry"].includes(definition.owner) ||
      inventory.has(key(definition))
    )
      throw new Error(
        "Native cron inventory has an invalid owner or duplicate",
      );
    inventory.set(key(definition), parseNativeCron(definition.cron));
  }
  const policyValues = [
    limits.maxConcurrent,
    limits.leaseMilliseconds,
    limits.executionTimeoutMillis,
    limits.maxAttempts,
    limits.historyLimit,
  ];
  const checkPolicy = async (tx: PgTransaction) => {
    const policy = await tx.first<{
      max_concurrent: number;
      lease_ms: number;
      execution_ms: number;
      max_attempts: number;
      history_limit: number;
    }>("SELECT * FROM jobs.cron_policy WHERE singleton FOR UPDATE");
    if (
      !policy ||
      JSON.stringify([
        policy.max_concurrent,
        policy.lease_ms,
        policy.execution_ms,
        policy.max_attempts,
        policy.history_limit,
      ]) !== JSON.stringify(policyValues)
    )
      throw new Error("Native cron policy differs");
  };
  const transact = <T>(operation: (tx: PgTransaction) => Promise<T>) =>
    runtime.transaction(
      async (tx) => {
        await checkPolicy(tx);
        return operation(tx);
      },
      { isolation: "read committed" },
    );
  await runtime.transaction(
    async (tx) => {
      await tx.run(
        "INSERT INTO jobs.cron_policy(singleton,max_concurrent,lease_ms,execution_ms,max_attempts,history_limit) VALUES(true,?,?,?,?,?) ON CONFLICT(singleton) DO NOTHING",
        policyValues,
      );
      await checkPolicy(tx);
    },
    { isolation: "read committed" },
  );
  const work = createNativeWorkGroup({
    name: "Native cron",
    executionTimeoutMillis: limits.executionTimeoutMillis,
    drainTimeoutMillis: limits.drainTimeoutMillis,
  });
  const schedules = async (tx: PgTransaction) => {
    const rows = await tx.query<ScheduleRow>(
      "SELECT * FROM jobs.cron_schedules ORDER BY owner,cron FOR UPDATE",
    );
    if (
      rows.length &&
      (rows.length !== inventory.size ||
        rows.some((row) => !inventory.has(key(row))))
    )
      throw new Error("Native cron registered inventory differs");
    return rows;
  };
  const prune = async (tx: PgTransaction, row: NativeCronDefinition) => {
    await tx.run(
      `DELETE FROM jobs.cron_runs WHERE (owner,cron,scheduled_at_ms) IN (
      SELECT owner,cron,scheduled_at_ms FROM jobs.cron_runs WHERE owner=? AND cron=? AND state<>'running'
      ORDER BY scheduled_at_ms DESC OFFSET ?)`,
      [row.owner, row.cron, limits.historyLimit],
    );
    await tx.run(
      `DELETE FROM jobs.cron_skips WHERE (owner,cron,through_ms) IN (
      SELECT owner,cron,through_ms FROM jobs.cron_skips WHERE owner=? AND cron=? ORDER BY through_ms DESC OFFSET ?)`,
      [row.owner, row.cron, limits.historyLimit],
    );
  };
  const claim = () =>
    transact(async (tx) => {
      await schedules(tx);
      const now = await clock(tx);
      const active = await tx.first<{ count: string | number }>(
        "SELECT COUNT(*) AS count FROM jobs.cron_runs WHERE state='running' AND lease_until_ms>?",
        [now],
      );
      if (Number(active!.count) >= limits.maxConcurrent)
        return { status: "capacity" as const };
      const row = await tx.first<ClaimRow>(
        `SELECT s.*,r.scheduled_at_ms AS active_at_ms,r.attempts
      FROM jobs.cron_schedules s LEFT JOIN jobs.cron_runs r ON r.owner=s.owner AND r.cron=s.cron AND r.state='running'
      WHERE (r.lease_until_ms<=?) OR (r.owner IS NULL AND s.pending_at_ms<=?)
      ORDER BY COALESCE(r.scheduled_at_ms,s.pending_at_ms),s.owner,s.cron LIMIT 1`,
        [now, now],
      );
      if (!row) return { status: "empty" as const };
      if (row.active_at_ms !== null && row.attempts! >= limits.maxAttempts) {
        await tx.run(
          "UPDATE jobs.cron_runs SET state='lease-exhausted',finished_at_ms=? WHERE owner=? AND cron=? AND scheduled_at_ms=?",
          [now, row.owner, row.cron, row.active_at_ms],
        );
        await prune(tx, row);
        return {
          status: "lease-exhausted" as const,
          owner: row.owner,
          cron: row.cron,
          scheduledTime: Number(row.active_at_ms),
        };
      }
      const scheduledTime = Number(row.active_at_ms ?? row.pending_at_ms);
      const token = randomUUID();
      if (row.active_at_ms === null) {
        await tx.run(
          "INSERT INTO jobs.cron_runs(owner,cron,scheduled_at_ms,token,attempts,started_at_ms,lease_until_ms,state) VALUES(?,?,?,?,1,?,?,'running')",
          [
            row.owner,
            row.cron,
            scheduledTime,
            token,
            now,
            now + limits.leaseMilliseconds,
          ],
        );
        await tx.run(
          "UPDATE jobs.cron_schedules SET pending_at_ms=NULL WHERE owner=? AND cron=?",
          [row.owner, row.cron],
        );
      } else {
        await tx.run(
          "UPDATE jobs.cron_runs SET token=?,attempts=attempts+1,started_at_ms=?,lease_until_ms=? WHERE owner=? AND cron=? AND scheduled_at_ms=?",
          [
            token,
            now,
            now + limits.leaseMilliseconds,
            row.owner,
            row.cron,
            scheduledTime,
          ],
        );
      }
      return {
        status: "claimed" as const,
        owner: row.owner,
        cron: row.cron,
        scheduledTime,
        token,
      };
    });
  return {
    get state() {
      return work.state;
    },
    register(startAtMs: number): Promise<void> {
      if (!Number.isSafeInteger(startAtMs) || startAtMs < 0)
        return Promise.reject(
          new RangeError(
            "Native cron start boundary must be a nonnegative safe timestamp",
          ),
        );
      return work.track(() =>
        transact(async (tx) => {
          for (const definition of definitions)
            await tx.run(
              "INSERT INTO jobs.cron_schedules(owner,cron,start_at_ms,cursor_ms) VALUES(?,?,?,?) ON CONFLICT(owner,cron) DO NOTHING",
              [definition.owner, definition.cron, startAtMs, startAtMs - 1],
            );
          const rows = await schedules(tx);
          if (rows.some((row) => Number(row.start_at_ms) !== startAtMs))
            throw new Error("Native cron start boundary differs");
        }),
      );
    },
    plan() {
      return work.track(() =>
        transact(async (tx) => {
          const now = await clock(tx);
          const planned: (NativeCronDefinition & {
            scheduledTime: number;
            skipped: number;
          })[] = [];
          for (const row of await schedules(tx)) {
            const cursor = Number(row.cursor_ms);
            if (cursor >= now) continue;
            const due = inventory.get(key(row))!.window(cursor, now);
            if (!due.count) {
              await tx.run(
                "UPDATE jobs.cron_schedules SET cursor_ms=? WHERE owner=? AND cron=?",
                [now, row.owner, row.cron],
              );
              continue;
            }
            const skipped = due.count - 1 + Number(row.pending_at_ms !== null);
            if (skipped)
              await tx.run(
                "INSERT INTO jobs.cron_skips(owner,cron,through_ms,first_at_ms,last_at_ms,slot_count) VALUES(?,?,?,?,?,?)",
                [
                  row.owner,
                  row.cron,
                  now,
                  row.pending_at_ms ?? due.first,
                  due.previous ?? row.pending_at_ms,
                  skipped,
                ],
              );
            await tx.run(
              "UPDATE jobs.cron_schedules SET cursor_ms=?,pending_at_ms=?,skipped_count=skipped_count+? WHERE owner=? AND cron=?",
              [now, due.last, skipped, row.owner, row.cron],
            );
            await prune(tx, row);
            planned.push({
              owner: row.owner,
              cron: row.cron,
              scheduledTime: due.last!,
              skipped,
            });
          }
          return { throughMs: now, planned };
        }),
      );
    },
    run(
      consume: (
        owner: NativeCronOwner,
        event: NativeCronEvent,
        signal: AbortSignal,
      ) => Promise<unknown>,
    ): Promise<NativeCronRunResult> {
      return work.run<NativeCronRunResult>(
        "cron",
        limits.maxConcurrent,
        () => ({ status: "capacity" }),
        async (scope) => {
          const claimed = await claim();
          if (claimed.status !== "claimed") return claimed;
          let result: unknown;
          let error: unknown;
          let aborted = false;
          let outcome: NativeCronOutcome;
          try {
            result = await scope.invoke(
              (signal) =>
                consume(
                  claimed.owner,
                  { cron: claimed.cron, scheduledTime: claimed.scheduledTime },
                  signal,
                ),
              () => {
                aborted = true;
              },
            );
            outcome =
              resultFlags(result).ok === false ||
              resultFlags(result).skipped === true
                ? "declined"
                : "succeeded";
          } catch (failure) {
            error = failure;
            if (failure instanceof NativeScheduledBackgroundError)
              result = failure.result;
            outcome = aborted
              ? "aborted"
              : failure instanceof NativeScheduledBackgroundError
                ? "background-failed"
                : "handler-failed";
          }
          const flags = resultFlags(result);
          const settled = await transact(async (tx) => {
            const now = await clock(tx);
            const updated = await tx.run(
              "UPDATE jobs.cron_runs SET state=?,finished_at_ms=?,result_ok=?,result_skipped=? WHERE owner=? AND cron=? AND scheduled_at_ms=? AND token=? AND state='running' AND lease_until_ms>?",
              [
                outcome,
                now,
                flags.ok,
                flags.skipped,
                claimed.owner,
                claimed.cron,
                claimed.scheduledTime,
                claimed.token,
                now,
              ],
            );
            await prune(tx, claimed);
            return updated.changes === 1;
          });
          return {
            status: settled ? "completed" : "stale",
            owner: claimed.owner,
            cron: claimed.cron,
            scheduledTime: claimed.scheduledTime,
            outcome,
            result,
            error,
          };
        },
      );
    },
    close: work.close,
  };
}

/** Route through each already-composed process; never open or close its pool. */
export function createPgCronDispatcher(
  scheduler: Pick<Awaited<ReturnType<typeof createPgCronScheduler>>, "run">,
  processes: Record<
    NativeCronOwner,
    {
      scheduled(event: NativeCronEvent, signal?: AbortSignal): Promise<unknown>;
    }
  >,
) {
  return () =>
    scheduler.run((owner, event, signal) =>
      processes[owner].scheduled(event, signal),
    );
}
