// Network-wide validator-set turnover (churn) across ALL subnets between two dated
// neuron_daily snapshots: each subnet's validator set entered/exited/retention/stability
// ranked into a leaderboard, plus a network rollup over the union of every subnet's
// validator hotkeys. The network companion to /api/v1/subnets/{netuid}/turnover, mirroring
// how /chain/concentration companions the per-subnet concentration route. Pure + exported
// for unit tests; the Worker does the D1 reads + envelope. Scoped to validator_permit rows
// so the two-snapshot read stays bounded (validators, not every neuron across the network).

// The neuron_daily columns the handler reads — its D1 read contract. `hotkey` is public
// metagraph vocabulary, not a secret; kept next to its consumer so the handler stays a thin SELECT.
export const CHAIN_TURNOVER_READ_COLUMNS =
  "snapshot_date, netuid, hotkey, validator_permit";

// Supported comparison windows (label -> days): the 7d/30d/90d set the turnover/concentration
// scorecards use.
export const CHAIN_TURNOVER_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
export const DEFAULT_CHAIN_TURNOVER_WINDOW = "30d";

export const CHAIN_TURNOVER_LIMIT_DEFAULT = 20;
export const CHAIN_TURNOVER_LIMIT_MAX = 100;

// Round a retention ratio (a finite 0..1 jaccard result) to a stable precision WITHOUT
// letting a sub-perfect ratio round up to an exact 1 — the same anti-overstatement invariant
// src/turnover.ts enforces: a set that actually churned must never report a flawless 1.
function round(value: number, dp = 4): number {
  const factor = 10 ** dp;
  const rounded = Math.round(value * factor) / factor;
  return rounded >= 1 && value < 1 ? (factor - 1) / factor : rounded;
}

// Jaccard similarity |A∩B| / |A∪B| — the retained fraction across two sets. Two empty sets
// are defined as 1 (nothing to lose ⇒ perfectly retained), reached for the network set when a
// caller passes rows carrying no validators at all; past that guard at least one set is
// non-empty, so the union is always > 0.
function jaccard(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

// A 0–100 composite from a retention ratio, with the same anti-overstatement clamp as
// `round`: a sub-perfect retention must not round up to a flawless 100.
function stabilityScore(retention: number): number {
  let score = Math.round(retention * 100);
  if (score >= 100 && retention < 1) score = 99;
  return score;
}

// Nearest-rank percentile of a NON-EMPTY ascending numeric array (deterministic, no
// interpolation) — mirrors src/subnet-yield.ts. Only called from stabilityDistribution,
// which short-circuits an empty score set to null before reaching here.
function percentile(ascending: number[], p: number): number {
  const rank = Math.ceil((p / 100) * ascending.length);
  return ascending[Math.min(rank, ascending.length) - 1];
}

// Conventional median of a NON-EMPTY ascending numeric array: the middle value for an odd count,
// the mean of the two middle values for an even count (so [33, 100] -> 66.5, not the lower-middle 33
// a nearest-rank p50 gives). The averaging form needs no odd/even branch — for an odd count the two
// indices coincide and it returns that middle value unchanged. Matches median() in chain-yield.ts /
// subnet-yield.ts so a `median` field is the same statistic across the API. Reached only after
// stabilityDistribution's empty short-circuit.
function median(ascending: number[]): number {
  const mid = (ascending.length - 1) / 2;
  return round((ascending[Math.floor(mid)] + ascending[Math.ceil(mid)]) / 2);
}

export interface StabilityDistribution {
  count: number;
  mean: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  max: number;
}

// Spread of the per-subnet stability scores across every subnet in the window: count, mean,
// and min / p25 / median / p75 / p90 / max. Null when no subnet is comparable. Lets a caller
// read network stability as a distribution (how many subnets are churning hard) rather than a
// single rollup number.
function stabilityDistribution(scores: number[]): StabilityDistribution | null {
  if (scores.length === 0) return null;
  const ascending = [...scores].sort((a, b) => a - b);
  const sum = ascending.reduce((total, value) => total + value, 0);
  return {
    count: ascending.length,
    mean: Math.round((sum / ascending.length) * 100) / 100,
    min: ascending[0],
    p25: percentile(ascending, 25),
    median: median(ascending),
    p75: percentile(ascending, 75),
    p90: percentile(ascending, 90),
    max: ascending[ascending.length - 1],
  };
}

// A non-negative integer netuid, or null for a malformed/absent cell. Guard null AND a
// blank/whitespace-only string explicitly so neither is silently coerced to subnet 0
// (Number(null), Number(""), and Number("  ") all === 0); a malformed row must be skipped,
// never counted as netuid 0.
function normalizedNetuid(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const netuid = Number(value);
  return Number.isSafeInteger(netuid) && netuid >= 0 ? netuid : null;
}

interface ValidatorIndex {
  perNetuid: Map<number, Set<string>>;
  network: Set<string>;
}

// Index one snapshot's validator-permit rows into { perNetuid: Map netuid -> Set<hotkey>,
// network: Set<hotkey> }. A validator is identified by its hotkey (the key that votes); the
// network set is the union of every subnet's validator hotkeys (one hotkey can validate on
// several subnets and counts once network-wide).
function indexValidators(rows: Array<Record<string, unknown>>): ValidatorIndex {
  const perNetuid = new Map<number, Set<string>>();
  const network = new Set<string>();
  for (const row of rows) {
    if (Number(row?.validator_permit) !== 1) continue;
    const netuid = normalizedNetuid(row?.netuid);
    const hotkey = row?.hotkey;
    if (netuid == null || typeof hotkey !== "string" || hotkey.length === 0)
      continue;
    let set = perNetuid.get(netuid);
    if (!set) {
      set = new Set();
      perNetuid.set(netuid, set);
    }
    set.add(hotkey);
    network.add(hotkey);
  }
  return { perNetuid, network };
}

export interface ChainTurnoverNetwork {
  validators_start: number;
  validators_end: number;
  validators_entered: number;
  validators_exited: number;
  validator_retention: number | null;
  stability_score: number | null;
}

const EMPTY_NETWORK: ChainTurnoverNetwork = {
  validators_start: 0,
  validators_end: 0,
  validators_entered: 0,
  validators_exited: 0,
  validator_retention: null,
  stability_score: null,
};

interface SetChurn {
  entered: number;
  exited: number;
  retention: number;
  stability: number;
}

// Churn between two validator sets: entered (in end, not start), exited (in start, not end),
// jaccard retention, and a 0–100 stability score.
function setChurn(startSet: Set<string>, endSet: Set<string>): SetChurn {
  let entered = 0;
  for (const hotkey of endSet) if (!startSet.has(hotkey)) entered += 1;
  let exited = 0;
  for (const hotkey of startSet) if (!endSet.has(hotkey)) exited += 1;
  const retention = jaccard(startSet, endSet);
  return {
    entered,
    exited,
    retention,
    stability: stabilityScore(retention),
  };
}

export interface ChainTurnoverSubnet {
  netuid: number;
  validators_start: number;
  validators_end: number;
  validators_entered: number;
  validators_exited: number;
  validator_retention: number;
  stability_score: number;
}

export interface ChainTurnoverResult {
  schema_version: 1;
  window: string | null;
  start_date: string | null;
  end_date: string | null;
  comparable: boolean;
  subnet_count: number;
  network: ChainTurnoverNetwork;
  stability_distribution: StabilityDistribution | null;
  subnets: ChainTurnoverSubnet[];
}

const EMPTY_SET = new Set<string>();

// Shape the network-wide validator turnover scorecard from both boundary snapshots' rows.
// Null-safe: no data or an unresolvable boundary yields the schema-stable empty block
// (comparable:false, empty leaderboard), never throws. `limit` caps the per-subnet leaderboard;
// the network rollup, subnet_count, and distribution cover every subnet that had a validator set
// at either boundary (the loader reads only validator_permit=1 rows, so subnets with no
// validators in the window are absent) — subnet_count/distribution count all of those, not just
// the returned page.
export function buildChainTurnover(
  rows: Array<Record<string, unknown>> | null | undefined,
  {
    window,
    startDate,
    endDate,
    limit = CHAIN_TURNOVER_LIMIT_DEFAULT,
  }: {
    window?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    limit?: number;
  } = {},
): ChainTurnoverResult {
  const list = Array.isArray(rows) ? rows : [];
  const base = {
    schema_version: 1 as const,
    window: window ?? null,
    start_date: startDate ?? null,
    end_date: endDate ?? null,
  };
  // Clamp limit to a whole number in [0, MAX] so a direct caller cannot make slice() behave
  // oddly (the HTTP layer already validates 1..MAX; this keeps the pure builder aligned).
  const flooredLimit = Math.floor(Number(limit));
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(0, Math.min(flooredLimit, CHAIN_TURNOVER_LIMIT_MAX))
    : CHAIN_TURNOVER_LIMIT_DEFAULT;

  const empty: ChainTurnoverResult = {
    ...base,
    comparable: false,
    subnet_count: 0,
    network: { ...EMPTY_NETWORK },
    stability_distribution: null,
    subnets: [],
  };
  // A single snapshot (start === end) can't show change: comparing it to itself would report a
  // flawless retention for populated subnets while comparable is false. Return the empty block so
  // the pure builder shares the loader's cold/single-snapshot contract (comparable:false + empty
  // leaderboard), matching the schema.
  if (
    startDate == null ||
    endDate == null ||
    startDate === endDate ||
    list.length === 0
  )
    return empty;
  const startRows = list.filter((row) => row?.snapshot_date === startDate);
  const endRows = list.filter((row) => row?.snapshot_date === endDate);
  // A boundary date that resolves to no rows isn't comparable: jaccard(∅, ∅) = 1 would
  // otherwise report flawless retention for a window with no boundary data.
  if (startRows.length === 0 || endRows.length === 0) return empty;

  const start = indexValidators(startRows);
  const end = indexValidators(endRows);
  const netuids = new Set([...start.perNetuid.keys(), ...end.perNetuid.keys()]);

  const subnets: ChainTurnoverSubnet[] = [];
  for (const netuid of netuids) {
    const sv = start.perNetuid.get(netuid) ?? EMPTY_SET;
    const ev = end.perNetuid.get(netuid) ?? EMPTY_SET;
    const churn = setChurn(sv, ev);
    subnets.push({
      netuid,
      validators_start: sv.size,
      validators_end: ev.size,
      validators_entered: churn.entered,
      validators_exited: churn.exited,
      validator_retention: round(churn.retention),
      stability_score: churn.stability,
    });
  }
  // Most volatile subnets first (by gross validator churn = entered + exited), tie-broken by
  // netuid for a stable order.
  subnets.sort(
    (a, b) =>
      b.validators_entered +
        b.validators_exited -
        (a.validators_entered + a.validators_exited) || a.netuid - b.netuid,
  );

  const netChurn = setChurn(start.network, end.network);
  const network: ChainTurnoverNetwork = {
    validators_start: start.network.size,
    validators_end: end.network.size,
    validators_entered: netChurn.entered,
    validators_exited: netChurn.exited,
    validator_retention: round(netChurn.retention),
    stability_score: netChurn.stability,
  };

  return {
    ...base,
    // Reaching here means start !== end (single-snapshot windows returned empty above), so the
    // two boundaries are genuinely comparable.
    comparable: true,
    subnet_count: subnets.length,
    network,
    // Distribution of per-subnet stability over EVERY subnet (not just the returned page),
    // so the spread is network-wide even when `limit` truncates the leaderboard.
    stability_distribution: stabilityDistribution(
      subnets.map((subnet) => subnet.stability_score),
    ),
    subnets: subnets.slice(0, normalizedLimit),
  };
}

// Network-wide validator turnover, computed live: anchor the window to the newest STORED
// snapshot (date() relative to MAX(snapshot_date)) so a lagging/restored store still compares
// real boundary snapshots, read every subnet's validator rows at those two days (bounded by
// validator_permit = 1; the date-first idx_neuron_daily_date_netuid_agg covers the boundary
// scan), shape with buildChainTurnover. Cold/absent or single-snapshot D1 → comparable:false.
export async function loadChainTurnover(
  d1: (
    sql: string,
    params: unknown[],
  ) => Promise<Array<Record<string, unknown>>>,
  {
    windowLabel = DEFAULT_CHAIN_TURNOVER_WINDOW,
    limit,
  }: { windowLabel?: string; limit?: number } = {},
): Promise<ChainTurnoverResult> {
  // Normalize the label ONCE and use it for both the day lookup and the emitted artifact window,
  // so a direct caller passing an unsupported label can never emit a schema-invalid window value
  // (the HTTP handler already rejects bad windows before this runs).
  const normalizedLabel = Object.hasOwn(CHAIN_TURNOVER_WINDOWS, windowLabel)
    ? windowLabel
    : DEFAULT_CHAIN_TURNOVER_WINDOW;
  const days = CHAIN_TURNOVER_WINDOWS[normalizedLabel];
  const bounds = await d1(
    "SELECT MIN(snapshot_date) AS start_date, MAX(snapshot_date) AS end_date " +
      "FROM neuron_daily " +
      "WHERE snapshot_date >= (SELECT date(MAX(snapshot_date), ?) FROM neuron_daily)",
    [`-${days} days`],
  );
  const startDate = (bounds?.[0]?.start_date as string | null) ?? null;
  const endDate = (bounds?.[0]?.end_date as string | null) ?? null;
  let rows: Array<Record<string, unknown>> = [];
  if (startDate != null && endDate != null && startDate !== endDate) {
    rows = await d1(
      `SELECT ${CHAIN_TURNOVER_READ_COLUMNS} FROM neuron_daily WHERE validator_permit = 1 AND snapshot_date IN (?, ?)`,
      [startDate, endDate],
    );
  }
  return buildChainTurnover(rows, {
    window: normalizedLabel,
    startDate,
    endDate,
    limit,
  });
}
