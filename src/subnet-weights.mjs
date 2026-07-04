// Per-subnet validator weight-setting activity from the account_events WeightsSet stream:
// for ONE subnet over a 7d/30d window, the distinct weight-setting validators, WeightsSet
// event count, and average updates per validator. The direct per-subnet lookup companion to
// the network-wide leaderboard at /api/v1/chain/weights — that route ranks only the top-N
// subnets and cannot be queried by an arbitrary netuid, so this fills the same per-subnet /
// chain duality the turnover, concentration, stake-flow, and yield routes already have. Pure
// shaping (buildSubnetWeights) + a thin D1 loader (loadSubnetWeights); the Worker adds the
// envelope. Null-safe: a cold store or a subnet with no WeightsSet events yields the zeroed card.

const DAY_MS = 24 * 60 * 60 * 1000;

// The account_events kind emitted when a validator sets weights on a subnet.
export const WEIGHTS_EVENT_KIND = "WeightsSet";

// Supported windows (label -> days) + default, matching the sibling /chain/weights route.
export const SUBNET_WEIGHTS_WINDOWS = { "7d": 7, "30d": 30 };
export const DEFAULT_SUBNET_WEIGHTS_WINDOW = "7d";

// Round an updates-per-validator ratio to a stable 2dp precision. Always finite and
// non-negative here (events / distinct setters, with the divisor guarded below).
function round(value, dp = 2) {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

// A non-negative whole count from a D1 COUNT() cell (number, numeric string, or null),
// defaulting to 0 for anything non-finite or negative.
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Newest epoch-ms observed_at, or null when not finite/absent — rendered as ISO for the
// envelope's generated_at, the same way account-events does. Guards the JS Date range so a
// finite but out-of-range epoch cannot throw a RangeError on the response.
function toIso(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Average WeightsSet events per distinct validator — the subnet's update intensity. A subnet
// with no setters has no defined intensity (null) rather than a divide-by-zero.
function setsPerSetter(sets, setters) {
  if (setters <= 0) return null;
  return round(sets / setters);
}

// Shape one subnet's weight-setting scorecard from the single-row account_events aggregate.
// `row` carries weight_sets (COUNT(*)), distinct_setters (COUNT(DISTINCT hotkey)), and
// newest_observed (MAX(observed_at)). Null-safe: a null/absent row yields the zeroed card.
export function buildSubnetWeights(row, netuid, { window } = {}) {
  const distinctSetters = toCount(row?.distinct_setters);
  const weightSets = toCount(row?.weight_sets);
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    observed_at: toIso(row?.newest_observed),
    distinct_setters: distinctSetters,
    weight_sets: weightSets,
    sets_per_setter: setsPerSetter(weightSets, distinctSetters),
  };
}

// One subnet's weight-setting activity, computed live: read the account_events WeightsSet
// stream for this netuid over the window (observed_at >= now - windowDays, epoch ms) as a
// single aggregate (event count + true distinct setters + newest observed_at, served by
// idx_account_events(netuid, event_kind, block_number) from migration 0024), and shape with
// buildSubnetWeights. The handler resolves windowLabel/windowDays from the window param.
// Cold/absent store -> the schema-stable zeroed card.
export async function loadSubnetWeights(
  d1,
  netuid,
  { windowLabel, windowDays } = {},
) {
  const cutoff = Date.now() - windowDays * DAY_MS;
  const rows = await d1(
    "SELECT COUNT(*) AS weight_sets, COUNT(DISTINCT hotkey) AS distinct_setters, " +
      "MAX(observed_at) AS newest_observed " +
      "FROM account_events WHERE netuid = ? AND event_kind = ? AND observed_at >= ?",
    [netuid, WEIGHTS_EVENT_KIND, cutoff],
  );
  return buildSubnetWeights(rows?.[0] ?? null, netuid, { window: windowLabel });
}
