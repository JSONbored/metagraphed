// Per-subnet neuron-deregistration activity from the account_events NeuronDeregistered stream: for
// ONE subnet over a 7d/30d window, the distinct deregistered hotkeys, NeuronDeregistered event
// count, and average deregistrations per hotkey. This is raw deregistration/eviction activity —
// the exit-side companion to the raw NeuronRegistered demand in /registrations, and the
// account_events companion to the neuron_daily validator-set churn in /turnover (which measures net
// snapshot change, NOT raw deregistration event volume), exactly the way /registrations coexists
// with /turnover. Pure shaping (buildSubnetDeregistrations) + a thin D1 loader
// (loadSubnetDeregistrations); the Worker adds the envelope. Null-safe: a cold store or a subnet
// with no NeuronDeregistered events yields the zeroed card.

type Row = Record<string, unknown>;
type D1Runner = (sql: string, params: unknown[]) => Promise<Row[]>;

const DAY_MS = 24 * 60 * 60 * 1000;

// The account_events kind emitted when a neuron is deregistered (evicted) from a subnet.
export const DEREGISTRATION_EVENT_KIND = "NeuronDeregistered";

// Supported windows (label -> days) + default, matching the sibling account_events routes.
export const SUBNET_DEREGISTRATIONS_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
};
export const DEFAULT_SUBNET_DEREGISTRATIONS_WINDOW = "7d";

// Round a deregistrations-per-hotkey ratio to a stable 2dp precision. Always finite and
// non-negative here (deregistrations / distinct hotkeys, with the divisor guarded below).
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

// Average NeuronDeregistered events per distinct deregistered hotkey — the subnet's
// re-deregistration intensity (1.0 means each hotkey was deregistered once; higher means hotkeys
// re-registered and were deregistered again). A subnet with no deregistered hotkeys has no defined
// intensity (null), not a divide-by-zero.
function deregistrationsPerHotkey(
  deregistrations: number,
  hotkeys: number,
): number | null {
  if (hotkeys <= 0) return null;
  return round(deregistrations / hotkeys);
}

// Shape one subnet's deregistration scorecard from the single-row account_events aggregate. `row`
// carries deregistrations (COUNT(*)), distinct_deregistered_hotkeys (COUNT(DISTINCT hotkey)), and
// newest_observed (MAX(observed_at)). Null-safe: a null/absent row yields the zeroed card.
export function buildSubnetDeregistrations(
  row: Row | null | undefined,
  netuid: unknown,
  { window }: { window?: unknown } = {},
): Row {
  const distinctDeregisteredHotkeys = toCount(
    row?.distinct_deregistered_hotkeys,
  );
  const deregistrations = toCount(row?.deregistrations);
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    observed_at: toIso(row?.newest_observed),
    distinct_deregistered_hotkeys: distinctDeregisteredHotkeys,
    deregistrations,
    deregistrations_per_hotkey: deregistrationsPerHotkey(
      deregistrations,
      distinctDeregisteredHotkeys,
    ),
  };
}

// One subnet's neuron-deregistration activity, computed live: read the account_events
// NeuronDeregistered stream for this netuid over the window (observed_at >= now - windowDays,
// epoch ms) as a single aggregate (event count + distinct deregistered hotkeys + newest
// observed_at, served by idx_account_events(netuid, event_kind, block_number) from migration 0024),
// and shape with buildSubnetDeregistrations. A NeuronDeregistered event always carries the evicted
// hotkey, so COUNT(DISTINCT hotkey) is exact here. The handler resolves windowLabel/windowDays from
// the window param. Cold/absent store -> the schema-stable zeroed card.
export async function loadSubnetDeregistrations(
  d1: D1Runner,
  netuid: unknown,
  { windowLabel, windowDays }: { windowLabel?: unknown; windowDays: number },
): Promise<Row> {
  const cutoff = Date.now() - windowDays * DAY_MS;
  const rows = await d1(
    "SELECT COUNT(*) AS deregistrations, COUNT(DISTINCT hotkey) AS distinct_deregistered_hotkeys, " +
      "MAX(observed_at) AS newest_observed " +
      "FROM account_events WHERE netuid = ? AND event_kind = ? AND observed_at >= ?",
    [netuid, DEREGISTRATION_EVENT_KIND, cutoff],
  );
  return buildSubnetDeregistrations(rows?.[0] ?? null, netuid, {
    window: windowLabel,
  });
}
