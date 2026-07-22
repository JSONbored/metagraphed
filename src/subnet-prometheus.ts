// Per-subnet Prometheus-endpoint serving activity from the account_events PrometheusServed stream:
// for ONE subnet over a 7d/30d window, the distinct exporters (hotkeys), PrometheusServed event
// count, and average announcements per exporter. The direct per-subnet lookup companion to the
// network-wide leaderboard at /api/v1/chain/prometheus — that route ranks only the top-N subnets
// and cannot be queried by an arbitrary netuid, so this fills the same per-subnet/chain duality the
// serving, turnover, concentration, stake-flow, yield, weights, and registrations routes already
// have. The telemetry-endpoint sibling of /api/v1/subnets/{netuid}/serving (axon endpoints). Pure
// shaping (buildSubnetPrometheus) + a thin D1 loader (loadSubnetPrometheus); the Worker adds the
// envelope. Null-safe: a cold store or a subnet with no PrometheusServed events yields the zeroed card.

type Row = Record<string, unknown>;
type D1Runner = (sql: string, params: unknown[]) => Promise<Row[]>;

const DAY_MS = 24 * 60 * 60 * 1000;

// The account_events kind emitted when a neuron announces its Prometheus telemetry endpoint on a subnet.
export const PROMETHEUS_EVENT_KIND = "PrometheusServed";

// Supported windows (label -> days) + default, matching the sibling /chain/prometheus route.
export const SUBNET_PROMETHEUS_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
};
export const DEFAULT_SUBNET_PROMETHEUS_WINDOW = "7d";

// Round an announcements-per-exporter ratio to a stable 2dp precision. Always finite and
// non-negative here (announcements / distinct exporters, with the divisor guarded below).
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

// Average PrometheusServed events per distinct exporter — the subnet's re-announcement intensity
// (1.0 means each exporter announced once; higher means repeated announcements). A subnet with no
// exporters has no defined intensity (null) rather than a divide-by-zero.
function announcementsPerExporter(
  announcements: number,
  exporters: number,
): number | null {
  if (exporters <= 0) return null;
  return round(announcements / exporters);
}

// Shape one subnet's Prometheus scorecard from the single-row account_events aggregate. `row`
// carries announcements (COUNT(*)), distinct_exporters (COUNT(DISTINCT hotkey)), and
// newest_observed (MAX(observed_at)). Null-safe: a null/absent row yields the zeroed card.
export function buildSubnetPrometheus(
  row: Row | null | undefined,
  netuid: unknown,
  { window }: { window?: unknown } = {},
): Row {
  const distinctExporters = toCount(row?.distinct_exporters);
  const announcements = toCount(row?.announcements);
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    observed_at: toIso(row?.newest_observed),
    distinct_exporters: distinctExporters,
    announcements,
    announcements_per_exporter: announcementsPerExporter(
      announcements,
      distinctExporters,
    ),
  };
}

// One subnet's Prometheus-serving activity, computed live: read the account_events PrometheusServed
// stream for this netuid over the window (observed_at >= now - windowDays, epoch ms) as a single
// aggregate (event count + true distinct exporters + newest observed_at, served by
// idx_account_events(netuid, event_kind, block_number) from migration 0024), and shape with
// buildSubnetPrometheus. The handler resolves windowLabel/windowDays from the window param.
// Cold/absent store -> the schema-stable zeroed card.
export async function loadSubnetPrometheus(
  d1: D1Runner,
  netuid: unknown,
  { windowLabel, windowDays }: { windowLabel?: unknown; windowDays: number },
): Promise<Row> {
  const cutoff = Date.now() - windowDays * DAY_MS;
  const rows = await d1(
    "SELECT COUNT(*) AS announcements, COUNT(DISTINCT hotkey) AS distinct_exporters, " +
      "MAX(observed_at) AS newest_observed " +
      "FROM account_events WHERE netuid = ? AND event_kind = ? AND observed_at >= ?",
    [netuid, PROMETHEUS_EVENT_KIND, cutoff],
  );
  return buildSubnetPrometheus(rows?.[0] ?? null, netuid, {
    window: windowLabel,
  });
}
