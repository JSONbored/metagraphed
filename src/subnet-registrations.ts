// Per-subnet neuron-registration activity from the account_events NeuronRegistered stream: for
// ONE subnet over a 7d/30d window, the distinct registrants (hotkeys), NeuronRegistered event
// count, and average registrations per registrant. This is raw registration DEMAND/activity —
// the account_events companion to the neuron_daily validator-set churn in /turnover (which
// measures net snapshot change + deregistrations, NOT raw registration event volume), exactly
// the way /stake-flow (account_events) coexists with /turnover (neuron_daily). Pure shaping
// (buildSubnetRegistrations) + a thin D1 loader (loadSubnetRegistrations); the Worker adds the
// envelope. Null-safe: a cold store or a subnet with no NeuronRegistered events yields the zeroed card.

type Row = Record<string, unknown>;
type D1Runner = (sql: string, params: unknown[]) => Promise<Row[]>;

const DAY_MS = 24 * 60 * 60 * 1000;

// The account_events kind emitted when a neuron registers (or re-registers) on a subnet.
export const REGISTRATION_EVENT_KIND = "NeuronRegistered";

// Supported windows (label -> days) + default, matching the sibling account_events routes.
export const SUBNET_REGISTRATIONS_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
};
export const DEFAULT_SUBNET_REGISTRATIONS_WINDOW = "7d";

// Round a registrations-per-registrant ratio to a stable 2dp precision. Always finite and
// non-negative here (events / distinct registrants, with the divisor guarded below).
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

// Average NeuronRegistered events per distinct registrant — the subnet's re-registration
// intensity (1.0 means each hotkey registered once; higher means hotkeys re-registered after
// deregistering). A subnet with no registrants has no defined intensity (null), not a divide-by-zero.
function registrationsPerRegistrant(
  registrations: number,
  registrants: number,
): number | null {
  if (registrants <= 0) return null;
  return round(registrations / registrants);
}

// Shape one subnet's registration scorecard from the single-row account_events aggregate. `row`
// carries registrations (COUNT(*)), distinct_registrants (COUNT(DISTINCT hotkey)), and
// newest_observed (MAX(observed_at)). Null-safe: a null/absent row yields the zeroed card.
export function buildSubnetRegistrations(
  row: Row | null | undefined,
  netuid: unknown,
  { window }: { window?: unknown } = {},
): Row {
  const distinctRegistrants = toCount(row?.distinct_registrants);
  const registrations = toCount(row?.registrations);
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    observed_at: toIso(row?.newest_observed),
    distinct_registrants: distinctRegistrants,
    registrations,
    registrations_per_registrant: registrationsPerRegistrant(
      registrations,
      distinctRegistrants,
    ),
  };
}

// One subnet's neuron-registration activity, computed live: read the account_events
// NeuronRegistered stream for this netuid over the window (observed_at >= now - windowDays,
// epoch ms) as a single aggregate (event count + distinct registrant hotkeys + newest
// observed_at, served by idx_account_events(netuid, event_kind, block_number) from migration
// 0024), and shape with buildSubnetRegistrations. A NeuronRegistered event always carries the
// registering hotkey, so COUNT(DISTINCT hotkey) is exact here (unlike WeightsSet). The handler
// resolves windowLabel/windowDays from the window param. Cold/absent store -> the zeroed card.
export async function loadSubnetRegistrations(
  d1: D1Runner,
  netuid: unknown,
  { windowLabel, windowDays }: { windowLabel?: unknown; windowDays: number },
): Promise<Row> {
  const cutoff = Date.now() - windowDays * DAY_MS;
  const rows = await d1(
    "SELECT COUNT(*) AS registrations, COUNT(DISTINCT hotkey) AS distinct_registrants, " +
      "MAX(observed_at) AS newest_observed " +
      "FROM account_events WHERE netuid = ? AND event_kind = ? AND observed_at >= ?",
    [netuid, REGISTRATION_EVENT_KIND, cutoff],
  );
  return buildSubnetRegistrations(rows?.[0] ?? null, netuid, {
    window: windowLabel,
  });
}
