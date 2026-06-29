// Validator-set & registration turnover (churn) for one subnet: how much its
// validator set and neuron population rotate between two dated snapshots of the
// neuron_daily rollup (start vs end of a window). Pure + exported for unit tests;
// the Worker does the D1 reads + envelope. Null-safe: a cold store / single
// snapshot yields a schema-stable zero (never throws), matching the live tiers.

// The neuron_daily columns the turnover handler reads — its D1 read contract
// (mirrors BLOCK_READ_COLUMNS / CONCENTRATION_READ_COLUMNS). A bare `hotkey`
// column name is public metagraph vocabulary, not a secret; kept in src/ next to
// its consumer so the Worker handler stays a thin SELECT.
export const TURNOVER_READ_COLUMNS =
  "snapshot_date, uid, hotkey, validator_permit";

// Round a retention ratio (always a finite 0..1 jaccard result) to a stable
// precision WITHOUT letting a sub-perfect ratio round up to an exact 1 — the same
// invariant `displayUptimeRatio` enforces for uptime (#1799) and `formatUptimePercent`
// for the badge (#1796): a set that actually churned must never report a flawless
// `retention: 1`. Only a genuine ratio of exactly 1 (nothing rotated) keeps the
// perfect value; any sub-1 ratio clamps to the largest dp-decimal value below 1.
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

// The set of hotkeys holding a validator permit in one snapshot (a validator is
// identified by its hotkey — the key that votes — not its UID slot).
function validatorHotkeys(rows) {
  const set = new Set();
  for (const row of rows) {
    const hotkey = row?.hotkey;
    if (
      Number(row?.validator_permit) === 1 &&
      typeof hotkey === "string" &&
      hotkey.length > 0
    ) {
      set.add(hotkey);
    }
  }
  return set;
}

// UID → hotkey map for one snapshot (rows with a real hotkey). A UID whose hotkey
// changes between snapshots was deregistered + re-registered to a new owner.
function uidHotkeyMap(rows) {
  const map = new Map();
  for (const row of rows) {
    const hotkey = row?.hotkey;
    if (row?.uid != null && typeof hotkey === "string" && hotkey.length > 0) {
      map.set(row.uid, hotkey);
    }
  }
  return map;
}

const EMPTY_TURNOVER = {
  comparable: false,
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

// Compare a subnet's start-of-window vs end-of-window neuron_daily snapshots into a
// turnover scorecard. `rows` carries both dates' rows (the handler reads exactly
// the two boundary snapshot_dates); `startDate`/`endDate` name them. Null-safe: no
// data, or no resolvable boundary dates, yields the schema-stable empty block.
export function buildTurnover(
  rows,
  netuid,
  { window, startDate, endDate } = {},
) {
  const list = Array.isArray(rows) ? rows : [];
  const base = {
    schema_version: 1,
    netuid,
    window: window ?? null,
    start_date: startDate ?? null,
    end_date: endDate ?? null,
  };
  if (startDate == null || endDate == null || list.length === 0) {
    return { ...base, ...EMPTY_TURNOVER };
  }

  const startRows = list.filter((row) => row?.snapshot_date === startDate);
  const endRows = list.filter((row) => row?.snapshot_date === endDate);

  // Validator-set churn, keyed by hotkey (the validating entity).
  const startValidators = validatorHotkeys(startRows);
  const endValidators = validatorHotkeys(endRows);
  let entered = 0;
  for (const hotkey of endValidators) {
    if (!startValidators.has(hotkey)) entered += 1;
  }
  let exited = 0;
  for (const hotkey of startValidators) {
    if (!endValidators.has(hotkey)) exited += 1;
  }
  const validatorRetention = jaccard(startValidators, endValidators);

  // Registration churn: a UID present at both with a different hotkey = a dereg.
  const startMap = uidHotkeyMap(startRows);
  const endMap = uidHotkeyMap(endRows);
  let deregistered = 0;
  for (const [uid, hotkey] of endMap) {
    if (startMap.has(uid) && startMap.get(uid) !== hotkey) deregistered += 1;
  }
  // Neuron identity = uid+hotkey; retained when the same UID kept the same hotkey.
  const startIds = new Set([...startMap].map(([uid, hk]) => `${uid}:${hk}`));
  const endIds = new Set([...endMap].map(([uid, hk]) => `${uid}:${hk}`));
  const neuronRetention = jaccard(startIds, endIds);

  // 0–100 composite: the mean of validator-set and neuron retention. Apply the
  // same anti-overstatement guard as the retention ratios — a sub-perfect mean must
  // not round up to a perfect 100. A fully-retained validator set plus ~1% neuron
  // churn yields a mean of ~0.995, and `Math.round(99.5) === 100` would report
  // flawless stability for a subnet that demonstrably rotated; clamp it to 99. Only
  // a genuine mean of exactly 1 (nothing rotated) keeps the perfect 100.
  const meanRetention = (validatorRetention + neuronRetention) / 2;
  let stabilityScore = Math.round(meanRetention * 100);
  if (stabilityScore >= 100 && meanRetention < 1) stabilityScore = 99;

  return {
    ...base,
    // A single snapshot (start === end) can't show change — flag it so a caller
    // doesn't read trivially-perfect retention as real stability.
    comparable: startDate !== endDate,
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
