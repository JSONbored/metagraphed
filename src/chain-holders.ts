// GET /api/v1/chain/holders (#9607): every subnet ranked by how concentrated
// its alpha ownership is.
//
// The cross-subnet companion to /subnets/{netuid}/holders (#9557), and the one
// `/chain/X` twin that route shipped without. Answering "which subnets are
// owned by one wallet" through the per-subnet route takes 129 requests, which
// is the same argument /chain/burn was built on.
//
// NOT /chain/concentration. That route computes Gini/HHI/Nakamoto off
// `neurons.stake_tao`, so it sees REGISTERED UIDs only -- on netuid 74 that is
// 10 of the 92 hotkeys actually carrying positions. This reads the position
// ledger, so it sees the whole holder set including alpha parked on hotkeys
// that hold no UID. The two answer different questions and disagree by design.
//
// ## ALPHA IS NOT SUMMABLE ACROSS SUBNETS, AND THAT SHAPES THE ROLLUP
//
// Every subnet's alpha is a DIFFERENT token. Adding netuid 4's alpha to netuid
// 64's produces a number with no unit, and this repo has already paid for that
// once: #8803 shipped `delegated_tao` as a raw cross-subnet alpha sum and
// production reported its top account at 14,984,421 "TAO" -- 71% of the 21M
// hard cap -- with the top five summing to 1.57x max supply.
//
// So `total_alpha` is reported PER SUBNET and never added up, and the network
// rollup carries only dimension-free facts: how many subnets there are, how
// many have a majority holder, how many have exactly one, and the MEDIAN of the
// top-1 shares. A share is a ratio within one subnet, so a distribution of
// shares is comparable where a sum of alphas is not. A caller wanting a
// cross-subnet total must price each subnet's alpha through its own
// `alpha_price_tao` first -- which is what /accounts/top-holders does.
//
// Gated on the same proven pool pass as its per-subnet twin: a partial
// `hotkey_alpha` underprices holders rather than dropping them, so a ranking
// built on it is plausible and wrong. See src/hotkey-alpha-completeness.ts.

import {
  latestCompleteHotkeyAlphaPass,
  mayPriceHotkeyAlpha,
} from "./hotkey-alpha-completeness.ts";
import {
  CHAIN_HOLDERS_LIMIT_DEFAULT,
  CHAIN_HOLDERS_LIMIT_MAX,
} from "./route-limits.ts";
import { median } from "./lib/stats.ts";

export { CHAIN_HOLDERS_LIMIT_DEFAULT, CHAIN_HOLDERS_LIMIT_MAX };

type Row = Record<string, unknown>;

/** The ranks this route reports a share for, and the sorts derived from them. */
export const CHAIN_HOLDERS_RANKS = [1, 5, 10, 20] as const;

export const CHAIN_HOLDERS_SORTS = [
  "top1_share",
  "top5_share",
  "top10_share",
  "top20_share",
  "holder_count",
  "total_alpha",
] as const;
export const DEFAULT_CHAIN_HOLDERS_SORT = "top1_share";

/** A share above this is a single account holding a majority of a subnet's
 * measured alpha -- the fact the rollup counts. */
export const MAJORITY_SHARE = 0.5;

export interface ChainHoldersDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all?(): Promise<{ results?: unknown[] } | null>;
    };
    all?(): Promise<{ results?: unknown[] } | null>;
    first?(): Promise<unknown>;
  };
}

export type ChainHoldersDecline = "pool_totals_unproven" | "unavailable";

export interface ChainHoldersRead {
  rows: Row[];
  capturedAt: number | null;
  decline: ChainHoldersDecline | null;
}

/**
 * One statement: every subnet's holder set, ranked within the subnet, rolled to
 * per-subnet totals and prefix sums.
 *
 * ROW_NUMBER() OVER (PARTITION BY netuid ORDER BY alpha DESC) is what makes the
 * prefix sums possible in a single pass -- the per-subnet route uses nested
 * LIMIT subqueries instead, which is correct for ONE subnet and would need 129
 * of them here. Verified against production D1 before this shipped; SQLite has
 * had window functions since 3.25 and D1 supports them.
 *
 * Exported because the scoping, the partitioning and the prefix boundaries are
 * the whole contract and all three are decidable from the string.
 */
export function chainHoldersSql(alphaCapturedAt: number): string {
  const prefixes = CHAIN_HOLDERS_RANKS.map(
    (n) => `SUM(CASE WHEN rn <= ${n} THEN alpha ELSE 0 END) AS top${n}_alpha`,
  ).join(", ");
  return (
    "WITH holder AS (" +
    "SELECT np.netuid AS netuid, np.coldkey AS coldkey," +
    " SUM(np.share_fraction * ha.total_alpha) AS alpha," +
    " MAX(np.captured_at) AS positions_captured_at" +
    " FROM nominator_positions np" +
    " JOIN hotkey_alpha ha ON ha.hotkey = np.hotkey" +
    " AND ha.netuid = np.netuid" +
    ` AND ha.captured_at = ${alphaCapturedAt}` +
    " GROUP BY np.netuid, np.coldkey), " +
    "ranked AS (SELECT netuid, coldkey, alpha, positions_captured_at," +
    " ROW_NUMBER() OVER (PARTITION BY netuid ORDER BY alpha DESC) AS rn" +
    " FROM holder) " +
    "SELECT netuid, COUNT(*) AS holder_count, SUM(alpha) AS total_alpha," +
    ` ${prefixes},` +
    " MAX(CASE WHEN rn = 1 THEN coldkey END) AS top_holder," +
    " MAX(positions_captured_at) AS positions_captured_at" +
    " FROM ranked GROUP BY netuid"
  );
}

/** Every subnet's holder concentration, or a decline. Never throws. */
export async function loadChainHolders(
  db: ChainHoldersDb | null | undefined,
): Promise<ChainHoldersRead> {
  const declined = (decline: ChainHoldersDecline): ChainHoldersRead => ({
    rows: [],
    capturedAt: null,
    decline,
  });
  if (!db?.prepare) return declined("unavailable");

  const alpha = await latestCompleteHotkeyAlphaPass(
    db as unknown as Parameters<typeof latestCompleteHotkeyAlphaPass>[0],
  );
  if (!mayPriceHotkeyAlpha(alpha)) {
    return declined(
      alpha.reason === "unavailable" ? "unavailable" : "pool_totals_unproven",
    );
  }
  try {
    const res = await db.prepare(chainHoldersSql(alpha.capturedAt)).all?.();
    if (!Array.isArray(res?.results)) throw new Error("chain-holders: no rows");
    return {
      rows: res.results as Row[],
      capturedAt: alpha.capturedAt,
      decline: null,
    };
  } catch {
    return declined("unavailable");
  }
}

/**
 * Shape the card. Pure, so the same rows produce the same payload wherever they
 * came from.
 *
 * A DECLINE carries an empty `subnets` with an explicit `degraded.reason` and a
 * NULL `subnet_count` -- never 0, which would assert the network has no subnets
 * with holders.
 */
export function buildChainHolders(
  read: ChainHoldersRead,
  { sort, limit }: { sort?: string; limit?: number } = {},
): Row {
  const base = {
    schema_version: 1,
    sort: sort ?? DEFAULT_CHAIN_HOLDERS_SORT,
    limit: limit ?? null,
  };
  if (read.decline) {
    return {
      ...base,
      subnet_count: null,
      network: emptyNetwork(),
      captured_at: null,
      positions_captured_at: null,
      subnets: [],
      degraded: { reason: read.decline },
    };
  }

  const subnets = read.rows
    .map((r) => {
      const netuid = intOrNull(r?.netuid);
      const total = nonNegativeOrNull(r?.total_alpha);
      if (netuid === null) return null;
      const entry: Row = {
        netuid,
        holder_count: nonNegativeOrNull(r?.holder_count),
        total_alpha: total === null ? null : round(total),
        top_holder: typeof r?.top_holder === "string" ? r.top_holder : null,
      };
      for (const n of CHAIN_HOLDERS_RANKS) {
        entry[`top${n}_share`] = share(
          nonNegativeOrNull(r?.[`top${n}_alpha`]),
          total,
        );
      }
      return entry;
    })
    .filter((e): e is Row => e !== null);

  const key = CHAIN_HOLDERS_SORTS.includes(
    (sort ?? "") as (typeof CHAIN_HOLDERS_SORTS)[number],
  )
    ? (sort as string)
    : DEFAULT_CHAIN_HOLDERS_SORT;
  // Null sorts LAST on every key: a subnet whose share could not be computed is
  // not the least concentrated one, it is unmeasured, and putting it at the top
  // of an ascending list would read as a finding.
  subnets.sort((a, b) => {
    const av = a[key] as number | null;
    const bv = b[key] as number | null;
    if (av === null && bv === null)
      return (a.netuid as number) - (b.netuid as number);
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av || (a.netuid as number) - (b.netuid as number);
  });

  const positionsCapturedAt = read.rows.reduce<number | null>((newest, r) => {
    const v = positiveOrNull(r?.positions_captured_at);
    return v !== null && (newest === null || v > newest) ? v : newest;
  }, null);

  return {
    ...base,
    subnet_count: subnets.length,
    network: networkRollup(subnets),
    captured_at: toIsoOrNull(read.capturedAt),
    positions_captured_at: toIsoOrNull(positionsCapturedAt),
    subnets: limit == null ? subnets : subnets.slice(0, limit),
  };
}

/**
 * Dimension-free network facts only.
 *
 * There is deliberately no `total_alpha` here. Summing every subnet's alpha
 * adds different tokens together and produces the #8803 number -- a figure that
 * looks like a network total and is not one. Counts and a MEDIAN of within-
 * subnet ratios are the two things that survive the unit mismatch.
 */
function networkRollup(subnets: Row[]): Row {
  // SORTED ASCENDING before median(), which documents that as its contract and
  // does not sort for you (src/lib/stats.ts:18). `subnets` arrives ordered by
  // whichever key the CALLER sorted on, so handing it over unsorted would return
  // the middle element of an arbitrary order -- a number that looks like a
  // median for every sort and is one for almost none.
  const top1 = subnets
    .map((s) => s.top1_share as number | null)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  return {
    subnets_measured: subnets.length,
    // A single account holding the majority of a subnet's measured alpha.
    subnets_with_majority_holder: top1.filter((v) => v >= MAJORITY_SHARE)
      .length,
    // Exactly one holder -- the whole subnet's alpha in one wallet.
    subnets_with_single_holder: subnets.filter((s) => s.holder_count === 1)
      .length,
    // median() is null-typed for the empty case, which the length guard already
    // excludes -- narrowed rather than asserted so an empty array can never
    // reach round() and become NaN.
    median_top1_share: medianOrNull(top1),
  };
}

function emptyNetwork(): Row {
  return {
    subnets_measured: null,
    subnets_with_majority_holder: null,
    subnets_with_single_holder: null,
    median_top1_share: null,
  };
}

/** The median of an ASCENDING array, rounded, or null when there is none. */
function medianOrNull(ascending: number[]): number | null {
  const value = median(ascending);
  return value === null ? null : round(value);
}

/** A share, or null. A zero denominator yields null, never 0 or Infinity. */
function share(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole <= 0) return null;
  return round(part / whole);
}

function nonNegativeOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * A netuid, or null.
 *
 * The `value == null` guard is load-bearing rather than defensive: `Number(null)`
 * is 0 and `Number(undefined)` is NaN, so without it a row with no netuid would
 * pass `Number.isInteger(0) && 0 >= 0` and be published as **netuid 0** — root,
 * a real subnet. A dropped row is a visible absence; a row silently relabelled
 * as root is a fabricated measurement about the one netuid this family already
 * treats specially. Same trap src/subnet-burn-history.ts's numberOrNaN() exists
 * for, where 0 is likewise a legitimate value.
 */
function intOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
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
