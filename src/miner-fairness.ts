// #10931: if you register a miner on this subnet, what are the odds you earn
// anything?
//
// ## THE NUMBER EVERY DASHBOARD PUBLISHES IS CLOSE TO FICTION
//
// Measured from the live metagraph: SN64 lists 240 miner UIDs and 14 of them
// earn. SN4 lists 246 and 4 earn. The median across 128 subnets is 99.2% of
// non-validator UIDs on zero emission. "240 miners" read as 240 earners is
// probably the single most misleading number in this ecosystem, and it is the
// one every leaderboard shows.
//
// And 256 UIDs is not 256 operators. `uids_per_entity` -- already computed,
// already served by /concentration -- has a network median of 3.08 and a
// maximum of 21.3. SN84 is three operators across 256 UIDs.
//
// ## A SNAPSHOT CANNOT ANSWER THIS, AND WOULD LOOK LIKE IT COULD
//
// `emission_tao` on one day is a per-tempo rate, and a UID paid on a different
// tempo reads as a zero that day. So a single frame overstates the zero rate,
// and it cannot distinguish the two facts that matter most:
//
//   earned on 0 of 31 days   -- this UID is not in the game
//   earned on 3 of 31 days   -- this UID earns, rarely
//
// Both render as "zero" in a snapshot, and they are completely different
// answers to "should I register here". Everything below is computed over the
// series, and `days_covered` rides beside every figure so a reader can tell how
// much series there was.
//
// ## DESCRIPTIVE ONLY -- NO SCORE, NO GRADE
//
// There is deliberately no fairness score here. A high Gini on a subnet whose
// task genuinely has one best answer is not misconduct, and the same number on
// a subnet that claims broad participation is damning; the difference is
// context this module does not have. It publishes the distribution and stops.
// See apps/ui/content/docs/attribution-method.mdx, rule 6.
//
// Pure shaping only, like src/emission-split.ts: rows arrive from
// workers/data-api.ts, so the same rows always produce the same payload.
import {
  computeConcentration,
  groupByEntity,
  type ConcentrationScorecard,
} from "./concentration.ts";
import {
  nonNegativeCellOrNull,
  raoBigToTao,
  round9,
  toRaoBig,
} from "./lib/rao.ts";
import {
  DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW,
  SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
} from "./route-limits.ts";

type Row = Record<string, unknown>;

/** Same cap and rationale as the emission-split read over the same table. */
export const MINER_FAIRNESS_ROW_CAP = 50_000;

export const SUBNET_MINER_FAIRNESS_FIELD_SOURCES = {
  days_covered: { kind: "measured", storage: "neuron_daily" },
  "points.miner_count": { kind: "measured", storage: "neuron_daily" },
  "points.earning_miner_count": { kind: "measured", storage: "neuron_daily" },
  "points.zero_emission_pct": { kind: "measured", storage: "neuron_daily" },
  "persistence.never_earned_count": {
    kind: "measured",
    storage: "neuron_daily",
  },
  "persistence.median_earning_days": {
    kind: "measured",
    storage: "neuron_daily",
  },
  "concentration.entity": { kind: "measured", storage: "neuron_daily" },
  "concentration.uid": { kind: "measured", storage: "neuron_daily" },
  uids_per_entity: { kind: "measured", storage: "neuron_daily" },
} as const;

/** Postgres `true` vs the SQLite double's `1`. Same coercion and same reason as
 * src/emission-split.ts: a `validator_permit` misread moves a UID between the
 * two populations this module exists to separate. */
function isValidator(value: unknown): boolean {
  return value === true || Number(value) === 1;
}

/** Parse `?window`. Shares the emission-split vocabulary because it is the same
 * table over the same days. */
export function parseMinerFairnessWindow(
  value: unknown,
):
  | { label: string; days: number; error?: undefined }
  | { error: { parameter: string; message: string } } {
  const v =
    typeof value === "string" && value
      ? value
      : DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW;
  if (
    !Object.prototype.hasOwnProperty.call(
      SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
      v,
    )
  ) {
    return {
      error: {
        parameter: "window",
        message: `window must be one of: ${Object.keys(
          SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
        ).join(", ")}.`,
      },
    };
  }
  return { label: v, days: SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS[v] };
}

/** The window label a payload carries, defaulted. Extracted so the `??` arm is
 * reachable from a test rather than being an unexercised branch. */
export function minerFairnessWindowLabel(
  window: string | null | undefined,
): string {
  return window ?? DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW;
}

/** The median of a numeric list, or null on an empty one. Null rather than 0:
 * the median of nothing is not zero, and zero here would read as "the typical
 * miner earned on no days". */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One day's miner population and how much of it earned.
 *
 * MINERS ONLY. A validator-permit UID earns dividends by a different mechanism
 * and including them would dilute exactly the rate this card exists to show.
 */
function fairnessPoint(date: string, dayRows: Row[]): Row {
  let minerCount = 0;
  let earningCount = 0;
  for (const row of dayRows) {
    if (isValidator(row?.validator_permit)) continue;
    minerCount += 1;
    if ((nonNegativeCellOrNull(row?.emission_tao) ?? 0) > 0) earningCount += 1;
  }
  return {
    snapshot_date: date,
    miner_count: minerCount,
    earning_miner_count: earningCount,
    // Null rather than 0 on a day with no miner UIDs at all: 0% on an empty
    // population reads as "everybody earned".
    zero_emission_pct:
      minerCount > 0 ? round9((minerCount - earningCount) / minerCount) : null,
  };
}

/**
 * Build the miner-fairness card from `neuron_daily` rows ordered
 * `snapshot_date DESC`.
 *
 * Null-safe: a cold or absent store yields `days_covered: 0` and null
 * distributions, never a throw and never a 404.
 */
export function buildSubnetMinerFairness(
  rows: Row[] | null | undefined,
  netuid: unknown,
  { window, capped }: { window?: string; capped?: boolean } = {},
): Row {
  const list = Array.isArray(rows) ? rows : [];

  const byDate = new Map<string, Row[]>();
  for (const row of list) {
    const date = row?.snapshot_date;
    if (typeof date !== "string" || !date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)?.push(row);
  }
  let days = [...byDate.entries()];
  // The cap truncated the oldest day mid-population, so its miner count is
  // short and every rate derived from it is wrong in the flattering direction.
  if (capped && days.length > 1) days = days.slice(0, -1);

  const points = days.map(([date, dayRows]) => fairnessPoint(date, dayRows));

  // ── Persistence: the fact a snapshot cannot report ──────────────────────
  // How many DAYS each miner UID earned on, keyed by uid. A UID that earned
  // once in 31 days and one that never earned are the same "zero" in a
  // snapshot and different answers to "should I register here".
  const earningDays = new Map<number, number>();
  const seenDays = new Map<number, number>();
  // Emission summed per UID across the window, in rao space -- the input to
  // the per-UID lens below. Float `+=` over a month of values drifts.
  const uidRao = new Map<number, bigint>();
  const coldkeyByUid = new Map<number, unknown>();
  const dayKeys = new Set(days.map(([date]) => date));
  for (const row of list) {
    if (typeof row?.snapshot_date !== "string") continue;
    // Respect the dropped capped day: a UID seen only there would report a
    // denominator the points array does not contain.
    if (!dayKeys.has(row.snapshot_date)) continue;
    if (isValidator(row?.validator_permit)) continue;
    const uid = Number(row?.uid);
    if (!Number.isFinite(uid)) continue;
    seenDays.set(uid, (seenDays.get(uid) ?? 0) + 1);
    coldkeyByUid.set(uid, row?.coldkey);
    const emission = nonNegativeCellOrNull(row?.emission_tao) ?? 0;
    if (emission > 0) {
      earningDays.set(uid, (earningDays.get(uid) ?? 0) + 1);
      uidRao.set(uid, (uidRao.get(uid) ?? 0n) + toRaoBig(emission));
    }
  }

  const minerUids = [...seenDays.keys()];
  const earnedCounts = minerUids.map((uid) => earningDays.get(uid) ?? 0);
  const neverEarned = earnedCounts.filter((n) => n === 0).length;
  const everyDay = minerUids.filter(
    (uid) => (earningDays.get(uid) ?? 0) === seenDays.get(uid),
  ).length;

  // ── Concentration, over the window's summed emission ─────────────────────
  // The ENTITY lens is the headline. A subnet with three operators behind 256
  // UIDs is not diverse, and the per-UID Gini alone hides that -- so the
  // per-UID figure is published beside it rather than instead of it.
  //
  // computeConcentration and groupByEntity are IMPORTED, not reimplemented:
  // src/concentration.ts already ships gini/hhi/nakamoto/topShares/entropy and
  // a second copy of any of them is how two surfaces start disagreeing about
  // the same subnet.
  const windowRows = minerUids.map((uid) => ({
    coldkey: coldkeyByUid.get(uid),
    emission_tao: raoBigToTao(uidRao.get(uid) ?? 0n),
  }));
  const entities = groupByEntity(windowRows);
  const uidLens = computeConcentration(windowRows.map((r) => r.emission_tao));
  const entityLens = computeConcentration(entities.emission);

  return {
    schema_version: 1,
    netuid,
    window: minerFairnessWindowLabel(window),
    // Beside every figure, per the issue's first "Do". A distribution over 3
    // days and one over 31 are not the same claim, and an array length read as
    // a month is the failure this reports its way out of.
    days_covered: points.length,
    point_count: points.length,
    points,
    miner_uid_count: minerUids.length,
    persistence: {
      never_earned_count: neverEarned,
      earned_every_day_count: everyDay,
      // The typical miner's experience, in days. Null on an empty population.
      median_earning_days: median(earnedCounts),
      max_earning_days: earnedCounts.length ? Math.max(...earnedCounts) : null,
    },
    entity_count: entities.count,
    // A Sybil/consolidation signal: 1.0 = every UID a distinct owner; higher =
    // fewer operators each running many hotkeys.
    uids_per_entity:
      entities.count > 0 ? round9(minerUids.length / entities.count) : null,
    concentration: {
      entity: entityLens as ConcentrationScorecard | null,
      uid: uidLens as ConcentrationScorecard | null,
    },
    field_sources: SUBNET_MINER_FAIRNESS_FIELD_SOURCES,
  };
}
