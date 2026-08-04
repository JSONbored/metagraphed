// The registration-cost series (#9402): capture, retention and serving.
//
// `SubtensorModule.Burn` is re-priced by the registration auction, so the operator
// question is usually "is this subnet getting more or less expensive" rather than
// "what does it cost right now". Nothing answered it -- `subnet_hyperparams` stores
// the burn BOUNDS and not the live value, and `subnet_hyperparams_history` holds
// roughly one snapshot per subnet, which is a capture rather than a series.
//
// The capture rides on #9399's reader: every subnet's burn is ONE
// `state_queryStorageAt` call, so a tick costs one RPC round trip regardless of how
// many subnets exist, and `loadChainBurn` already returns exactly the shape persisted
// here. There is no second decoder to keep in step.

import { loadChainBurn } from "./chain-burn.ts";
import type { ChainNetworkId } from "./chain-network.ts";

type Row = Record<string, unknown>;

/** The minimal D1 surface used here, so tests can inject a plain object. */
export interface BurnHistoryDb {
  prepare(sql: string): {
    bind(...values: unknown[]): unknown;
    all?(): Promise<{ results?: unknown[] } | null>;
  };
  batch?(statements: unknown[]): Promise<unknown>;
}

export const SUBNET_BURN_HISTORY_TABLE = "subnet_burn_history";

/**
 * How long a captured price is kept.
 *
 * 90 days matches the window the health surfaces already report over, so an operator
 * comparing a burn series against uptime is looking at the same span. The table grows
 * by one row per subnet per tick, so at 129 subnets on a 15-minute cadence that is
 * ~1.1M rows at steady state -- small, but unbounded growth with no policy is how a
 * table becomes someone's problem years later.
 */
export const BURN_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Windows the serving route accepts, and the default. */
export const BURN_HISTORY_WINDOWS: Record<string, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
export const DEFAULT_BURN_HISTORY_WINDOW = "7d";

/**
 * Points returned per request.
 *
 * A 90-day window at a 15-minute cadence is ~8,600 points, which is more than any
 * caller charts and a large response to build. Newest-first with a cap means a client
 * asking for "90d" gets the most recent slice rather than a truncated-from-the-wrong-
 * end series, and `point_count` plus `window` say exactly what they received.
 */
export const BURN_HISTORY_MAX_POINTS = 2000;

/**
 * Persist one tick's prices, and drop what has aged out.
 *
 * Never throws: a capture lane that could take down the cron it runs on would be worse
 * than a gap in the series. Returns what happened so the caller can log it.
 *
 * A subnet whose burn could not be read is an ABSENT row, never a zero one -- 0 is a
 * real price (netuid 76 reads a true zero and is the cheapest registration on the
 * network), so writing 0 for "unknown" would put a false bargain in the series.
 */
export async function captureSubnetBurnHistory(
  env: Env,
  {
    db,
    now = Date.now,
    network,
    load = loadChainBurn,
  }: {
    db?: BurnHistoryDb | null;
    now?: () => number;
    network?: ChainNetworkId;
    load?: typeof loadChainBurn;
  } = {},
): Promise<{
  ok: boolean;
  captured: number;
  pruned: boolean;
  reason?: string;
}> {
  if (!db?.prepare || !db?.batch) {
    return { ok: false, captured: 0, pruned: false, reason: "no_d1_binding" };
  }
  let card: Row;
  try {
    card = await load(env, network);
  } catch (error) {
    return {
      ok: false,
      captured: 0,
      pruned: false,
      reason: `chain_read_failed: ${String((error as Error)?.message ?? error)}`,
    };
  }

  const subnets = Array.isArray(card.subnets) ? (card.subnets as Row[]) : [];
  // The tick's own stamp, not each row's: every price in one batch was read from the
  // same block, so sharing one observed_at is what makes a cross-subnet comparison at
  // a point in time meaningful rather than smeared across the write.
  const observedAt = now();
  const rows = subnets
    .map((s) => ({
      netuid: numberOrNaN(s?.netuid),
      burn_tao: numberOrNaN(s?.burn_tao),
    }))
    .filter(
      (s) =>
        Number.isSafeInteger(s.netuid) &&
        s.netuid >= 0 &&
        Number.isFinite(s.burn_tao) &&
        s.burn_tao >= 0,
    );
  if (rows.length === 0) {
    return { ok: false, captured: 0, pruned: false, reason: "empty_read" };
  }

  try {
    // INSERT OR REPLACE, not INSERT: a retried tick at the same millisecond must be
    // idempotent rather than a primary-key error that fails the whole batch.
    const insert = db.prepare(
      `INSERT OR REPLACE INTO ${SUBNET_BURN_HISTORY_TABLE}` +
        ` (netuid, observed_at, burn_tao) VALUES (?, ?, ?)`,
    );
    await db.batch(
      rows.map((r) => insert.bind(r.netuid, observedAt, r.burn_tao)),
    );
  } catch (error) {
    return {
      ok: false,
      captured: 0,
      pruned: false,
      reason: `write_failed: ${String((error as Error)?.message ?? error)}`,
    };
  }

  // Pruned in its own try: the prices are already committed, so a failed sweep must
  // not report the capture as failed. The next tick retries it.
  let pruned = false;
  try {
    const sweep = db
      .prepare(`DELETE FROM ${SUBNET_BURN_HISTORY_TABLE} WHERE observed_at < ?`)
      .bind(observedAt - BURN_HISTORY_RETENTION_MS) as {
      run?: () => Promise<unknown>;
    };
    await sweep.run?.();
    pruned = true;
  } catch {
    // Retention is housekeeping; the series is what matters.
  }

  return { ok: true, captured: rows.length, pruned };
}

/**
 * Shape one subnet's series. Pure, so the exact same card is produced whichever tier
 * or test supplies the rows.
 *
 * Rows arrive NEWEST FIRST. `change_tao` / `change_pct` describe the movement across
 * the returned window, and are null when there is nothing to compare against -- a
 * single point has no change, and a change from zero has no percentage.
 */
export function buildSubnetBurnHistory(
  rows: Row[] | null | undefined,
  netuid: unknown,
  { window }: { window?: unknown } = {},
): Row {
  const points = (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      observed_at: toIsoOrNull(r?.observed_at),
      burn_tao: toFiniteOrNull(r?.burn_tao),
    }))
    .filter((p) => p.observed_at !== null && p.burn_tao !== null);

  const newest = points[0]?.burn_tao ?? null;
  const oldest = points.length ? points[points.length - 1].burn_tao : null;
  const changeTao =
    newest === null || oldest === null || points.length < 2
      ? null
      : round(newest - oldest);
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    point_count: points.length,
    current_burn_tao: newest,
    // Across the RETURNED window, so it always describes the series in hand rather
    // than a span the caller did not receive.
    change_tao: changeTao,
    // Undefined from a zero base: a rise from 0 is not "infinitely more expensive",
    // it is a change with no meaningful ratio, and Infinity would serialize to null
    // anyway with nothing to say why.
    change_pct:
      changeTao === null || oldest === null || oldest === 0
        ? null
        : round(changeTao / oldest),
    points,
  };
}

/** One subnet's series from D1, newest first. Null when the read fails. */
export async function loadSubnetBurnHistory(
  db: BurnHistoryDb | null | undefined,
  netuid: number,
  { windowDays, now = Date.now }: { windowDays: number; now?: () => number },
): Promise<Row[] | null> {
  if (!db?.prepare) return null;
  try {
    const cutoff = now() - windowDays * 24 * 60 * 60 * 1000;
    const res = await (
      db
        .prepare(
          `SELECT observed_at, burn_tao FROM ${SUBNET_BURN_HISTORY_TABLE}` +
            ` WHERE netuid = ? AND observed_at >= ?` +
            ` ORDER BY observed_at DESC LIMIT ${BURN_HISTORY_MAX_POINTS}`,
        )
        .bind(netuid, cutoff) as {
        all?(): Promise<{ results?: unknown[] } | null>;
      }
    ).all?.();
    return (res?.results ?? []) as Row[];
  } catch {
    return null;
  }
}

/**
 * Coerce to a number, but treat null/undefined as UNREADABLE rather than as 0.
 *
 * `Number(null)` is 0, and 0 is a real burn price here -- netuid 76 reads a true zero.
 * So a bare `Number()` would turn "this subnet's price could not be read" into "this
 * subnet is free", writing a false bargain into the series that reads as measured.
 * That is the exact inverse of the rule this module exists to hold, and the test
 * asserting absent-not-zero is what caught it.
 */
function numberOrNaN(value: unknown): number {
  return value == null ? Number.NaN : Number(value);
}

function toFiniteOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIsoOrNull(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}
