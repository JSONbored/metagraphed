// Per-account weight-setting footprint: which subnets one account (hotkey/validator) set weights
// on over a recent window, broken down per subnet and rolled up into a weight-setting scorecard.
// Pure shaping (buildAccountWeightSetters) + a thin D1 loader (loadAccountWeightSetters); the
// Worker adds the REST envelope. Null-safe: a cold store or an empty window yields schema-stable
// zeros (never throws), matching the sibling account tiers (registrations, stake-moves).
//
// This is the account-level companion of the per-subnet and network weight-setter leaderboards
// (/api/v1/subnets/{netuid}/weights/setters and /api/v1/chain/weights/setters): those answer "who
// is setting weights on subnet N" / "who are the top weight-setters network-wide", this answers
// "which subnets did THIS validator set weights on, how often, and when" — a per-subnet WeightsSet
// count with the first/last set timestamps, an HHI concentration of where its weight-setting
// activity is focused, and the dominant subnet. WeightsSet is a validator (hotkey) submitting its
// weight vector for a subnet's consensus, so — like registrations and stake-moves — this is keyed
// on the hotkey. Only 7d/30d windows are supported (matching the sibling chain/subnet weight-setter
// routes): WeightsSet fires every tempo, so a 90d window would be an unbounded row scan.

import { WEIGHTS_EVENT_KIND } from "./chain-weights.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

export { WEIGHTS_EVENT_KIND };
export const ACCOUNT_WEIGHT_SETTERS_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
};
export const DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW = "7d";

function roundConcentration(value: number): number {
  const rounded = Math.round(value * 10000) / 10000;
  return rounded >= 1 && value < 1 ? 0.9999 : rounded;
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizedNetuid(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const netuid = Number(value);
  return Number.isSafeInteger(netuid) && netuid >= 0 ? netuid : null;
}

function coerceEpochMs(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? n : null;
}

function toIso(value: unknown): string | null {
  const n = coerceEpochMs(value);
  return n == null ? null : new Date(n).toISOString();
}

export interface AccountWeightSetterSubnet {
  netuid: number;
  weight_sets: number;
  first_set_at: string | null;
  last_set_at: string | null;
}

export interface AccountWeightSettersResult {
  schema_version: 1;
  address: string;
  window: string | null;
  total_weight_sets: number;
  subnet_count: number;
  concentration: number | null;
  dominant_netuid: number | null;
  subnets: AccountWeightSetterSubnet[];
}

// Shape an account's per-netuid WeightsSet aggregate into a weight-setting scorecard. `rows` is the
// GROUP BY netuid result (netuid, weight_sets, first_observed, last_observed). Null-safe: no rows
// (cold store / empty window) yields a zeroed, empty-subnet card.
export function buildAccountWeightSetters(
  rows: Array<Record<string, unknown>> | null | undefined,
  address: string,
  { window }: { window?: string | null } = {},
): AccountWeightSettersResult {
  const list = Array.isArray(rows) ? rows : [];
  const perSubnet = new Map<
    number,
    { weightSets: number; firstMs: number | null; lastMs: number | null }
  >();
  for (const row of list) {
    const netuid = normalizedNetuid(row?.netuid);
    if (netuid == null) continue;
    const weightSets = toCount(row?.weight_sets);
    if (weightSets === 0) continue;
    const firstMs = coerceEpochMs(row?.first_observed);
    const lastMs = coerceEpochMs(row?.last_observed);
    const bucket = perSubnet.get(netuid) ?? {
      weightSets: 0,
      firstMs: null,
      lastMs: null,
    };
    bucket.weightSets += weightSets;
    if (
      firstMs != null &&
      (bucket.firstMs == null || firstMs < bucket.firstMs)
    ) {
      bucket.firstMs = firstMs;
    }
    if (lastMs != null && (bucket.lastMs == null || lastMs > bucket.lastMs)) {
      bucket.lastMs = lastMs;
    }
    perSubnet.set(netuid, bucket);
  }

  let totalWeightSets = 0;
  let squares = 0;
  const subnets: AccountWeightSetterSubnet[] = [];
  for (const [netuid, b] of perSubnet) {
    totalWeightSets += b.weightSets;
    squares += b.weightSets * b.weightSets;
    subnets.push({
      netuid,
      weight_sets: b.weightSets,
      first_set_at:
        b.firstMs == null ? null : new Date(b.firstMs).toISOString(),
      last_set_at: b.lastMs == null ? null : new Date(b.lastMs).toISOString(),
    });
  }
  subnets.sort((a, b) => b.weight_sets - a.weight_sets || a.netuid - b.netuid);
  const dominantNetuid = subnets.length > 0 ? subnets[0].netuid : null;
  const concentration =
    totalWeightSets > 0
      ? roundConcentration(squares / (totalWeightSets * totalWeightSets))
      : null;

  return {
    schema_version: 1,
    address,
    window: window ?? null,
    total_weight_sets: totalWeightSets,
    subnet_count: subnets.length,
    concentration,
    dominant_netuid: dominantNetuid,
    subnets,
  };
}

// One account's weight-setting footprint — reads its WeightsSet events from account_events over the
// window (observed_at >= now - windowDays, epoch ms), grouped per subnet, shaped with
// buildAccountWeightSetters. WeightsSet ingestion can omit hotkey and store only (netuid, uid),
// so fall back through the latest neurons snapshot for those hotkey-less rows instead of silently
// dropping the validator's activity. Keep the direct hotkey branch pinned to the hotkey index and
// the uid fallback pinned to (netuid, uid, event_kind, observed_at); a single OR across account_events
// and neurons makes SQLite scan the whole recent WeightsSet window for each public account lookup.
// Returns { data, generatedAt } where generatedAt is the newest weight-set's observed_at as an ISO
// string (string|null per the envelope contract). Cold/absent D1 -> zeroed card + null.
export async function loadAccountWeightSetters(
  d1: (
    sql: string,
    params: unknown[],
  ) => Promise<Array<Record<string, unknown>>>,
  address: string,
  {
    windowLabel = DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW,
  }: { windowLabel?: string } = {},
): Promise<{
  data: AccountWeightSettersResult;
  generatedAt: string | null;
}> {
  const days =
    ACCOUNT_WEIGHT_SETTERS_WINDOWS[windowLabel] ??
    ACCOUNT_WEIGHT_SETTERS_WINDOWS[DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW];
  const cutoff = Date.now() - days * DAY_MS;
  const rows = await d1(
    "SELECT netuid, COUNT(*) AS weight_sets, MIN(observed_at) AS first_observed, " +
      "MAX(observed_at) AS last_observed FROM (" +
      "SELECT netuid, observed_at " +
      "FROM account_events INDEXED BY idx_account_events_hotkey " +
      "WHERE hotkey = ? AND event_kind = ? AND observed_at >= ? " +
      "UNION ALL " +
      "SELECT e.netuid, e.observed_at " +
      "FROM neurons n INDEXED BY idx_neurons_hotkey " +
      "JOIN account_events e INDEXED BY idx_account_events_netuid_uid_kind_observed " +
      "ON e.netuid = n.netuid AND e.uid = n.uid " +
      "WHERE n.hotkey = ? AND e.event_kind = ? AND e.observed_at >= ? " +
      "AND (e.hotkey IS NULL OR e.hotkey = '')" +
      ") GROUP BY netuid",
    [address, WEIGHTS_EVENT_KIND, cutoff, address, WEIGHTS_EVENT_KIND, cutoff],
  );
  let latestObserved: number | null = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const observed = coerceEpochMs(row?.last_observed);
    if (
      observed != null &&
      (latestObserved == null || observed > latestObserved)
    ) {
      latestObserved = observed;
    }
  }
  return {
    data: buildAccountWeightSetters(rows, address, { window: windowLabel }),
    generatedAt: toIso(latestObserved),
  };
}
