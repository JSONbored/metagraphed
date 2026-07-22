// Per-subnet axon-removal activity from the account_events AxonInfoRemoved stream: for ONE
// subnet over a 7d/30d window, the distinct removers (hotkeys), AxonInfoRemoved event count,
// and average removals per remover. This is raw axon-teardown activity — the removal-side
// companion to the AxonServed announcement activity in /serving (which measures neurons
// announcing an axon, NOT tearing one down), exactly the way /registrations (raw
// NeuronRegistered demand) coexists with /turnover (net validator-set churn). Pure shaping
// (buildSubnetAxonRemovals) + a thin D1 loader (loadSubnetAxonRemovals); the Worker adds the
// envelope. Null-safe: a cold store or a subnet with no AxonInfoRemoved events yields the zeroed card.

type Row = Record<string, unknown>;
type D1Runner = (sql: string, params: unknown[]) => Promise<Row[]>;

const DAY_MS = 24 * 60 * 60 * 1000;

// The account_events kind emitted when a neuron's announced axon endpoint is removed on a subnet.
export const AXON_REMOVAL_EVENT_KIND = "AxonInfoRemoved";

// Supported windows (label -> days) + default, matching the sibling account_events routes.
export const SUBNET_AXON_REMOVALS_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
};
export const DEFAULT_SUBNET_AXON_REMOVALS_WINDOW = "7d";

// Round a removals-per-remover ratio to a stable 2dp precision. Always finite and non-negative
// here (removals / distinct removers, with the divisor guarded below).
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

// Average AxonInfoRemoved events per distinct remover — the subnet's re-teardown intensity (1.0
// means each remover removed once; higher means hotkeys removed an axon repeatedly after
// re-announcing). A subnet with no removers has no defined intensity (null), not a divide-by-zero.
function removalsPerRemover(removals: number, removers: number): number | null {
  if (removers <= 0) return null;
  return round(removals / removers);
}

// Shape one subnet's axon-removal scorecard from the single-row account_events aggregate. `row`
// carries removals (COUNT(*)), distinct_removers (COUNT(DISTINCT hotkey)), and newest_observed
// (MAX(observed_at)). Null-safe: a null/absent row yields the zeroed card.
export function buildSubnetAxonRemovals(
  row: Row | null | undefined,
  netuid: unknown,
  { window }: { window?: unknown } = {},
): Row {
  const distinctRemovers = toCount(row?.distinct_removers);
  const removals = toCount(row?.removals);
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    observed_at: toIso(row?.newest_observed),
    distinct_removers: distinctRemovers,
    removals,
    removals_per_remover: removalsPerRemover(removals, distinctRemovers),
  };
}

// One subnet's axon-removal activity, computed live: read the account_events AxonInfoRemoved
// stream for this netuid over the window (observed_at >= now - windowDays, epoch ms) as a single
// aggregate (event count + true distinct removers + newest observed_at, served by
// idx_account_events(netuid, event_kind, block_number) from migration 0024), and shape with
// buildSubnetAxonRemovals. An AxonInfoRemoved event always carries the removing hotkey, so
// COUNT(DISTINCT hotkey) is exact here. The handler resolves windowLabel/windowDays from the
// window param. Cold/absent store -> the schema-stable zeroed card.
export async function loadSubnetAxonRemovals(
  d1: D1Runner,
  netuid: unknown,
  { windowLabel, windowDays }: { windowLabel?: unknown; windowDays: number },
): Promise<Row> {
  const cutoff = Date.now() - windowDays * DAY_MS;
  const rows = await d1(
    "SELECT COUNT(*) AS removals, COUNT(DISTINCT hotkey) AS distinct_removers, " +
      "MAX(observed_at) AS newest_observed " +
      "FROM account_events WHERE netuid = ? AND event_kind = ? AND observed_at >= ?",
    [netuid, AXON_REMOVAL_EVENT_KIND, cutoff],
  );
  return buildSubnetAxonRemovals(rows?.[0] ?? null, netuid, {
    window: windowLabel,
  });
}
