// Per-subnet axon-serving announcement activity from the account_events AxonServed stream:
// for ONE subnet over a 7d/30d window, the distinct servers (hotkeys), AxonServed event count,
// and average announcements per server. The direct per-subnet lookup companion to the network-wide
// leaderboard at /api/v1/chain/serving — that route ranks only the top-N subnets and cannot be
// queried by an arbitrary netuid, so this fills the same per-subnet/chain duality the turnover,
// concentration, stake-flow, yield, and weights routes already have. Pure shaping
// (buildSubnetServing) + a thin D1 loader (loadSubnetServing); the Worker adds the envelope.
// Null-safe: a cold store or a subnet with no AxonServed events yields the zeroed card.

type Row = Record<string, unknown>;
type D1Runner = (sql: string, params: unknown[]) => Promise<Row[]>;

const DAY_MS = 24 * 60 * 60 * 1000;

// The account_events kind emitted when a neuron announces its axon endpoint on a subnet.
export const SERVING_EVENT_KIND = "AxonServed";

// Supported windows (label -> days) + default, matching the sibling /chain/serving route.
export const SUBNET_SERVING_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
};
export const DEFAULT_SUBNET_SERVING_WINDOW = "7d";

// Round an announcements-per-server ratio to a stable 2dp precision. Always finite and
// non-negative here (announcements / distinct servers, with the divisor guarded below).
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

// Average AxonServed events per distinct server — the subnet's re-announcement intensity (1.0
// means each server announced once; higher means repeated announcements). A subnet with no
// servers has no defined intensity (null) rather than a divide-by-zero.
function announcementsPerServer(
  announcements: number,
  servers: number,
): number | null {
  if (servers <= 0) return null;
  return round(announcements / servers);
}

// Shape one subnet's serving scorecard from the single-row account_events aggregate. `row`
// carries announcements (COUNT(*)), distinct_servers (COUNT(DISTINCT hotkey)), and
// newest_observed (MAX(observed_at)). Null-safe: a null/absent row yields the zeroed card.
export function buildSubnetServing(
  row: Row | null | undefined,
  netuid: unknown,
  { window }: { window?: unknown } = {},
): Row {
  const distinctServers = toCount(row?.distinct_servers);
  const announcements = toCount(row?.announcements);
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    observed_at: toIso(row?.newest_observed),
    distinct_servers: distinctServers,
    announcements,
    announcements_per_server: announcementsPerServer(
      announcements,
      distinctServers,
    ),
  };
}

// One subnet's axon-serving activity, computed live: read the account_events AxonServed stream
// for this netuid over the window (observed_at >= now - windowDays, epoch ms) as a single
// aggregate (event count + true distinct servers + newest observed_at, served by
// idx_account_events(netuid, event_kind, block_number) from migration 0024), and shape with
// buildSubnetServing. The handler resolves windowLabel/windowDays from the window param.
// Cold/absent store -> the schema-stable zeroed card.
export async function loadSubnetServing(
  d1: D1Runner,
  netuid: unknown,
  { windowLabel, windowDays }: { windowLabel?: unknown; windowDays: number },
): Promise<Row> {
  const cutoff = Date.now() - windowDays * DAY_MS;
  const rows = await d1(
    "SELECT COUNT(*) AS announcements, COUNT(DISTINCT hotkey) AS distinct_servers, " +
      "MAX(observed_at) AS newest_observed " +
      "FROM account_events WHERE netuid = ? AND event_kind = ? AND observed_at >= ?",
    [netuid, SERVING_EVENT_KIND, cutoff],
  );
  return buildSubnetServing(rows?.[0] ?? null, netuid, { window: windowLabel });
}
