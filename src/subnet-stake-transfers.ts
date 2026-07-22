// Per-subnet stake-transfer activity from the account_events StakeTransferred stream: for ONE subnet
// over a 7d/30d window, the distinct senders (accounts), StakeTransferred event count, and average
// transfers per sender. The direct per-subnet lookup companion to the network-wide leaderboard at
// /api/v1/chain/stake-transfers — that route ranks only the top-N subnets and cannot be queried by an
// arbitrary netuid, so this fills the same per-subnet/chain duality the serving, prometheus, turnover,
// concentration, stake-flow, stake-moves, yield, weights, and registrations routes already have. The
// between-coldkeys sibling of /api/v1/subnets/{netuid}/stake-moves (within-account re-delegation
// churn) — StakeTransferred (transfer_stake) relocates staked alpha from one account to another on
// the same hotkey, so it moves ownership, not net capital; the sender is the origin account and the
// netuid is the origin subnet (origin leg only). Pure shaping (buildSubnetStakeTransfers) + a thin D1
// loader (loadSubnetStakeTransfers); the Worker adds the envelope. Null-safe: a cold store or a subnet
// with no StakeTransferred events yields the zeroed card.

type Row = Record<string, unknown>;
type D1Runner = (sql: string, params: unknown[]) => Promise<Row[]>;

const DAY_MS = 24 * 60 * 60 * 1000;

// The account_events kind emitted when an account transfers stake to another account (transfer_stake).
export const STAKE_TRANSFERRED_EVENT_KIND = "StakeTransferred";

// Supported windows (label -> days) + default, matching the sibling /chain/stake-transfers route.
export const SUBNET_STAKE_TRANSFERS_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
};
export const DEFAULT_SUBNET_STAKE_TRANSFERS_WINDOW = "7d";

// Round a transfers-per-sender ratio to a stable 2dp precision. Always finite and
// non-negative here (transfers / distinct senders, with the divisor guarded below).
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

// Average StakeTransferred events per distinct sender — the subnet's transfer intensity (1.0 means
// each sender transferred once; higher means repeated transfers). A subnet with no senders has no
// defined intensity (null) rather than a divide-by-zero.
function transfersPerSender(transfers: number, senders: number): number | null {
  if (senders <= 0) return null;
  return round(transfers / senders);
}

// Shape one subnet's stake-transfer scorecard from the single-row account_events aggregate. `row`
// carries transfers (COUNT(*)), distinct_senders (COUNT(DISTINCT coldkey)), and newest_observed
// (MAX(observed_at)). Null-safe: a null/absent row yields the zeroed card.
export function buildSubnetStakeTransfers(
  row: Row | null | undefined,
  netuid: unknown,
  { window }: { window?: unknown } = {},
): Row {
  const distinctSenders = toCount(row?.distinct_senders);
  const transfers = toCount(row?.transfers);
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    observed_at: toIso(row?.newest_observed),
    distinct_senders: distinctSenders,
    transfers,
    transfers_per_sender: transfersPerSender(transfers, distinctSenders),
  };
}

// One subnet's stake-transfer activity, computed live: read the account_events StakeTransferred stream
// for this netuid over the window as a single aggregate (event count + true distinct senders + newest
// observed_at), filtered by netuid, event_kind, and the observed_at >= now - windowDays predicate
// (epoch ms), and shape with buildSubnetStakeTransfers. The handler resolves windowLabel/windowDays
// from the window param. Cold/absent store -> the schema-stable zeroed card.
export async function loadSubnetStakeTransfers(
  d1: D1Runner,
  netuid: unknown,
  { windowLabel, windowDays }: { windowLabel?: unknown; windowDays: number },
): Promise<Row> {
  const cutoff = Date.now() - windowDays * DAY_MS;
  const rows = await d1(
    "SELECT COUNT(*) AS transfers, COUNT(DISTINCT coldkey) AS distinct_senders, " +
      "MAX(observed_at) AS newest_observed " +
      "FROM account_events WHERE netuid = ? AND event_kind = ? AND observed_at >= ?",
    [netuid, STAKE_TRANSFERRED_EVENT_KIND, cutoff],
  );
  return buildSubnetStakeTransfers(rows?.[0] ?? null, netuid, {
    window: windowLabel,
  });
}
