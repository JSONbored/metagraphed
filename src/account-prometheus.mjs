// Per-account Prometheus-endpoint serving footprint: which subnets one account (hotkey) announced a
// Prometheus telemetry endpoint on over a recent window, broken down per subnet and rolled up into a
// footprint scorecard. Pure shaping (buildAccountPrometheus) + a thin D1 loader
// (loadAccountPrometheus); the Worker adds the REST envelope. Null-safe: a cold store or an empty
// window yields schema-stable zeros (never throws), matching the sibling account tiers (serving,
// registrations, stake-flow, counterparties).
//
// This is the account-level companion of the per-subnet and network Prometheus-serving leaderboards
// (/api/v1/subnets/{netuid}/prometheus and /api/v1/chain/prometheus): those answer "who exports
// telemetry on subnet N" / "which subnets run observability infrastructure", this answers "which
// subnets does THIS account announce a Prometheus endpoint on, how often, and when" — a per-subnet
// PrometheusServed count with the first/last announcement timestamps, an HHI concentration of where
// its telemetry activity is focused, and the dominant subnet. The telemetry sibling of
// /accounts/{ss58}/serving (axon endpoints), operational activity orthogonal to
// /accounts/{ss58}/subnets (registration state).

const DAY_MS = 24 * 60 * 60 * 1000;

// The account_events kind emitted when a neuron announces its Prometheus telemetry endpoint on a
// subnet; always carries the announcing hotkey (scripts/fetch-events.py _axon -> [netuid, hotkey]).
export const PROMETHEUS_EVENT_KIND = "PrometheusServed";

// Supported windows (label -> days) + default, the same set the account stake-flow route exposes.
export const PROMETHEUS_WINDOWS = { "7d": 7, "30d": 30, "90d": 90 };
export const DEFAULT_PROMETHEUS_WINDOW = "30d";

// Round the HHI concentration ratio to 4 decimals WITHOUT letting a sub-perfect value round up to
// an exact 1 — the same anti-overstatement invariant the shared concentration ratios enforce
// (roundConcentration in account-stake-flow.mjs, #2327). An account announcing across two or more
// subnets (HHI < 1) must never render as 1, which this card's contract defines as "all in one".
function roundConcentration(value) {
  const rounded = Math.round(value * 10000) / 10000;
  return rounded >= 1 && value < 1 ? 0.9999 : rounded;
}

// A non-negative whole count from a D1 COUNT() cell (number, numeric string, or null),
// defaulting to 0 for anything non-finite or negative.
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// A non-negative integer netuid, or null for a malformed/absent cell. Guard null explicitly so a
// null netuid is skipped rather than coerced to subnet 0 (Number(null) === 0); a blank/whitespace
// D1 cell (Number("") → 0) is likewise skipped.
function normalizedNetuid(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const netuid = Number(value);
  return Number.isSafeInteger(netuid) && netuid >= 0 ? netuid : null;
}

// Convert an epoch-ms timestamp to a finite epoch, or null when not finite / <= 0. Guards the JS
// Date range so a finite but out-of-range epoch cannot throw a RangeError on the response.
function coerceEpochMs(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? n : null;
}

function toIso(value) {
  const n = coerceEpochMs(value);
  return n == null ? null : new Date(n).toISOString();
}

// Shape an account's per-netuid PrometheusServed aggregate into a footprint scorecard. `rows` is the
// GROUP BY netuid result (netuid, announcements, first_observed, last_observed). Null-safe: no rows
// (cold store / empty window) yields a zeroed, empty-subnet card.
export function buildAccountPrometheus(rows, address, { window } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  // Merge by netuid so a malformed direct caller passing duplicate rows for a subnet sums rather
  // than double-counting (the SQL loader GROUPs BY netuid, so production rows are unique per subnet).
  const perSubnet = new Map();
  for (const row of list) {
    const netuid = normalizedNetuid(row?.netuid);
    if (netuid == null) continue;
    const announcements = toCount(row?.announcements);
    if (announcements === 0) continue; // no announcements on this subnet: skip
    const firstMs = coerceEpochMs(row?.first_observed);
    const lastMs = coerceEpochMs(row?.last_observed);
    const bucket = perSubnet.get(netuid) ?? {
      announcements: 0,
      firstMs: null,
      lastMs: null,
    };
    bucket.announcements += announcements;
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

  let totalAnnouncements = 0;
  let squares = 0;
  const subnets = [];
  for (const [netuid, b] of perSubnet) {
    totalAnnouncements += b.announcements;
    squares += b.announcements * b.announcements;
    subnets.push({
      netuid,
      announcements: b.announcements,
      first_announced_at:
        b.firstMs == null ? null : new Date(b.firstMs).toISOString(),
      last_announced_at:
        b.lastMs == null ? null : new Date(b.lastMs).toISOString(),
    });
  }
  // Most-active subnets first (by announcements), tie-broken by netuid for a stable order.
  subnets.sort(
    (a, b) => b.announcements - a.announcements || a.netuid - b.netuid,
  );
  // The dominant subnet is the head of that deterministic ranking, so it always agrees with the
  // subnets list order rather than depending on D1 GROUP BY row order.
  const dominantNetuid = subnets.length > 0 ? subnets[0].netuid : null;
  // Herfindahl-Hirschman index of announcements across subnets: 1 = all on one subnet, -> 1/n as it
  // spreads evenly; null when the account has no announcements to concentrate.
  const concentration =
    totalAnnouncements > 0
      ? roundConcentration(squares / (totalAnnouncements * totalAnnouncements))
      : null;

  return {
    schema_version: 1,
    address,
    window: window ?? null,
    total_announcements: totalAnnouncements,
    subnet_count: subnets.length,
    concentration,
    dominant_netuid: dominantNetuid,
    subnets,
  };
}

// One account's Prometheus-serving footprint — reads its PrometheusServed events from account_events
// over the window (observed_at >= now - windowDays, epoch ms), grouped per subnet, shaped with
// buildAccountPrometheus. The (hotkey) prefix of idx_account_events_hotkey (migrations/0009) seeks
// just this account's events; event_kind/observed_at are residual filters on that bounded seek.
// Returns { data, generatedAt } where generatedAt is the newest announcement's observed_at as an ISO
// string (string|null per the envelope contract). Cold/absent D1 -> zeroed card + null.
export async function loadAccountPrometheus(
  d1,
  address,
  { windowLabel = DEFAULT_PROMETHEUS_WINDOW } = {},
) {
  const days =
    PROMETHEUS_WINDOWS[windowLabel] ??
    PROMETHEUS_WINDOWS[DEFAULT_PROMETHEUS_WINDOW];
  const cutoff = Date.now() - days * DAY_MS;
  const rows = await d1(
    "SELECT netuid, COUNT(*) AS announcements, MIN(observed_at) AS first_observed, " +
      "MAX(observed_at) AS last_observed " +
      "FROM account_events INDEXED BY idx_account_events_hotkey " +
      "WHERE hotkey = ? AND event_kind = ? AND observed_at >= ? GROUP BY netuid",
    [address, PROMETHEUS_EVENT_KIND, cutoff],
  );
  let latestObserved = null;
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
    data: buildAccountPrometheus(rows, address, { window: windowLabel }),
    generatedAt: toIso(latestObserved),
  };
}
