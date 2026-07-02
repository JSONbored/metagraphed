// Per-account stake flow: how one account's capital moved in (StakeAdded) vs out
// (StakeRemoved) over a recent window, broken down per subnet and rolled up into a
// staking-behavior scorecard. Pure shaping (buildAccountStakeFlow) + a thin D1 loader
// (loadAccountStakeFlow); the Worker adds the REST envelope. Null-safe: a cold store
// or an empty window yields schema-stable zeros (never throws), matching the sibling
// account tiers (transfers, counterparties) and the per-subnet stake-flow route.
//
// This is the account-level companion of the per-subnet stake-flow route: that one
// answers "how much capital moved through subnet N", this one answers "where did THIS
// account move capital, and is it accumulating or exiting" — net + gross flow per
// subnet, an HHI concentration of where its flow is focused, and a direction label.

const DAY_MS = 24 * 60 * 60 * 1000;

// The two account_events kinds that move stake; both carry a positive amount_tao
// (migrations/0009_account_events.sql), so net flow = staked - unstaked.
export const STAKE_ADDED_KIND = "StakeAdded";
export const STAKE_REMOVED_KIND = "StakeRemoved";

// Supported flow windows (label -> days), the same set the per-subnet stake-flow and
// concentration/history routes expose. An unsupported label is rejected by the handler.
export const STAKE_FLOW_WINDOWS = { "7d": 7, "30d": 30, "90d": 90 };
export const DEFAULT_STAKE_FLOW_WINDOW = "30d";

// |net| / gross at or above this share reads as a directional move rather than churn;
// below it the account is cycling capital in and out without a clear lean.
const DIRECTIONAL_RATIO = 0.2;

// 1 TAO = 1e9 rao. Round every TAO output to rao precision to shed IEEE-754 noise
// below the rao floor (the same rounding the per-subnet stake-flow scorecard applies).
const RAO_PER_TAO = 1e9;
function roundTao(value) {
  /* v8 ignore next -- defensive: callers only pass finite toNumber-guarded sums */
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * RAO_PER_TAO) / RAO_PER_TAO;
}

// Coerce a D1 SUM()/COUNT() cell (number, numeric string, or null) to a finite number.
function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// A non-negative integer netuid, or null for a malformed/absent cell. Guard null
// explicitly so a null netuid is skipped rather than coerced to subnet 0 (Number(null) === 0).
function normalizedNetuid(value) {
  if (value == null) return null;
  const netuid = Number(value);
  return Number.isSafeInteger(netuid) && netuid >= 0 ? netuid : null;
}

// Convert an epoch-ms timestamp to an ISO string, or null when not finite. The REST
// meta.generated_at is string|null per the envelope contract.
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

// Net vs gross share -> a coarse direction label. gross 0 (no flow at all) reads as
// "idle"; a net lean past DIRECTIONAL_RATIO is accumulating/exiting, otherwise churning
// (capital cycling both ways without a clear direction).
function classifyDirection(netTao, grossTao) {
  if (grossTao <= 0) return "idle";
  const ratio = netTao / grossTao;
  if (ratio >= DIRECTIONAL_RATIO) return "accumulating";
  if (ratio <= -DIRECTIONAL_RATIO) return "exiting";
  return "churning";
}

// net / gross, rounded to 4dp; null when gross is 0 (ratio undefined with no flow).
function flowRatio(netTao, grossTao) {
  if (grossTao <= 0) return null;
  return Math.round((netTao / grossTao) * 10000) / 10000;
}

// Shape an account's per-(netuid, kind) StakeAdded/StakeRemoved aggregate into a
// staking-behavior scorecard. `rows` is the GROUP BY netuid, event_kind result.
// Null-safe: no rows (cold store / empty window) yields a zeroed, empty-subnet card.
export function buildAccountStakeFlow(rows, address, { window } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  // Fold the per-kind rows into one record per subnet.
  const perSubnet = new Map();
  for (const row of list) {
    const netuid = normalizedNetuid(row?.netuid);
    if (netuid == null) continue;
    const kind = row?.event_kind;
    if (kind !== STAKE_ADDED_KIND && kind !== STAKE_REMOVED_KIND) continue;
    const bucket = perSubnet.get(netuid) ?? {
      staked: 0,
      unstaked: 0,
      stakeEvents: 0,
      unstakeEvents: 0,
    };
    const tao = toNumber(row?.total_tao);
    // Counts are integer (the schema requires it); truncate defensively so a non-D1
    // caller passing a float cannot emit a fractional event count.
    const count = Math.max(0, Math.trunc(toNumber(row?.event_count)));
    if (kind === STAKE_ADDED_KIND) {
      bucket.staked += tao;
      bucket.stakeEvents += count;
    } else {
      bucket.unstaked += tao;
      bucket.unstakeEvents += count;
    }
    perSubnet.set(netuid, bucket);
  }

  let totalStaked = 0;
  let totalUnstaked = 0;
  let totalStakeEvents = 0;
  let totalUnstakeEvents = 0;
  let grossSquares = 0;
  const subnets = [];
  for (const [netuid, b] of perSubnet) {
    const net = b.staked - b.unstaked;
    const gross = b.staked + b.unstaked;
    totalStaked += b.staked;
    totalUnstaked += b.unstaked;
    totalStakeEvents += b.stakeEvents;
    totalUnstakeEvents += b.unstakeEvents;
    grossSquares += gross * gross;
    subnets.push({
      netuid,
      staked_tao: roundTao(b.staked),
      unstaked_tao: roundTao(b.unstaked),
      net_flow_tao: roundTao(net),
      gross_flow_tao: roundTao(gross),
      flow_ratio: flowRatio(net, gross),
      direction: classifyDirection(net, gross),
      stake_events: b.stakeEvents,
      unstake_events: b.unstakeEvents,
    });
  }
  // Most-active subnets first (by gross flow), tie-broken by netuid for a stable order.
  subnets.sort(
    (a, b) => b.gross_flow_tao - a.gross_flow_tao || a.netuid - b.netuid,
  );
  // The dominant subnet is the head of that deterministic ranking (highest gross,
  // lowest netuid on a tie), so it always agrees with the subnets list order rather
  // than depending on D1 GROUP BY row order.
  const dominantNetuid = subnets.length > 0 ? subnets[0].netuid : null;

  const totalNet = totalStaked - totalUnstaked;
  const totalGross = totalStaked + totalUnstaked;
  // Herfindahl-Hirschman index of gross flow across subnets: 1 = all flow in one
  // subnet, -> 1/n as it spreads evenly; null when there is no flow to concentrate.
  const concentration =
    totalGross > 0
      ? Math.round((grossSquares / (totalGross * totalGross)) * 10000) / 10000
      : null;

  return {
    schema_version: 1,
    address,
    window: window ?? null,
    total_staked_tao: roundTao(totalStaked),
    total_unstaked_tao: roundTao(totalUnstaked),
    net_flow_tao: roundTao(totalNet),
    gross_flow_tao: roundTao(totalGross),
    flow_ratio: flowRatio(totalNet, totalGross),
    direction: classifyDirection(totalNet, totalGross),
    stake_events: totalStakeEvents,
    unstake_events: totalUnstakeEvents,
    subnet_count: subnets.length,
    concentration,
    dominant_netuid: dominantNetuid,
    subnets,
  };
}

// One account's stake flow — sums StakeAdded/StakeRemoved amount_tao from account_events
// over the window (observed_at >= now - windowDays, epoch ms), grouped per subnet and
// kind, shaped with buildAccountStakeFlow. The (hotkey) prefix of idx_account_events_hotkey
// (migrations/0009) seeks just this account's events; event_kind/observed_at are residual
// filters on that bounded seek. Returns { data, generatedAt } where generatedAt is the
// newest event's observed_at as an ISO string (string|null per the envelope contract).
// Cold/absent D1 -> zeroed totals + empty subnets + generatedAt null.
export async function loadAccountStakeFlow(
  d1,
  address,
  { windowLabel = DEFAULT_STAKE_FLOW_WINDOW } = {},
) {
  const days =
    STAKE_FLOW_WINDOWS[windowLabel] ??
    STAKE_FLOW_WINDOWS[DEFAULT_STAKE_FLOW_WINDOW];
  const cutoff = Date.now() - days * DAY_MS;
  const rows = await d1(
    "SELECT netuid, event_kind, COALESCE(SUM(amount_tao), 0) AS total_tao, " +
      "COUNT(*) AS event_count, MAX(observed_at) AS last_observed " +
      "FROM account_events INDEXED BY idx_account_events_hotkey " +
      "WHERE hotkey = ? AND event_kind IN (?, ?) AND observed_at >= ? " +
      "GROUP BY netuid, event_kind",
    [address, STAKE_ADDED_KIND, STAKE_REMOVED_KIND, cutoff],
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
    data: buildAccountStakeFlow(rows, address, { window: windowLabel }),
    generatedAt: toIso(latestObserved),
  };
}
