// #10928: who actually receives a subnet's emission -- owner, validators,
// miners -- per day.
//
// The emission pipeline stops at WHICH SUBNET receives what. `miner_burned` is
// a stage-2 down-weight on the whole subnet and `tao_in_emission` vs
// `excess_tao` is a channel split; neither is a recipient split. Nothing in the
// tree bridged "subnet X received Y" to "and here is who got it", which is the
// denominator every fairness, capture and cost question needs.
//
// ## THE OWNER LEG IS NOT IN THE ROWS, AND THAT IS THE WHOLE SUBTLETY
//
// `neuron_daily` carries per-UID emission for the UID set. The subnet owner's
// cut is paid OUTSIDE that set, so summing the rows yields the validator and
// miner legs only. Measured 2026-08-12 across 128 subnets: the per-UID sum is
// exactly `alpha_out_per_block x tempo x (1 - OWNER_CUT)` -- for a subnet with
// `alpha_out_emission: 1` and `tempo: 360` the sum is 295.2016 alpha and the
// implied per-tempo total is 360.0000. The missing 18% IS the owner cut.
//
// A split that summed only the rows would therefore publish shares of 82% of
// the emission while calling them shares of the emission -- losing the owner
// leg silently, which is the one leg the epic exists to expose.
//
// ## WHY THE ABSOLUTE LEG DOES NOT COME FROM TEMPO
//
// The obvious reconstruction -- per-tempo rate x tempos-per-day -- is wrong on
// any subnet whose tempo is not the default. SN1 runs `tempo: 99` against the
// usual 360, so that arithmetic would be off by 3.6x there while looking
// entirely plausible everywhere else. The daily total instead comes from
// `subnet_snapshots.alpha_out_emission x BLOCKS_PER_DAY`, which is the same
// basis `/owner-cut` already uses -- so the two surfaces cannot disagree about
// what a day of emission is.
//
// ## WHAT IS MEASURED AND WHAT IS RECONSTRUCTED
//
// The SHARES between validator and miner are exact and parameter-free: they are
// ratios of observed per-UID sums. The owner share, and every absolute
// alpha/TAO figure, are RECONSTRUCTED -- they apply the effective owner cut and
// the day's `alpha_out_emission`. `field_sources` says so per field rather than
// leaving a reader to assume the whole card is a reading.
//
// Pure shaping only. The rows arrive from workers/data-api.ts (the DATA_API
// tier owns the SQL for every neuron_daily-derived series); this module never
// touches a store, so the same rows always produce the same payload.

import {
  nonNegativeCellOrNull,
  raoBigToTao,
  round9,
  toRaoBig,
} from "./lib/rao.ts";
import { BLOCKS_PER_DAY, OWNER_CUT } from "./revenue-coverage.ts";
import {
  DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW,
  SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
} from "./route-limits.ts";

type Row = Record<string, unknown>;

// BLOCKS_PER_DAY and OWNER_CUT are IMPORTED, not restated. They are chain
// constants that happen to live in revenue-coverage.ts, and `/owner-cut`,
// `/revenue` and this route must agree on both or their figures silently stop
// reconciling -- OWNER_CUT in particular is 11796/65535 (18%), NOT 1/6, a
// distinction worth ~6 TAO/day on SN64 that a second copy is free to get wrong.
//
// The storage item is UNSET on chain, so OWNER_CUT is the runtime default
// rather than a read -- which is why every field derived from it is published
// as `reconstructed`.

/** Safety valve on the raw per-UID read. ~256 UIDs x 90d ~= 23k, so this leaves
 * head room, and the builder drops a truncated oldest day so every published
 * point covers a whole day. Mirrors YIELD_HISTORY_ROW_CAP, whose read is the
 * same shape over the same table. */
export const EMISSION_SPLIT_HISTORY_ROW_CAP = 50_000;

// A finite, non-negative numeric cell, or null when absent/blank/non-numeric.
// Blank cells coerce via Number("") -> 0, and a fabricated zero is a
// measurement this module must never invent.

/**
 * Postgres and the SQLite double answer booleans differently (`true` vs `1`),
 * and a `validator_permit` misread flips a UID between the two legs it is the
 * whole point of this module to separate. Mirrors the `Number(...) === 1`
 * coercion src/subnet-yield.ts uses on the same column, widened to accept the
 * boolean Postgres actually returns.
 */
function isValidator(value: unknown): boolean {
  return value === true || Number(value) === 1;
}

/** Parse `?window` for the history route. Returns `{label, days}` or the
 * `analyticsQueryError` shape, matching parseSubnetYieldHistoryWindow so the
 * MCP and GraphQL surfaces validate identically to REST. */
export function parseEmissionSplitHistoryWindow(
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
        ).join(", ")}`,
      },
    };
  }
  return { label: v, days: SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS[v] };
}

/**
 * The window label a caller asked for, defaulted.
 *
 * Exported and unit-tested rather than inlined at the call site. The GraphQL
 * resolver's `window` argument is resolved by `parseArgumentsAtDispatch`
 * against the route's published query schema, so in production the fallback
 * arm is unreachable -- measured: never taken across the whole suite. An
 * unreachable branch inside a resolver cannot be proven either way, and
 * a v8-ignore hint does not exempt it from codecov/patch, so the guard lives
 * here where a test can drive both arms directly.
 */
export function emissionSplitWindowLabel(
  window: string | null | undefined,
): string {
  return window ?? DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW;
}

/** Per-field provenance. The shares between validator and miner are ratios of
 * observed sums; everything carrying the owner cut or a day's
 * `alpha_out_emission` is a reconstruction over a runtime default. */
export const SUBNET_EMISSION_SPLIT_FIELD_SOURCES = {
  "points.validator_alpha": {
    kind: "measured",
    storage: "neuron_daily.emission_tao",
  },
  "points.burned_alpha": {
    kind: "measured",
    storage: "SubtensorModule.SubnetOwnerHotkey",
  },
  "points.burned_share_of_uid": { kind: "reconstructed", storage: null },
  "points.miner_alpha": {
    kind: "measured",
    storage: "neuron_daily.emission_tao",
  },
  "points.uid_alpha": {
    kind: "measured",
    storage: "neuron_daily.emission_tao",
  },
  "points.validator_share_of_uid": { kind: "measured", storage: null },
  "points.miner_share_of_uid": { kind: "measured", storage: null },
  "points.owner_alpha": { kind: "reconstructed", storage: null },
  "points.total_alpha": { kind: "reconstructed", storage: null },
  "points.owner_share": { kind: "reconstructed", storage: null },
  "points.validator_share": { kind: "reconstructed", storage: null },
  "points.miner_share": { kind: "reconstructed", storage: null },
  "points.total_tao": { kind: "reconstructed", storage: null },
} as const;

/**
 * One day's rows projected to a flat, chartable point.
 *
 * Flat rather than nested, because the CSV column list and a chart both consume
 * it flat -- the same reason yieldHistoryPoint is flat.
 *
 * A day whose `alpha_out_emission` is unknown still publishes the MEASURED
 * legs and their exact ratio, with every reconstructed field null. A subnet's
 * validator/miner split is a real answer even when the day's total is not
 * known, and nulling the measured half to match would discard a reading we
 * have.
 */
function emissionSplitPoint(
  date: string,
  dayRows: Row[],
  ownerCut: number,
  burnHotkey?: string | null,
): Row {
  let validatorRao = 0n;
  let minerRao = 0n;
  let burnedRao = 0n;
  let validatorCount = 0;
  let minerCount = 0;
  let earningValidatorCount = 0;
  let earningMinerCount = 0;
  let alphaOutPerBlock: number | null = null;
  let alphaPriceTao: number | null = null;

  for (const row of dayRows) {
    // Carried on every row of the day by the join; take the first non-null
    // rather than assuming row order.
    alphaOutPerBlock ??= nonNegativeCellOrNull(row?.alpha_out_emission);
    alphaPriceTao ??= nonNegativeCellOrNull(row?.alpha_price_tao);

    const emission = nonNegativeCellOrNull(row?.emission_tao);
    // A row with no emission cell is still a registered UID -- it counts toward
    // the population, and toward "earning zero", which is the fact #10931
    // reads off this. Skipping it would shrink the denominator and overstate
    // how many UIDs earn.
    const rao = emission === null ? 0n : toRaoBig(emission);
    // #11094: the burn sink is not a miner. The SubnetOwnerHotkey UID carries
    // the MinerBurned fraction as incentive, so folding it into the miner leg
    // overstated what miners receive by 1/(1-burn). Its own leg, beside the
    // two real ones -- and it does not count toward either population.
    if (burnHotkey != null && row?.hotkey === burnHotkey) {
      burnedRao += rao;
      continue;
    }
    if (isValidator(row?.validator_permit)) {
      validatorCount += 1;
      validatorRao += rao;
      if (rao > 0n) earningValidatorCount += 1;
    } else {
      minerCount += 1;
      minerRao += rao;
      if (rao > 0n) earningMinerCount += 1;
    }
  }

  const validatorAlpha = raoBigToTao(validatorRao);
  const minerAlpha = raoBigToTao(minerRao);
  const burnedAlpha = raoBigToTao(burnedRao);
  const uidAlpha = raoBigToTao(validatorRao + minerRao + burnedRao);

  // Exact and parameter-free: the split of what was observed. Null rather than
  // 0/0 when the day emitted nothing -- a subnet the gate is emitting nothing
  // to has no split, and 0 would read as "validators got none of it".
  const validatorShareOfUid =
    uidAlpha > 0 ? round9(validatorAlpha / uidAlpha) : null;
  const minerShareOfUid = uidAlpha > 0 ? round9(minerAlpha / uidAlpha) : null;
  const burnedShareOfUid = uidAlpha > 0 ? round9(burnedAlpha / uidAlpha) : null;

  // The reconstructed half. `alpha_out_emission` is alpha per block; a day is
  // BLOCKS_PER_DAY of them, and the owner takes `ownerCut` of that. Computed as
  // one guarded object so the null case is expressed once rather than repeated
  // per field -- and so nothing needs a non-null assertion to typecheck.
  const totals =
    alphaOutPerBlock === null
      ? null
      : (() => {
          const total = alphaOutPerBlock * BLOCKS_PER_DAY;
          const owner = total * ownerCut;
          return { total, owner, distributable: total - owner };
        })();

  return {
    snapshot_date: date,
    neuron_count: validatorCount + minerCount,
    validator_count: validatorCount,
    miner_count: minerCount,
    earning_validator_count: earningValidatorCount,
    earning_miner_count: earningMinerCount,
    validator_alpha: round9(validatorAlpha),
    miner_alpha: round9(minerAlpha),
    burned_alpha: round9(burnedAlpha),
    uid_alpha: round9(uidAlpha),
    validator_share_of_uid: validatorShareOfUid,
    miner_share_of_uid: minerShareOfUid,
    burned_share_of_uid: burnedShareOfUid,
    owner_cut: round9(ownerCut),
    total_alpha: totals === null ? null : round9(totals.total),
    owner_alpha: totals === null ? null : round9(totals.owner),
    // Shares OF THE WHOLE DAY, including the owner leg, so the three sum to 1.
    owner_share: totals === null ? null : round9(ownerCut),
    validator_share:
      totals === null || validatorShareOfUid === null
        ? null
        : round9((totals.distributable / totals.total) * validatorShareOfUid),
    miner_share:
      totals === null || minerShareOfUid === null
        ? null
        : round9((totals.distributable / totals.total) * minerShareOfUid),
    alpha_price_tao: alphaPriceTao,
    total_tao:
      totals === null || alphaPriceTao === null
        ? null
        : round9(totals.total * alphaPriceTao),
  };
}

/**
 * Build the per-day recipient split (newest first) from `neuron_daily` rows
 * already ordered `snapshot_date DESC`.
 *
 * `capped` (the read hit the row cap) drops the oldest day, which the cap
 * truncated mid-population -- publishing it would understate that day's neuron
 * count and every share derived from it.
 *
 * Null-safe: a cold or absent store yields `point_count: 0`, never a throw and
 * never a 404. A subnet with no daily rollup is a real state.
 */
export function buildSubnetEmissionSplitHistory(
  rows: Row[] | null | undefined,
  netuid: unknown,
  {
    window,
    capped,
    ownerCut = OWNER_CUT,
    burnHotkey,
  }: {
    window?: string;
    capped?: boolean;
    ownerCut?: number;
    burnHotkey?: string | null;
  } = {},
): Row {
  const list = Array.isArray(rows) ? rows : [];
  // Rows arrive newest-first with same-date rows contiguous, so Map insertion
  // order is already the newest-first date order.
  const byDate = new Map<string, Row[]>();
  for (const row of list) {
    const date = row?.snapshot_date;
    if (typeof date !== "string" || !date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)?.push(row);
  }
  // Iterate the ENTRIES, not the keys: `byDate.get(date) ?? []` would leave a
  // `??` arm nothing can reach, and an unreachable branch reads as a tested one.
  let days = [...byDate.entries()];
  if (capped && days.length > 1) days = days.slice(0, -1);
  const effectiveCut =
    Number.isFinite(ownerCut) && ownerCut >= 0 && ownerCut <= 1
      ? ownerCut
      : OWNER_CUT;
  const points = days.map(([date, dayRows]) =>
    emissionSplitPoint(date, dayRows, effectiveCut, burnHotkey),
  );
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    point_count: points.length,
    points,
    // Emitted by the BUILDER, not by each handler, so REST, MCP and GraphQL
    // publish byte-identical provenance. A per-surface copy is how one of them
    // ends up quietly claiming a reconstruction is a reading.
    field_sources: SUBNET_EMISSION_SPLIT_FIELD_SOURCES,
  };
}
