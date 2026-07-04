// Per-account stake-movement (re-delegation) footprint: which subnets one account (coldkey) moved
// stake between over a recent window, broken down per subnet and rolled up into a movement
// scorecard. Pure shaping (buildAccountStakeMoves) + a thin D1 loader (loadAccountStakeMoves); the
// Worker adds the REST envelope. Null-safe: a cold store or an empty window yields schema-stable
// zeros (never throws), matching the sibling account tiers (stake-flow, registrations).
//
// This is the account-level companion of the per-subnet and network stake-movement leaderboards
// (/api/v1/subnets/{netuid}/stake-moves and /api/v1/chain/stake-moves): those answer "who moved
// stake on subnet N" / "which subnets saw the most movement", this answers "which subnets did THIS
// account move stake between, how often, and when" — a per-subnet StakeMoved count with the
// first/last movement timestamps, an HHI concentration of where its movement activity is focused,
// and the dominant subnet. StakeMoved is a coldkey relocating stake between hotkeys/subnets
// (move_stake) without unstaking, so — unlike every other account tier here, which is keyed on the
// hotkey — this is keyed on the coldkey (the account initiating the move), matching the identity
// chain-stake-moves.mjs / subnet-stake-moves.mjs already rank by. Distinct from
// /accounts/{ss58}/stake-flow (StakeAdded/StakeRemoved net capital flow, hotkey-keyed) because this
// is re-delegation churn, not flow.

const DAY_MS = 24 * 60 * 60 * 1000;

// The account_events kind emitted when a coldkey moves stake between hotkeys/subnets (move_stake).
export const STAKE_MOVED_EVENT_KIND = "StakeMoved";

// Supported windows (label -> days) + default, the same set the account registrations route exposes.
export const ACCOUNT_STAKE_MOVES_WINDOWS = { "7d": 7, "30d": 30, "90d": 90 };
export const DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW = "30d";

// Round the HHI concentration ratio to 4 decimals WITHOUT letting a sub-perfect value round up to
// an exact 1 — the same anti-overstatement invariant the shared concentration ratios enforce
// (roundConcentration in account-registrations.mjs / account-stake-flow.mjs, #2327). An account
// moving stake across two or more subnets (HHI < 1) must never render as 1, which this card's
// contract defines as "all in one".
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

// Shape an account's per-netuid StakeMoved aggregate into a movement scorecard. `rows` is the
// GROUP BY netuid result (netuid, movements, first_observed, last_observed). Null-safe: no rows
// (cold store / empty window) yields a zeroed, empty-subnet card.
export function buildAccountStakeMoves(rows, address, { window } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  // Merge by netuid so a malformed direct caller passing duplicate rows for a subnet sums rather
  // than double-counting (the SQL loader GROUPs BY netuid, so production rows are unique per subnet).
  const perSubnet = new Map();
  for (const row of list) {
    const netuid = normalizedNetuid(row?.netuid);
    if (netuid == null) continue;
    const movements = toCount(row?.movements);
    if (movements === 0) continue; // no movements on this subnet: skip
    const firstMs = coerceEpochMs(row?.first_observed);
    const lastMs = coerceEpochMs(row?.last_observed);
    const bucket = perSubnet.get(netuid) ?? {
      movements: 0,
      firstMs: null,
      lastMs: null,
    };
    bucket.movements += movements;
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

  let totalMovements = 0;
  let squares = 0;
  const subnets = [];
  for (const [netuid, b] of perSubnet) {
    totalMovements += b.movements;
    squares += b.movements * b.movements;
    subnets.push({
      netuid,
      movements: b.movements,
      first_moved_at:
        b.firstMs == null ? null : new Date(b.firstMs).toISOString(),
      last_moved_at: b.lastMs == null ? null : new Date(b.lastMs).toISOString(),
    });
  }
  // Most-moved subnets first, tie-broken by netuid for a stable, deterministic order.
  subnets.sort((a, b) => b.movements - a.movements || a.netuid - b.netuid);
  // The dominant subnet is the head of that deterministic ranking, so it always agrees with the
  // subnets list order rather than depending on D1 GROUP BY row order.
  const dominantNetuid = subnets.length > 0 ? subnets[0].netuid : null;
  // Herfindahl-Hirschman index of movements across subnets: 1 = all on one subnet, -> 1/n as it
  // spreads evenly; null when the account has no movements to concentrate.
  const concentration =
    totalMovements > 0
      ? roundConcentration(squares / (totalMovements * totalMovements))
      : null;

  return {
    schema_version: 1,
    address,
    window: window ?? null,
    total_movements: totalMovements,
    subnet_count: subnets.length,
    concentration,
    dominant_netuid: dominantNetuid,
    subnets,
  };
}

// One account's stake-movement footprint — reads its StakeMoved events from account_events over
// the window (observed_at >= now - windowDays, epoch ms), grouped per subnet, shaped with
// buildAccountStakeMoves. The (coldkey) prefix of idx_account_events_coldkey (migrations/0009)
// seeks just this account's events; event_kind/observed_at are residual filters on that bounded
// seek. Returns { data, generatedAt } where generatedAt is the newest movement's observed_at as an
// ISO string (string|null per the envelope contract). Cold/absent D1 -> zeroed card + null.
export async function loadAccountStakeMoves(
  d1,
  address,
  { windowLabel = DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW } = {},
) {
  const days =
    ACCOUNT_STAKE_MOVES_WINDOWS[windowLabel] ??
    ACCOUNT_STAKE_MOVES_WINDOWS[DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW];
  const cutoff = Date.now() - days * DAY_MS;
  const rows = await d1(
    "SELECT netuid, COUNT(*) AS movements, MIN(observed_at) AS first_observed, " +
      "MAX(observed_at) AS last_observed " +
      "FROM account_events INDEXED BY idx_account_events_coldkey " +
      "WHERE coldkey = ? AND event_kind = ? AND observed_at >= ? GROUP BY netuid",
    [address, STAKE_MOVED_EVENT_KIND, cutoff],
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
    data: buildAccountStakeMoves(rows, address, { window: windowLabel }),
    generatedAt: toIso(latestObserved),
  };
}
