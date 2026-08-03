// Nominator counts per validator hotkey (#2549) -- one row per hotkey, latest
// only, refreshed by its own low-frequency job (scripts/fetch-validator-
// nominator-counts.py, see migrations/0043_validator_nominator_counts.sql for
// why this is a separate side table rather than a neurons column). Read/join
// lands here; the fetch/sync write path lives in workers/data-api.ts
// (handleValidatorNominatorCountsSync), mirroring account-identity.ts's role
// for its own sync handler.

type Row = Record<string, unknown>;

export const VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS = [
  "hotkey",
  "nominator_count",
  "captured_at",
];

// hotkey -> { nominator_count, captured_at } lookup built from a Postgres
// query result, for joining into buildGlobalValidators/buildValidatorDetail
// at serve time. Null-safe on a cold/absent table (returns an empty Map, so
// every join lookup misses and nominator_count serves as null -- never
// throws, mirrors overlayFeaturedValidators' cold-safety).
export function nominatorCountsByHotkey(
  rows: Row[] | null | undefined,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const hotkey = typeof row?.hotkey === "string" ? row.hotkey : null;
    if (!hotkey) continue;
    // Guard null/undefined explicitly before the Number() coercion below --
    // Number(null) is 0, so a missing count would otherwise silently pass as
    // a confirmed "zero nominators" instead of being skipped as unknown.
    if (row?.nominator_count == null) continue;
    const count = Number(row.nominator_count);
    if (!Number.isInteger(count) || count < 0) continue;
    map.set(hotkey, count);
  }
  return map;
}

// --- Serve-time overlay (#9146) ---------------------------------------------
//
// The map above was built for the Postgres dispatcher, which passed it INTO
// buildGlobalValidators/buildValidatorDetail alongside the neuron rows. The D1
// twins that replaced those routes have no such table to read (workers/
// data-api.ts hands both builders an empty map / a null count), and the
// lakehouse mirror they could read lives on the MAIN Worker's R2 SQL binding,
// not data-api's -- so by the time a payload reaches a serving surface it is
// already built and `nominator_count` is already null on every row.
//
// Hence an overlay rather than a builder argument: the same shape and the same
// point of application as overlayFeaturedValidators (src/metagraph-neurons.ts),
// applied ONCE where the tiers converge rather than duplicated per tier.

type ValidatorRow = Record<string, unknown>;

/**
 * Apply `fn` to every entry of a validator payload that carries a
 * `nominator_count`, rebuilding the payload around the results.
 *
 * ONE dispatch for TWO shapes, stated here once: the leaderboard
 * (GlobalValidatorsArtifact) holds its entries in `validators`, while the
 * single-hotkey detail IS the entry. Both the hotkey collection and the overlay
 * below need that distinction, and restating it in each is how the two would
 * drift onto different notions of "an entry". Anything else -- a null body, a
 * malformed tier response, an object with neither shape -- passes through
 * untouched, matching overlayFeaturedValidators' own tolerance for a body it
 * does not recognise.
 */
function mapValidatorEntries(
  data: unknown,
  fn: (row: ValidatorRow) => ValidatorRow,
): unknown {
  if (!data || typeof data !== "object") return data;
  const row = data as ValidatorRow;
  if (Array.isArray(row.validators)) {
    return { ...row, validators: (row.validators as ValidatorRow[]).map(fn) };
  }
  return typeof row.hotkey === "string" ? fn(row) : row;
}

/**
 * The hotkeys in a validator payload whose `nominator_count` is still unknown.
 *
 * Filtered to the MISSING ones on purpose, so the overlay is strictly additive:
 * a tier that already answered with real counts costs no lakehouse read and can
 * never have a fresher value replaced by a staler one.
 */
export function validatorHotkeysNeedingCount(data: unknown): string[] {
  const hotkeys: string[] = [];
  mapValidatorEntries(data, (row) => {
    if (
      typeof row?.hotkey === "string" &&
      row.hotkey.length > 0 &&
      row.nominator_count == null
    ) {
      hotkeys.push(row.hotkey);
    }
    return row;
  });
  return hotkeys;
}

/**
 * Fill `nominator_count` from a hotkey -> count map, on the leaderboard or on a
 * single validator's detail.
 *
 * A hotkey the map MISSES keeps whatever the payload already had (null, in
 * practice) rather than being written to null: "unknown" and "confirmed zero"
 * stay distinguishable, which is the same reason the builders never default the
 * field to 0. A count of 0 IS applied -- it is an answer, not an absence.
 */
export function overlayNominatorCounts<T>(
  data: T,
  counts: Map<string, number>,
): T {
  if (counts.size === 0) return data;
  return mapValidatorEntries(data, (row) => {
    const count =
      typeof row?.hotkey === "string" ? counts.get(row.hotkey) : undefined;
    return count === undefined ? row : { ...row, nominator_count: count };
  }) as T;
}

/**
 * Fill a confirmed ZERO for every hotkey the batch covered but the counts
 * table has no row for -- but only when the scan behind it is fresh (#9314).
 *
 * The producer emits a row only for hotkeys it saw holding stake in
 * SubtensorModule::Alpha, and it has never once recorded a zero: measured
 * 2026-08-03, `WHERE nominator_count = 0` returned nothing across 112,550
 * rows. So 471 of the 1,028 permitted validators had no row and read as
 * "unknown", which understated what we actually know -- the pass over Alpha is
 * EXHAUSTIVE, so a permitted validator missing from a completed one genuinely
 * has zero distinct coldkeys staked to it.
 *
 * THE FRESHNESS GATE IS WHAT MAKES THAT INFERENCE SAFE. Against a stale or
 * truncated table the same absence means "we have not looked recently", and
 * publishing 0 for it would be a confident wrong number -- the failure this
 * family's own doctrine calls worse than an absent one. `thresholdMs` is
 * passed in rather than imported so this module stays dependency-free and the
 * caller can hand it the same constant the staleness watchdog alarms on.
 *
 * `rows` carry the scan stamp on `scan_at` (a scalar subselect, so every row
 * repeats one value). No rows, or no usable stamp, means there is no scan to
 * trust and nothing is filled.
 */
export function fillConfirmedZeros(
  rows: Row[] | null | undefined,
  counts: Map<string, number>,
  nowMs: number,
  thresholdMs: number,
): Map<string, number> {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return counts;
  const scanAt = Number(list[0]?.scan_at);
  // Number(null) is 0, so an absent stamp reads as the epoch and fails the
  // freshness check below rather than sneaking through as a valid instant --
  // but a non-numeric one has to be rejected explicitly.
  if (!Number.isFinite(scanAt)) return counts;
  if (nowMs - scanAt > thresholdMs) return counts;
  for (const row of list) {
    const hotkey = typeof row?.hotkey === "string" ? row.hotkey : null;
    if (hotkey && !counts.has(hotkey)) counts.set(hotkey, 0);
  }
  return counts;
}
