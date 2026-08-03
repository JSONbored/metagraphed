// Scheduled projections over the chain lakehouse (#9146).
//
// WHY A CRON, NOT A ONE-SHOT ARTIFACT AND NOT A REQUEST-TIME READER. The
// windowed aggregate routes (chain/transfers, chain/stake-flow) anchor their
// windows to the current date, so a one-shot materialization — the
// top-holders answer, whose inputs are frozen — would rot within a day. And
// R2 SQL is a second-scale engine with no indexes (src/r2-sql.ts's measured
// characteristics), so recomputing a network-wide aggregate under a request
// is the hot-path misuse that module's header warns against. A cron is the
// remaining shape: each lane recomputes its artifact from the lakehouse on an
// interval, and the artifact readers (src/*-artifact.ts) serve R2 gets.
//
// FAILURE POSTURE. A failed compute must NEVER overwrite a good artifact:
// the runner writes only on a non-null body, so the reader keeps serving the
// previous tick's answer — stale by one interval at worst, which is strictly
// better than garbage or a schema-stable empty. Lane failures are isolated
// (one lane's throw never skips the next) and each failure records exactly
// one exception under `projection:<name>` so a silently dead lane is visible.

import { isR2SqlConfigured, r2SqlQuery } from "./r2-sql.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";
import {
  CHAIN_TRANSFER_LIMIT_MAX,
  CHAIN_TRANSFER_WINDOWS,
} from "./chain-transfers.ts";
import {
  CHAIN_STAKE_FLOW_WINDOWS,
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
} from "./chain-stake-flow.ts";
import { CHAIN_TRANSFERS_PROJECTION_KEY } from "./chain-transfers-artifact.ts";
import { CHAIN_STAKE_FLOW_PROJECTION_KEY } from "./chain-stake-flow-artifact.ts";

/** Matches the analytics routes' day arithmetic (workers/data-api.ts's
 * ANALYTICS_DAY_MS) so a lane's cutoff is the same instant the live Postgres
 * tier would have computed for the same window label. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** src/chain-transfers.ts keeps TRANSFER_KIND private; inlined here the same
 * way workers/data-api.ts inlines it for the identical query. */
const TRANSFER_KIND = "Transfer";

export interface ProjectionLane {
  name: string;
  /** R2 key under metagraph/projections/ the runner writes and the matching
   * artifact reader gets — imported FROM the reader module so the writer and
   * reader cannot drift apart. */
  artifactKey: string;
  /** Reserved: a lane that needs its own cadence declares it and gets its own
   * dispatch branch. Every current lane runs on the shared
   * PROJECTION_LANES_CRON tick, so none sets this yet. */
  intervalCron?: string;
  /** The artifact body ({schema_version, generated_at, row_count, windows}),
   * or null when the lakehouse could not answer EVERY query — a partial
   * artifact would serve one window's fresh numbers next to another's
   * garbage, so all-or-nothing is the only honest contract. */
  compute(env: Env): Promise<Record<string, unknown> | null>;
}

/** Every value a lane inlines below is a module constant or a computed
 * integer — never caller input — per src/r2-sql.ts's no-bound-params
 * contract. */
function transferWindowSql(cutoff: number): string[] {
  const scope =
    `FROM chain.account_events ` +
    `WHERE event_kind = '${TRANSFER_KIND}' AND observed_at >= ${cutoff}`;
  // The same five statements workers/data-api.ts issues for this route, in
  // the same split: the two DISTINCT counts were separated there because each
  // one alone is the heaviest scan in the family, and the same
  // one-heavy-aggregation-per-statement shape keeps each query under R2 SQL's
  // own per-query ceiling here.
  return [
    `SELECT COUNT(*) AS transfer_count, ` +
      `COALESCE(SUM(amount_tao), 0) AS total_volume_tao, ` +
      `MAX(observed_at) AS newest_observed ${scope}`,
    `SELECT COUNT(DISTINCT hotkey) AS unique_senders ${scope}`,
    `SELECT COUNT(DISTINCT coldkey) AS unique_receivers ${scope}`,
    // Leaderboards are precomputed at the route's MAXIMUM limit so every
    // smaller ?limit= is a prefix slice of the same total order
    // (volume DESC, address ASC) — one artifact serves every limit, the way
    // one top-holders artifact serves every sort.
    `SELECT hotkey AS address, SUM(amount_tao) AS volume_tao, ` +
      `COUNT(*) AS transfer_count ${scope} AND hotkey IS NOT NULL ` +
      `GROUP BY hotkey ORDER BY volume_tao DESC, hotkey ASC ` +
      `LIMIT ${CHAIN_TRANSFER_LIMIT_MAX}`,
    `SELECT coldkey AS address, SUM(amount_tao) AS volume_tao, ` +
      `COUNT(*) AS transfer_count ${scope} AND coldkey IS NOT NULL ` +
      `GROUP BY coldkey ORDER BY volume_tao DESC, coldkey ASC ` +
      `LIMIT ${CHAIN_TRANSFER_LIMIT_MAX}`,
  ];
}

/** GET /api/v1/chain/transfers, every supported window, from the lakehouse
 * account_events Transfer feed — the R2 SQL replication of data-api's route
 * queries, windows computed from this run's generated_at. */
async function computeChainTransfers(
  env: Env,
): Promise<Record<string, unknown> | null> {
  const generatedAt = Date.now();
  const windows: Record<string, unknown> = {};
  let rowCount = 0;
  for (const [label, days] of Object.entries(CHAIN_TRANSFER_WINDOWS)) {
    const [
      totalsSql,
      sendersCountSql,
      receiversCountSql,
      sendersSql,
      receiversSql,
    ] = transferWindowSql(generatedAt - days * DAY_MS);
    // Sequential on purpose: one second-scale scan in flight at a time, the
    // posture every cold-tier caller of r2SqlQuery takes.
    const totals = await r2SqlQuery(env, totalsSql!);
    if (totals === null) return null;
    const senderCount = await r2SqlQuery(env, sendersCountSql!);
    if (senderCount === null) return null;
    const receiverCount = await r2SqlQuery(env, receiversCountSql!);
    if (receiverCount === null) return null;
    const senders = await r2SqlQuery(env, sendersSql!);
    if (senders === null) return null;
    const receivers = await r2SqlQuery(env, receiversSql!);
    if (receivers === null) return null;
    windows[label] = {
      days,
      // The exact `totals` object data-api hands buildChainTransfers: the
      // single-row aggregate spread together with the two DISTINCT counts.
      totals: {
        ...(totals[0] ?? null),
        unique_senders: senderCount[0]?.unique_senders ?? 0,
        unique_receivers: receiverCount[0]?.unique_receivers ?? 0,
      },
      senders,
      receivers,
    };
    rowCount += senders.length + receivers.length;
  }
  return {
    schema_version: 1,
    generated_at: new Date(generatedAt).toISOString(),
    row_count: rowCount,
    windows,
  };
}

/** GET /api/v1/chain/stake-flow, every supported window — data-api's single
 * GROUP BY netuid, event_kind aggregate in R2 SQL, rows stored verbatim so
 * the reader's buildChainStakeFlow pass serves every limit. */
async function computeChainStakeFlow(
  env: Env,
): Promise<Record<string, unknown> | null> {
  const generatedAt = Date.now();
  const windows: Record<string, unknown> = {};
  let rowCount = 0;
  for (const [label, days] of Object.entries(CHAIN_STAKE_FLOW_WINDOWS)) {
    const cutoff = generatedAt - days * DAY_MS;
    const rows = await r2SqlQuery(
      env,
      `SELECT netuid, event_kind, COALESCE(SUM(amount_tao), 0) AS total_tao, ` +
        `COUNT(*) AS event_count, MAX(observed_at) AS last_observed ` +
        `FROM chain.account_events ` +
        `WHERE event_kind IN ('${STAKE_ADDED_KIND}', '${STAKE_REMOVED_KIND}') ` +
        `AND observed_at >= ${cutoff} GROUP BY netuid, event_kind`,
    );
    if (rows === null) return null;
    windows[label] = { days, rows };
    rowCount += rows.length;
  }
  return {
    schema_version: 1,
    generated_at: new Date(generatedAt).toISOString(),
    row_count: rowCount,
    windows,
  };
}

export const PROJECTION_LANES: ProjectionLane[] = [
  {
    name: "chain-transfers",
    artifactKey: CHAIN_TRANSFERS_PROJECTION_KEY,
    compute: computeChainTransfers,
  },
  {
    name: "chain-stake-flow",
    artifactKey: CHAIN_STAKE_FLOW_PROJECTION_KEY,
    compute: computeChainStakeFlow,
  },
];

interface ProjectionBucket {
  put(key: string, value: string): Promise<unknown>;
}

export interface ProjectionLaneDeps {
  recordException?: typeof recordExceptionEvent;
}

export interface ProjectionLaneResult {
  name: string;
  ok: boolean;
  /** The written body's own row_count, or null when nothing was written. */
  rows: number | null;
  reason?: string;
}

/**
 * Run one lane: compute, and write the artifact ONLY on a non-null body. A
 * null compute (or a throwing store) leaves the previous artifact in place,
 * logs, and records one exception under `projection:<name>`.
 */
export async function runProjectionLane(
  env: Env,
  lane: ProjectionLane,
  deps: ProjectionLaneDeps = {},
): Promise<ProjectionLaneResult> {
  const record = deps.recordException ?? recordExceptionEvent;
  const bucket = (env as { METAGRAPH_ARCHIVE?: ProjectionBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.put) {
    // Without the bucket a computed body has nowhere durable to land —
    // refuse before spending second-scale queries on an answer that would be
    // dropped (raw-capture-sync's posture).
    return {
      name: lane.name,
      ok: false,
      rows: null,
      reason: "r2_binding_missing",
    };
  }
  try {
    const body = await lane.compute(env);
    if (body === null) {
      console.error(
        `[projection:${lane.name}] compute declined; previous artifact left in place`,
      );
      await record(env, {
        error: new Error(`projection lane ${lane.name}: compute declined`),
        route: `projection:${lane.name}`,
      });
      return {
        name: lane.name,
        ok: false,
        rows: null,
        reason: "compute_declined",
      };
    }
    await bucket.put(lane.artifactKey, JSON.stringify(body));
    const rows = (body as { row_count?: unknown }).row_count;
    return {
      name: lane.name,
      ok: true,
      rows: typeof rows === "number" ? rows : null,
    };
  } catch (error) {
    // A throwing store is the same decline as a failed compute: the previous
    // artifact survives, and the NEXT lane still runs.
    console.error(
      `[projection:${lane.name}]`,
      String((error as Error)?.message ?? error),
    );
    await record(env, { error, route: `projection:${lane.name}` });
    return { name: lane.name, ok: false, rows: null, reason: "lane_failed" };
  }
}

/**
 * The cron entrypoint: every registered lane, sequentially. `lanes` maps each
 * lane name to the row count it wrote, or null when it wrote nothing.
 */
export async function runProjectionLanes(
  env: Env,
  deps: ProjectionLaneDeps = {},
): Promise<{
  ok: boolean;
  skipped?: true;
  reason?: string;
  lanes: Record<string, number | null>;
}> {
  if (!isR2SqlConfigured(env)) {
    // Unconfigured is a deliberate deployment state (local/CI/self-hosters
    // have no lakehouse), not a fault: skip quietly, the same contract as the
    // ACCOUNT_EVENTS_ROLLUP_CRON skip — an exception per tick forever would
    // burn the telemetry allowance announcing a permanent non-event.
    return {
      ok: false,
      skipped: true,
      reason: "r2 sql not configured",
      lanes: {},
    };
  }
  const lanes: Record<string, number | null> = {};
  let ok = true;
  for (const lane of PROJECTION_LANES) {
    const result = await runProjectionLane(env, lane, deps);
    lanes[lane.name] = result.rows;
    ok = ok && result.ok;
  }
  return { ok, lanes };
}
