// GET /api/v1/subnets/{netuid}/holders (#9557): who owns one subnet's alpha.
//
// WHAT NOTHING ELSE ANSWERS. Four routes look like they should and each answers
// a different question: `/accounts/top-holders` is chain-wide TAO with no netuid
// dimension; `/subnets/{netuid}/concentration` reads `neurons.stake_tao`, so it
// sees REGISTERED UIDs only and emits scalars (gini/hhi/nakamoto) rather than a
// holder list; `/validators/{hotkey}/nominators` is 90d flow, so a dormant
// holder is invisible; `/accounts/{ss58}/positions` is the forward index, one
// coldkey at a time. This is the reverse one: subnet -> holder coldkeys.
//
// THE DIFFERENTIATOR IS FREE HERE AND EXPENSIVE EVERYWHERE ELSE.
// `nominator_positions` is keyed (coldkey, hotkey, netuid) whether or not that
// hotkey holds a UID on that subnet, so alpha staked to UNREGISTERED hotkeys is
// already in the table. Measured against production 2026-08-05, netuid 74 has 92
// hotkeys carrying positions and 10 of them registered on 74 -- a source reading
// off `neurons` cannot see the other 82, and an RPC-side consumer reaches them
// only with a full-chain map scan.
//
// RANKED IN ALPHA, NOT TAO. src/top-holders-holdings.ts has to join
// `subnet_snapshots` for a price and carries two caveats for it: an up-to-24h
// price skew, and a netuid with no usable price dropping out of the sum. Within
// ONE subnet alpha is already a common unit, so this route omits the price join
// entirely and both caveats go with it. A caller wanting TAO multiplies by the
// subnet's alpha price, which /subnets/{netuid} already serves.
//
// AGGREGATES ARE COMPUTED ACROSS THE FULL HOLDER SET, THEN SLICED. holder_count,
// total_alpha and the three concentration shares come from their own statement
// over every holder on the subnet -- never from the capped rows. The top-N of a
// sum is not contained in the union of the top-Ns of its addends
// (src/top-holders-holdings.ts:41-47), and a top5_share computed over a
// ?limit=3 response would be a well-formed number describing nothing.
//
// TWO STATES DECLINE RATHER THAN ANSWER, both because an empty leaderboard here
// would read as a measurement:
//
//   1. No complete `hotkey_alpha` pass. This is MORE exposed than the chain-wide
//      ranking, not less: a handful of missing pool totals reorders a small
//      subnet's top 10 outright, and an underpriced holder looks like data. See
//      src/hotkey-alpha-completeness.ts for why a row count cannot answer this.
//   2. netuid 0. `SubtensorModule::Alpha` carries no root data
//      (src/account-nominator-positions.ts:16-19), so root has no holder set to
//      rank -- distinct from a subnet that genuinely has no holders.

import {
  latestCompleteHotkeyAlphaPass,
  mayPriceHotkeyAlpha,
} from "./hotkey-alpha-completeness.ts";
import {
  SUBNET_HOLDERS_LIMIT_DEFAULT,
  SUBNET_HOLDERS_LIMIT_MAX,
} from "./route-limits.ts";

export { SUBNET_HOLDERS_LIMIT_DEFAULT, SUBNET_HOLDERS_LIMIT_MAX };

type Row = Record<string, unknown>;

/** The minimal D1 surface used here, so tests can inject a plain object. */
export interface SubnetHoldersDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all?(): Promise<{ results?: unknown[] } | null>;
      first?(): Promise<unknown>;
    };
    first?(): Promise<unknown>;
  };
}

/**
 * The netuid that has no holder set to rank.
 *
 * Root stake is not in the Alpha map at all, so this is a structural absence
 * rather than a subnet nobody holds.
 */
export const ROOT_NETUID = 0;

/** Ranks the concentration block reports, in the order it publishes them. */
export const HOLDER_CONCENTRATION_RANKS = [5, 10, 20] as const;

/** Why a ranking could not be produced, or null when one was. */
export type SubnetHoldersDecline =
  "root_not_in_alpha_map" | "pool_totals_unproven" | "unavailable";

export interface SubnetHoldersAggregate {
  holderCount: number | null;
  totalAlpha: number | null;
  /** Summed alpha of the top N holders, keyed by N. */
  topAlpha: Map<number, number | null>;
  positionsCapturedAt: number | null;
}

export interface SubnetHoldersRead {
  rows: Row[];
  aggregate: SubnetHoldersAggregate | null;
  /** captured_at of the pool pass every row was valued against. */
  capturedAt: number | null;
  decline: SubnetHoldersDecline | null;
}

/**
 * Holders of one subnet, valued against a single proven pool pass.
 *
 * SCOPED TO ONE `ha.captured_at`, matching src/top-holders-holdings.ts's
 * delegated leg and for its reason: mixing pool stamps values one coldkey's
 * positions against totals read at different blocks, which is a silently
 * inconsistent sum rather than a merely stale one.
 */
const holderCte = (alphaCapturedAt: number) =>
  "holder AS (" +
  "SELECT np.coldkey AS coldkey," +
  " SUM(np.share_fraction * ha.total_alpha) AS alpha," +
  " COUNT(DISTINCT np.hotkey) AS hotkey_count," +
  " MAX(np.captured_at) AS positions_captured_at" +
  " FROM nominator_positions np" +
  " JOIN hotkey_alpha ha ON ha.hotkey = np.hotkey" +
  " AND ha.netuid = np.netuid" +
  ` AND ha.captured_at = ${alphaCapturedAt}` +
  " WHERE np.netuid = ?" +
  " GROUP BY np.coldkey)";

/**
 * The ranked page.
 *
 * Exported for the same reason topHoldersHoldingsSql is: the scoping, the
 * ordering and the cap are the whole contract, and all three are decidable from
 * the string without a database.
 */
export function subnetHoldersRowsSql(
  alphaCapturedAt: number,
  limit: number,
): string {
  return (
    `WITH ${holderCte(alphaCapturedAt)}` +
    " SELECT coldkey, alpha, hotkey_count FROM holder" +
    ` ORDER BY alpha DESC, coldkey ASC LIMIT ${limit}`
  );
}

/**
 * The whole-subnet aggregates, over every holder rather than the returned page.
 *
 * Each top-N sum is a `LIMIT` subquery rather than a window function: plain
 * SQLite either way, and this form states the "rank the full set, then take N"
 * rule directly in the shape of the query.
 */
export function subnetHoldersAggregateSql(alphaCapturedAt: number): string {
  const tops = HOLDER_CONCENTRATION_RANKS.map(
    (n) =>
      `(SELECT SUM(alpha) FROM (SELECT alpha FROM holder ORDER BY alpha DESC` +
      ` LIMIT ${n})) AS top${n}_alpha`,
  );
  return (
    `WITH ${holderCte(alphaCapturedAt)}` +
    " SELECT (SELECT COUNT(*) FROM holder) AS holder_count," +
    " (SELECT SUM(alpha) FROM holder) AS total_alpha," +
    " (SELECT MAX(positions_captured_at) FROM holder) AS positions_captured_at," +
    ` ${tops.join(", ")}`
  );
}

/**
 * Read one subnet's holder ranking, or say why there isn't one.
 *
 * Returns a DECLINE rather than throwing on a missing binding or a failed
 * query, matching every other tier reader here: a leaderboard that cannot prove
 * its inputs should say so, not 500.
 */
export async function loadSubnetHolders(
  db: SubnetHoldersDb | null | undefined,
  netuid: number,
  { limit = SUBNET_HOLDERS_LIMIT_DEFAULT }: { limit?: number } = {},
): Promise<SubnetHoldersRead> {
  const declined = (decline: SubnetHoldersDecline): SubnetHoldersRead => ({
    rows: [],
    aggregate: null,
    capturedAt: null,
    decline,
  });

  // Checked before the binding: root has no holder set whether or not D1 is
  // reachable, so the reason a caller gets should not depend on that.
  if (netuid === ROOT_NETUID) return declined("root_not_in_alpha_map");
  if (!db?.prepare) return declined("unavailable");

  const alpha = await latestCompleteHotkeyAlphaPass(
    db as unknown as Parameters<typeof latestCompleteHotkeyAlphaPass>[0],
  );
  if (!mayPriceHotkeyAlpha(alpha)) {
    // "The table is missing" and "no pass has completed" are the same fact to a
    // caller -- the pool totals are not proven -- so `unavailable` is reported
    // only for the binding itself, which the caller can act on differently.
    return declined(
      alpha.reason === "unavailable" ? "unavailable" : "pool_totals_unproven",
    );
  }

  try {
    const [rowsRes, aggRes] = await Promise.all([
      db
        .prepare(subnetHoldersRowsSql(alpha.capturedAt, limit))
        .bind(netuid)
        .all?.(),
      db
        .prepare(subnetHoldersAggregateSql(alpha.capturedAt))
        .bind(netuid)
        .first?.(),
    ]);
    if (!Array.isArray(rowsRes?.results)) throw new Error("holders: no rows");
    return {
      rows: rowsRes.results as Row[],
      aggregate: readAggregate(aggRes as Row | null),
      capturedAt: alpha.capturedAt,
      decline: null,
    };
  } catch {
    return declined("unavailable");
  }
}

function readAggregate(row: Row | null | undefined): SubnetHoldersAggregate {
  const topAlpha = new Map<number, number | null>();
  for (const n of HOLDER_CONCENTRATION_RANKS) {
    topAlpha.set(n, nonNegativeOrNull(row?.[`top${n}_alpha`]));
  }
  return {
    holderCount: nonNegativeOrNull(row?.holder_count),
    totalAlpha: nonNegativeOrNull(row?.total_alpha),
    topAlpha,
    positionsCapturedAt: positiveOrNull(row?.positions_captured_at),
  };
}

/**
 * Shape the card. Pure, so the same rows produce the same payload wherever they
 * came from.
 *
 * A DECLINE carries `holders: []` alongside an explicit `degraded.reason` and
 * NULL counts -- never a zero one. "We cannot rank this" and "nobody holds any"
 * are different facts, and only the second is a measurement (#9414); the same
 * distinction src/account-nominator-positions.ts's `positions_unpriceable`
 * label draws per row, drawn here for the ranking as a whole.
 */
export function buildSubnetHolders(
  read: SubnetHoldersRead,
  netuid: unknown,
  { limit }: { limit?: number } = {},
): Row {
  const base = {
    schema_version: 1,
    netuid,
    limit: limit ?? null,
  };
  if (read.decline) {
    return {
      ...base,
      holder_count: null,
      total_alpha: null,
      concentration: concentrationBlock(null, null),
      captured_at: null,
      positions_captured_at: null,
      holders: [],
      degraded: { reason: read.decline },
    };
  }

  const totalAlpha = read.aggregate?.totalAlpha ?? null;
  const holders = read.rows
    .map((r) => ({
      coldkey: typeof r?.coldkey === "string" ? r.coldkey : null,
      alpha: nonNegativeOrNull(r?.alpha),
      hotkey_count: nonNegativeOrNull(r?.hotkey_count),
    }))
    .filter((h) => h.coldkey !== null && h.alpha !== null)
    .map((h) => ({
      ...h,
      // Over the FULL subnet total, so a holder's share means the same thing at
      // ?limit=5 and ?limit=100.
      share_of_total: share(h.alpha, totalAlpha),
    }));

  return {
    ...base,
    holder_count: read.aggregate?.holderCount ?? null,
    total_alpha: totalAlpha === null ? null : round(totalAlpha),
    concentration: concentrationBlock(read.aggregate ?? null, totalAlpha),
    captured_at: toIsoOrNull(read.capturedAt),
    positions_captured_at: toIsoOrNull(
      read.aggregate?.positionsCapturedAt ?? null,
    ),
    holders,
  };
}

/**
 * top5/top10/top20 as fractions of the subnet's whole measured alpha.
 *
 * A rank with no denominator, or one whose holder set is smaller than the rank
 * itself, yields null rather than 1.0: "the top 20 hold everything" and "there
 * are fewer than 20 holders" are different statements, and only the caller's
 * `holder_count` distinguishes them.
 */
function concentrationBlock(
  aggregate: SubnetHoldersAggregate | null,
  totalAlpha: number | null,
): Row {
  const out: Row = {};
  for (const n of HOLDER_CONCENTRATION_RANKS) {
    out[`top${n}_share`] = share(
      aggregate?.topAlpha.get(n) ?? null,
      totalAlpha,
    );
  }
  return out;
}

/**
 * A share, or null.
 *
 * A zero denominator yields null, never 0 or Infinity: with no measured alpha on
 * the subnet there is no share to state, and 0 would claim the holder owns none
 * of something rather than that the question has no answer.
 */
function share(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole <= 0) return null;
  return round(part / whole);
}

/** Finite and >= 0, else null. A holding cannot be negative: a negative here is
 * a broken read, not a measurement. */
function nonNegativeOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function positiveOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toIsoOrNull(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}
