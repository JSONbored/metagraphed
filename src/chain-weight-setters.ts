// Network-wide weight-setter leaderboard: across EVERY subnet over a 7d/30d window, the
// individual validators driving consensus network-wide — each setter's total WeightsSet event
// count (summed across every subnet it operates on), its share of the network total, and when it
// first/last set weights in the window — ranked by activity. The network-wide drill-in behind
// /api/v1/chain/weights, which only reports the aggregate (distinct setters + total events +
// intensity per subnet) and never names the setters across the whole network — the same relationship
// /api/v1/subnets/{netuid}/weights/setters has to its own /weights. Read live from the account_events
// WeightsSet stream. Pure shaping (buildChainWeightSetters); the Worker / data-api Postgres tier
// supplies the rows and adds the envelope. Null-safe: a cold store yields a schema-stable empty
// leaderboard.
//
// The D1 loader (loadChainWeightSetters) was removed — account_events' D1 write path is retired
// and the table is dropped in production (#4772 / #4909), so serving goes tryPostgresTier →
// schema-stable empty stub, never D1.

// Supported windows (label -> days) + default, matching the sibling /chain/weights route.
export const CHAIN_WEIGHT_SETTERS_WINDOWS = { "7d": 7, "30d": 30 };
export const DEFAULT_CHAIN_WEIGHT_SETTERS_WINDOW = "7d";
export const CHAIN_WEIGHT_SETTERS_LIMIT_DEFAULT = 20;
export const CHAIN_WEIGHT_SETTERS_LIMIT_MAX = 100;

// WeightsSet ingestion can omit hotkey, so a setter is identified by its hotkey when present
// (a hotkey is a network-wide identity, so this correctly merges one validator's activity across
// every subnet it sets weights on), else by its (netuid, uid) — a uid alone has no meaning outside
// its own subnet, so a uid-only setter stays scoped to the subnet it was observed on, exactly
// mirroring the sibling subnet-weight-setters.mjs identity. Rows whose identity is NULL (no hotkey
// AND no uid) are excluded from the leaderboard rather than collapsed into one bogus setter.

// Round a share to a stable 4dp precision WITHOUT letting a sub-1 share round up to an exact 1 —
// a setter that drove < 100% of the network's weight-setting must not read as a flat 1 while
// another setter still holds activity (e.g. 49999/50000 = 0.99998 -> 1.0000). Mirrors the
// anti-overstatement guard in subnet-weight-setters.mjs. A genuine sole setter (its count == the
// network total) keeps a true 1.
function round(value: number, dp = 4): number {
  const factor = 10 ** dp;
  const rounded = Math.round(value * factor) / factor;
  return rounded >= 1 && value < 1 ? (factor - 1) / factor : rounded;
}

// A non-negative whole count from a D1 COUNT() cell (number, numeric string, or null),
// defaulting to 0 for anything non-finite or negative.
function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function toUid(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

// A representative uid cell -> non-negative integer, or null when absent/non-integer.
function toNetuid(value: unknown): number | null {
  return toUid(value);
}

// A representative hotkey cell -> non-empty string, or null when absent/blank.
function toHotkey(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

// Newest/oldest epoch-ms observed_at -> ISO, or null when not finite/absent. Guards the JS Date
// range so a finite but out-of-range epoch cannot throw, mirroring the sibling routes.
function toIso(value: unknown): string | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export interface ChainWeightSetter {
  hotkey: string | null;
  netuid: number | null;
  uid: number | null;
  weight_sets: number;
  share: number | null;
  first_set_at: string | null;
  last_set_at: string | null;
}

export interface ChainWeightSettersResult {
  schema_version: 1;
  window: string | null;
  observed_at: string | null;
  distinct_setters: number;
  weight_sets: number;
  setter_count: number;
  setters: ChainWeightSetter[];
}

// Shape the network-wide leaderboard from the per-setter aggregate rows plus the network-wide
// totals row. `rows` are already ordered by activity (newest-first tiebreak) from the loader;
// `totals` carries weight_sets (COUNT(*)), distinct_setters (COUNT(DISTINCT identity)) and
// newest_observed (MAX), all network-wide (no netuid filter). `limit` caps the returned page;
// `distinct_setters` always reports the true network-wide total regardless of `limit`. Each
// setter's share is its count over the network total, null when the total is zero (no rows).
// Null-safe: null/absent inputs yield the schema-stable empty card.
export function buildChainWeightSetters(
  rows: Array<Record<string, unknown>> | null | undefined,
  totals: Record<string, unknown> | null | undefined,
  {
    window,
    limit = CHAIN_WEIGHT_SETTERS_LIMIT_DEFAULT,
  }: { window?: string | null; limit?: number } = {},
): ChainWeightSettersResult {
  const list = Array.isArray(rows) ? rows : [];
  const flooredLimit = Math.floor(Number(limit));
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(0, Math.min(flooredLimit, CHAIN_WEIGHT_SETTERS_LIMIT_MAX))
    : CHAIN_WEIGHT_SETTERS_LIMIT_DEFAULT;
  const totalSets = toCount(totals?.weight_sets);
  const setters: ChainWeightSetter[] = list
    .slice(0, normalizedLimit)
    .map((row) => {
      const weightSets = toCount(row?.weight_sets);
      return {
        hotkey: toHotkey(row?.hotkey),
        netuid: toHotkey(row?.hotkey) == null ? toNetuid(row?.netuid) : null,
        uid: toUid(row?.uid),
        weight_sets: weightSets,
        share: totalSets > 0 ? round(weightSets / totalSets) : null,
        first_set_at: toIso(row?.first_set),
        last_set_at: toIso(row?.last_set),
      };
    });
  return {
    schema_version: 1,
    window: window ?? null,
    observed_at: toIso(totals?.newest_observed),
    distinct_setters: toCount(totals?.distinct_setters),
    weight_sets: totalSets,
    setter_count: setters.length,
    setters,
  };
}
