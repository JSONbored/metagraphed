// Per-account deregistration footprint: which subnets one account (hotkey) was deregistered
// (evicted) from over a recent window, broken down per subnet and rolled up into a deregistration
// scorecard. Pure shaping (buildAccountDeregistrations) + a thin D1 loader
// (loadAccountDeregistrations); the Worker adds the REST envelope. Null-safe: a cold store or an
// empty window yields schema-stable zeros (never throws), matching the sibling account tiers
// (stake-flow, registrations, serving, counterparties).
//
// This is the account-level companion of the per-subnet and network deregistration leaderboards
// (/api/v1/subnets/{netuid}/deregistrations and /api/v1/chain/deregistrations): those answer "who
// was evicted from subnet N" / "which subnets churn the most neurons", this answers "which subnets
// was THIS account evicted from, how often, and when" — a per-subnet NeuronDeregistered count with
// the first/last eviction timestamps, an HHI concentration of where its deregistration activity is
// focused, and the dominant subnet. The eviction-side complement to
// /accounts/{ss58}/registrations (registration events) — an account registers, is deregistered,
// re-registers; this is the exit leg of that lifecycle, not shown by /accounts/{ss58}/subnets
// (current registration state).

const DAY_MS = 24 * 60 * 60 * 1000;

// The account_events kind emitted when a neuron is deregistered (evicted) from a subnet's UID set;
// always carries the evicted hotkey (scripts/fetch-events.py _registered -> [netuid, uid, hotkey]).
export const DEREGISTRATION_EVENT_KIND = "NeuronDeregistered";

// Supported windows (label -> days) + default, the same set the account stake-flow route exposes.
export const DEREGISTRATION_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
export const DEFAULT_DEREGISTRATION_WINDOW = "30d";

// Round the HHI concentration ratio to 4 decimals WITHOUT letting a sub-perfect value round up to
// an exact 1 — the same anti-overstatement invariant the shared concentration ratios enforce
// (roundConcentration in account-stake-flow.mjs, #2327). An account deregistered across two or more
// subnets (HHI < 1) must never render as 1, which this card's contract defines as "all in one".
function roundConcentration(value: number): number {
  const rounded = Math.round(value * 10000) / 10000;
  return rounded >= 1 && value < 1 ? 0.9999 : rounded;
}

// A non-negative whole count from a D1 COUNT() cell (number, numeric string, or null),
// defaulting to 0 for anything non-finite or negative.
function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// A non-negative integer netuid, or null for a malformed/absent cell. Guard null explicitly so a
// null netuid is skipped rather than coerced to subnet 0 (Number(null) === 0); a blank/whitespace
// D1 cell (Number("") → 0) is likewise skipped.
function normalizedNetuid(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const netuid = Number(value);
  return Number.isSafeInteger(netuid) && netuid >= 0 ? netuid : null;
}

// Convert an epoch-ms timestamp to a finite epoch, or null when not finite / <= 0. Guards the JS
// Date range so a finite but out-of-range epoch cannot throw a RangeError on the response.
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

export interface AccountDeregistrationSubnet {
  netuid: number;
  deregistrations: number;
  first_deregistered_at: string | null;
  last_deregistered_at: string | null;
}

export interface AccountDeregistrationsResult {
  schema_version: 1;
  address: string;
  window: string | null;
  total_deregistrations: number;
  subnet_count: number;
  concentration: number | null;
  dominant_netuid: number | null;
  subnets: AccountDeregistrationSubnet[];
}

// Shape an account's per-netuid NeuronDeregistered aggregate into a deregistration scorecard. `rows`
// is the GROUP BY netuid result (netuid, deregistrations, first_observed, last_observed). Null-safe:
// no rows (cold store / empty window) yields a zeroed, empty-subnet card.
export function buildAccountDeregistrations(
  rows: Array<Record<string, unknown>> | null | undefined,
  address: string,
  { window }: { window?: string | null } = {},
): AccountDeregistrationsResult {
  const list = Array.isArray(rows) ? rows : [];
  // Merge by netuid so a malformed direct caller passing duplicate rows for a subnet sums rather
  // than double-counting (the SQL loader GROUPs BY netuid, so production rows are unique per subnet).
  const perSubnet = new Map<
    number,
    { deregistrations: number; firstMs: number | null; lastMs: number | null }
  >();
  for (const row of list) {
    const netuid = normalizedNetuid(row?.netuid);
    if (netuid == null) continue;
    const deregistrations = toCount(row?.deregistrations);
    if (deregistrations === 0) continue; // no deregistrations on this subnet: skip
    const firstMs = coerceEpochMs(row?.first_observed);
    const lastMs = coerceEpochMs(row?.last_observed);
    const bucket = perSubnet.get(netuid) ?? {
      deregistrations: 0,
      firstMs: null,
      lastMs: null,
    };
    bucket.deregistrations += deregistrations;
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

  let totalDeregistrations = 0;
  let squares = 0;
  const subnets: AccountDeregistrationSubnet[] = [];
  for (const [netuid, b] of perSubnet) {
    totalDeregistrations += b.deregistrations;
    squares += b.deregistrations * b.deregistrations;
    subnets.push({
      netuid,
      deregistrations: b.deregistrations,
      first_deregistered_at:
        b.firstMs == null ? null : new Date(b.firstMs).toISOString(),
      last_deregistered_at:
        b.lastMs == null ? null : new Date(b.lastMs).toISOString(),
    });
  }
  // Most-deregistered subnets first, tie-broken by netuid for a stable, deterministic order.
  subnets.sort(
    (a, b) => b.deregistrations - a.deregistrations || a.netuid - b.netuid,
  );
  // The dominant subnet is the head of that deterministic ranking, so it always agrees with the
  // subnets list order rather than depending on D1 GROUP BY row order.
  const dominantNetuid = subnets.length > 0 ? subnets[0].netuid : null;
  // Herfindahl-Hirschman index of deregistrations across subnets: 1 = all on one subnet, -> 1/n as
  // it spreads evenly; null when the account has no deregistrations to concentrate.
  const concentration =
    totalDeregistrations > 0
      ? roundConcentration(
          squares / (totalDeregistrations * totalDeregistrations),
        )
      : null;

  return {
    schema_version: 1,
    address,
    window: window ?? null,
    total_deregistrations: totalDeregistrations,
    subnet_count: subnets.length,
    concentration,
    dominant_netuid: dominantNetuid,
    subnets,
  };
}

// One account's deregistration footprint — reads its NeuronDeregistered events from account_events
// over the window (observed_at >= now - windowDays, epoch ms), grouped per subnet, shaped with
// buildAccountDeregistrations. The (hotkey) prefix of idx_account_events_hotkey (migrations/0009)
// seeks just this account's events; event_kind/observed_at are residual filters on that bounded
// seek. Returns { data, generatedAt } where generatedAt is the newest eviction's observed_at as an
// ISO string (string|null per the envelope contract). Cold/absent D1 -> zeroed card + null.
export async function loadAccountDeregistrations(
  d1: (
    sql: string,
    params: unknown[],
  ) => Promise<Array<Record<string, unknown>>>,
  address: string,
  {
    windowLabel = DEFAULT_DEREGISTRATION_WINDOW,
  }: { windowLabel?: string } = {},
): Promise<{
  data: AccountDeregistrationsResult;
  generatedAt: string | null;
}> {
  const days =
    DEREGISTRATION_WINDOWS[windowLabel] ??
    DEREGISTRATION_WINDOWS[DEFAULT_DEREGISTRATION_WINDOW];
  const cutoff = Date.now() - days * DAY_MS;
  const rows = await d1(
    "SELECT netuid, COUNT(*) AS deregistrations, MIN(observed_at) AS first_observed, " +
      "MAX(observed_at) AS last_observed " +
      "FROM account_events INDEXED BY idx_account_events_hotkey " +
      "WHERE hotkey = ? AND event_kind = ? AND observed_at >= ? GROUP BY netuid",
    [address, DEREGISTRATION_EVENT_KIND, cutoff],
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
    data: buildAccountDeregistrations(rows, address, { window: windowLabel }),
    generatedAt: toIso(latestObserved),
  };
}
