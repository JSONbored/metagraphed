// Per-subnet stake-movement (re-delegation) activity from the account_events StakeMoved stream:
// for ONE subnet over a 7d/30d window, the distinct movers (accounts), StakeMoved event count, and
// average movements per mover. The direct per-subnet lookup companion to the network-wide
// leaderboard at /api/v1/chain/stake-moves — that route ranks only the top-N subnets and cannot be
// queried by an arbitrary netuid, so this fills the same per-subnet/chain duality the serving,
// prometheus, turnover, concentration, stake-flow, yield, weights, and registrations routes already
// have. The re-delegation-churn sibling of /api/v1/subnets/{netuid}/stake-flow (net capital flow) —
// StakeMoved relocates stake between hotkeys/subnets (move_stake) without unstaking, so it measures
// churn, not flow; the mover is the origin account. Pure shaping (buildSubnetStakeMoves) + a thin D1
// loader (loadSubnetStakeMoves); the Worker adds the envelope. Null-safe: a cold store or a subnet
// with no StakeMoved events yields the zeroed card.

type Row = Record<string, unknown>;
type D1Runner = (sql: string, params: unknown[]) => Promise<Row[]>;

const DAY_MS = 24 * 60 * 60 * 1000;

// The account_events kind emitted when an account moves stake between hotkeys/subnets (move_stake).
export const STAKE_MOVED_EVENT_KIND = "StakeMoved";

// Supported windows (label -> days) + default, matching the sibling /chain/stake-moves route.
export const SUBNET_STAKE_MOVES_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
};
export const DEFAULT_SUBNET_STAKE_MOVES_WINDOW = "7d";

// Round a movements-per-mover ratio to a stable 2dp precision. Always finite and
// non-negative here (movements / distinct movers, with the divisor guarded below).
function round(value: number, dp = 2): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

// A non-negative whole count from a D1 COUNT() cell (number, numeric string, or null),
// defaulting to 0 for anything non-finite or negative.
function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Newest epoch-ms observed_at, or null when not finite/absent — rendered as ISO for the
// envelope's generated_at, the same way account-events does. Guards the JS Date range so a
// finite but out-of-range epoch cannot throw a RangeError on the response.
function toIso(value: unknown): string | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Average StakeMoved events per distinct mover — the subnet's re-move intensity (1.0 means each
// mover moved once; higher means repeated moves). A subnet with no movers has no defined intensity
// (null) rather than a divide-by-zero.
function movementsPerMover(movements: number, movers: number): number | null {
  if (movers <= 0) return null;
  return round(movements / movers);
}

// Shape one subnet's stake-movement scorecard from the single-row account_events aggregate. `row`
// carries movements (COUNT(*)), distinct_movers (COUNT(DISTINCT coldkey)), and newest_observed
// (MAX(observed_at)). Null-safe: a null/absent row yields the zeroed card.
export function buildSubnetStakeMoves(
  row: Row | null | undefined,
  netuid: unknown,
  { window }: { window?: unknown } = {},
): Row {
  const distinctMovers = toCount(row?.distinct_movers);
  const movements = toCount(row?.movements);
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    observed_at: toIso(row?.newest_observed),
    distinct_movers: distinctMovers,
    movements,
    movements_per_mover: movementsPerMover(movements, distinctMovers),
  };
}

// One subnet's stake-movement activity, computed live: read the account_events StakeMoved stream
// for this netuid over the window (observed_at >= now - windowDays, epoch ms) as a single aggregate
// (event count + true distinct movers + newest observed_at, served by
// idx_account_events(netuid, event_kind, block_number) from migration 0024), and shape with
// buildSubnetStakeMoves. The handler resolves windowLabel/windowDays from the window param.
// Cold/absent store -> the schema-stable zeroed card.
export async function loadSubnetStakeMoves(
  d1: D1Runner,
  netuid: unknown,
  { windowLabel, windowDays }: { windowLabel?: unknown; windowDays: number },
): Promise<Row> {
  const cutoff = Date.now() - windowDays * DAY_MS;
  const rows = await d1(
    "SELECT COUNT(*) AS movements, COUNT(DISTINCT coldkey) AS distinct_movers, " +
      "MAX(observed_at) AS newest_observed " +
      "FROM account_events WHERE netuid = ? AND event_kind = ? AND observed_at >= ?",
    [netuid, STAKE_MOVED_EVENT_KIND, cutoff],
  );
  return buildSubnetStakeMoves(rows?.[0] ?? null, netuid, {
    window: windowLabel,
  });
}
