// Nominator counts per validator hotkey (#2549) -- one row per hotkey, latest
// only, refreshed by its own low-frequency job (scripts/fetch-validator-
// nominator-counts.py, see migrations/0043_validator_nominator_counts.sql for
// why this is a separate side table rather than a neurons column). Read/join
// lands here; the fetch/sync write path lives in workers/data-api.mjs
// (handleValidatorNominatorCountsSync), mirroring account-identity.mjs's role
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
