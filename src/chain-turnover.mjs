// Network-wide validator-set & registration turnover (churn): how much the WHOLE
// network's validator set and neuron population rotate between two dated snapshots
// of the neuron_daily rollup (start vs end of a window), aggregated across EVERY
// subnet at once. The network analog of src/turnover.mjs (per-subnet churn) and the
// churn companion to chain-performance.mjs — it reuses the exact same jaccard
// retention math + anti-overstatement guard + stability_score composite, but keys
// every identity by netuid so UID 5 on subnet 1 is a different neuron from UID 5 on
// subnet 7, and a hotkey validating on two subnets counts once per subnet. Pure +
// exported for unit tests; the Worker does the D1 reads + envelope. Null-safe: a
// cold store / single snapshot yields a schema-stable zero (never throws).

// The neuron_daily columns the network turnover handler reads — like
// TURNOVER_READ_COLUMNS but WITH `netuid` so identities can be netuid-scoped and the
// artifact can report how many subnets the boundary rows span (mirrors how
// CHAIN_PERFORMANCE_READ_COLUMNS adds netuid to the per-subnet read).
export const CHAIN_TURNOVER_READ_COLUMNS =
  "snapshot_date, netuid, uid, hotkey, validator_permit";

const DAY_MS = 24 * 60 * 60 * 1000;

// Round a retention ratio (always a finite 0..1 jaccard result) to a stable
// precision WITHOUT letting a sub-perfect ratio round up to an exact 1 — the same
// anti-overstatement invariant buildTurnover enforces: a set that actually churned
// must never report a flawless `retention: 1`. Only a genuine ratio of exactly 1
// (nothing rotated) keeps the perfect value; any sub-1 ratio clamps to the largest
// dp-decimal value below 1.
function round(value, dp = 4) {
  const factor = 10 ** dp;
  const rounded = Math.round(value * factor) / factor;
  return rounded >= 1 && value < 1 ? (factor - 1) / factor : rounded;
}

// Jaccard similarity |A∩B| / |A∪B| — the retained fraction across two sets. Two
// empty sets are defined as 1 (nothing to lose ⇒ perfectly retained); past that
// guard at least one set is non-empty, so the union is always > 0.
function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

function normalizedUid(value) {
  if (value == null) return null;
  // A blank / whitespace-only cell must not collapse to slot 0 the way Number("")
  // and Number("   ") do — guard it before coercion, mirroring normalizedNetuid.
  if (typeof value === "string" && value.trim() === "") return null;
  const uid = Number(value);
  return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
}

// A netuid coerced to a non-negative integer, or null for a blank / non-integer /
// negative cell — the same guard chain-performance applies before counting subnets.
function normalizedNetuid(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const netuid = Number(value);
  return Number.isInteger(netuid) && netuid >= 0 ? netuid : null;
}

// The set of network-wide validator identities in one snapshot. A validator is
// keyed by `${netuid}:${hotkey}` (the key that votes, scoped to the subnet it
// votes on) so the same hotkey validating on two subnets counts once per subnet.
function validatorIds(rows) {
  const set = new Set();
  for (const row of rows) {
    const netuid = normalizedNetuid(row?.netuid);
    const hotkey = row?.hotkey;
    if (
      netuid != null &&
      Number(row?.validator_permit) === 1 &&
      typeof hotkey === "string" &&
      hotkey.length > 0
    ) {
      set.add(`${netuid}:${hotkey}`);
    }
  }
  return set;
}

// UID-slot → hotkey map for one snapshot, keyed by `${netuid}:${uid}`. A slot whose
// hotkey changes between snapshots was deregistered + re-registered to a new owner.
// Keeps the netuid-scoped uid+hotkey identity alongside so the neuron-retention set
// can be derived from the same pass.
function neuronSlotMap(rows) {
  const map = new Map();
  for (const row of rows) {
    const netuid = normalizedNetuid(row?.netuid);
    const uid = normalizedUid(row?.uid);
    const hotkey = row?.hotkey;
    if (
      netuid != null &&
      uid != null &&
      typeof hotkey === "string" &&
      hotkey.length > 0
    ) {
      map.set(`${netuid}:${uid}`, hotkey);
    }
  }
  return map;
}

const EMPTY_CHAIN_TURNOVER = {
  comparable: false,
  subnet_count: 0,
  validators_start: 0,
  validators_end: 0,
  validators_entered: 0,
  validators_exited: 0,
  validator_retention: null,
  neurons_start: 0,
  neurons_end: 0,
  uids_deregistered: 0,
  neuron_retention: null,
  stability_score: null,
};

// Count of DISTINCT netuids present across the boundary rows, guarding blank /
// non-integer / negative cells the same way chain-performance does.
function countSubnets(rows) {
  const netuids = new Set();
  for (const row of rows) {
    const netuid = normalizedNetuid(row?.netuid);
    if (netuid != null) netuids.add(netuid);
  }
  return netuids.size;
}

// Compare the network's start-of-window vs end-of-window neuron_daily snapshots into
// a network turnover scorecard aggregated across ALL subnets. `rows` carries both
// dates' rows (the handler reads exactly the two boundary snapshot_dates);
// `startDate`/`endDate` name them. Null-safe: no data, or no resolvable boundary
// dates, or a boundary date with zero rows, yields the schema-stable empty block.
export function buildChainTurnover(rows, { window, startDate, endDate } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const base = {
    schema_version: 1,
    window: window ?? null,
    start_date: startDate ?? null,
    end_date: endDate ?? null,
  };
  if (startDate == null || endDate == null || list.length === 0) {
    return { ...base, ...EMPTY_CHAIN_TURNOVER };
  }

  const startRows = list.filter((row) => row?.snapshot_date === startDate);
  const endRows = list.filter((row) => row?.snapshot_date === endDate);
  // A boundary date that resolves to no rows isn't comparable: jaccard(∅, ∅) = 1
  // would otherwise report a flawless retention/stability_score for a window with
  // no boundary data. Honor the "no resolvable boundary dates → empty block"
  // contract, matching buildTurnover.
  if (startRows.length === 0 || endRows.length === 0) {
    return { ...base, ...EMPTY_CHAIN_TURNOVER };
  }

  // Validator-set churn, keyed by `${netuid}:${hotkey}` (the validating entity,
  // scoped to the subnet it votes on).
  const startValidators = validatorIds(startRows);
  const endValidators = validatorIds(endRows);
  let entered = 0;
  for (const id of endValidators) {
    if (!startValidators.has(id)) entered += 1;
  }
  let exited = 0;
  for (const id of startValidators) {
    if (!endValidators.has(id)) exited += 1;
  }
  const validatorRetention = jaccard(startValidators, endValidators);

  // Registration churn: a UID slot present at both boundaries with a different
  // hotkey = a dereg. Slots are keyed by `${netuid}:${uid}` so a slot on one subnet
  // never collides with the same uid on another.
  const startMap = neuronSlotMap(startRows);
  const endMap = neuronSlotMap(endRows);
  let deregistered = 0;
  for (const [slot, hotkey] of endMap) {
    if (startMap.has(slot) && startMap.get(slot) !== hotkey) deregistered += 1;
  }
  // Neuron identity = `${netuid}:${uid}:${hotkey}`; retained when the same slot kept
  // the same hotkey.
  const startIds = new Set([...startMap].map(([slot, hk]) => `${slot}:${hk}`));
  const endIds = new Set([...endMap].map(([slot, hk]) => `${slot}:${hk}`));
  const neuronRetention = jaccard(startIds, endIds);

  // 0–100 composite: the mean of validator-set and neuron retention. Apply the same
  // anti-overstatement guard as the retention ratios — a sub-perfect mean must not
  // round up to a perfect 100. Only a genuine mean of exactly 1 (nothing rotated)
  // keeps the perfect 100.
  const meanRetention = (validatorRetention + neuronRetention) / 2;
  let stabilityScore = Math.round(meanRetention * 100);
  if (stabilityScore >= 100 && meanRetention < 1) stabilityScore = 99;

  return {
    ...base,
    // A single snapshot (start === end) can't show change — flag it so a caller
    // doesn't read trivially-perfect retention as real stability.
    comparable: startDate !== endDate,
    // Distinct netuids present across the boundary rows.
    subnet_count: countSubnets([...startRows, ...endRows]),
    validators_start: startValidators.size,
    validators_end: endValidators.size,
    validators_entered: entered,
    validators_exited: exited,
    validator_retention: round(validatorRetention),
    neurons_start: startMap.size,
    neurons_end: endMap.size,
    uids_deregistered: deregistered,
    neuron_retention: round(neuronRetention),
    stability_score: stabilityScore,
  };
}

async function loadChainTurnoverBoundaryRows(d1, { windowDays }) {
  let boundsSql =
    "SELECT MIN(snapshot_date) AS start_date, MAX(snapshot_date) AS end_date FROM neuron_daily";
  const boundsParams = [];
  if (windowDays != null) {
    const cutoff = new Date(Date.now() - windowDays * DAY_MS)
      .toISOString()
      .slice(0, 10);
    boundsSql += " WHERE snapshot_date >= ?";
    boundsParams.push(cutoff);
  }
  const bounds = await d1(boundsSql, boundsParams);
  const startDate = bounds[0]?.start_date ?? null;
  const endDate = bounds[0]?.end_date ?? null;
  const rows =
    startDate == null || endDate == null
      ? []
      : await d1(
          `SELECT ${CHAIN_TURNOVER_READ_COLUMNS} FROM neuron_daily WHERE snapshot_date IN (?, ?) ORDER BY snapshot_date ASC, netuid ASC, uid ASC`,
          [startDate, endDate],
        );
  return { startDate, endDate, rows };
}

// Network-wide validator-set & registration churn — shared by the REST route and
// MCP tool: MIN/MAX the window's boundary snapshot_dates on neuron_daily with NO
// netuid filter, read exactly those two days' rows across every subnet, shape with
// buildChainTurnover. Cold D1 → comparable:false. Exported for the MCP tool.
export async function loadChainTurnover(d1, { windowLabel, windowDays }) {
  const { startDate, endDate, rows } = await loadChainTurnoverBoundaryRows(d1, {
    windowDays,
  });
  return buildChainTurnover(rows, {
    window: windowLabel,
    startDate,
    endDate,
  });
}
