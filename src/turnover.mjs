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

const DAY_MS = 24 * 60 * 60 * 1000;

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

function normalizedUid(value) {
  if (value == null) return null;
  const uid = Number(value);
  return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
}

// UID → hotkey map for one snapshot (rows with a real hotkey). A UID whose hotkey
// changes between snapshots was deregistered + re-registered to a new owner.
function uidHotkeyMap(rows) {
  const map = new Map();
  for (const row of rows) {
    const uid = normalizedUid(row?.uid);
    const hotkey = row?.hotkey;
    if (uid != null && typeof hotkey === "string" && hotkey.length > 0) {
      map.set(uid, hotkey);
    }
  }
  return map;
}

function validatorHotkeyMap(rows) {
  const map = new Map();
  for (const row of rows) {
    const hotkey = row?.hotkey;
    if (
      Number(row?.validator_permit) === 1 &&
      typeof hotkey === "string" &&
      hotkey.length > 0
    ) {
      map.set(hotkey, { hotkey, uid: normalizedUid(row.uid) });
    }
  }
  return map;
}

function sortValidatorDetails(rows) {
  return rows.sort((a, b) => a.hotkey.localeCompare(b.hotkey));
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

const EMPTY_TURNOVER_CHANGES = {
  comparable: false,
  validators_start: 0,
  validators_end: 0,
  validators_entered_count: 0,
  validators_exited_count: 0,
  neurons_start: 0,
  neurons_end: 0,
  uid_reassignment_count: 0,
  validators_entered: [],
  validators_exited: [],
  uid_reassignments: [],
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

// Detail view for the turnover scorecard: which validator hotkeys entered/exited
// and which UID slots were reassigned to a different hotkey between the boundary
// snapshots.
export function buildTurnoverChanges(
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
    return { ...base, ...EMPTY_TURNOVER_CHANGES };
  }

  const startRows = list.filter((row) => row?.snapshot_date === startDate);
  const endRows = list.filter((row) => row?.snapshot_date === endDate);
  const startValidators = validatorHotkeyMap(startRows);
  const endValidators = validatorHotkeyMap(endRows);

  const entered = sortValidatorDetails(
    [...endValidators]
      .filter(([hotkey]) => !startValidators.has(hotkey))
      .map(([, value]) => value),
  );
  const exited = sortValidatorDetails(
    [...startValidators]
      .filter(([hotkey]) => !endValidators.has(hotkey))
      .map(([, value]) => value),
  );

  const startMap = uidHotkeyMap(startRows);
  const endMap = uidHotkeyMap(endRows);
  const reassignments = [];
  for (const [uid, fromHotkey] of startMap) {
    const toHotkey = endMap.get(uid);
    if (toHotkey != null && toHotkey !== fromHotkey) {
      reassignments.push({ uid, from_hotkey: fromHotkey, to_hotkey: toHotkey });
    }
  }
  reassignments.sort((a, b) => a.uid - b.uid);

  return {
    ...base,
    comparable: startDate !== endDate,
    validators_start: startValidators.size,
    validators_end: endValidators.size,
    validators_entered_count: entered.length,
    validators_exited_count: exited.length,
    neurons_start: startMap.size,
    neurons_end: endMap.size,
    uid_reassignment_count: reassignments.length,
    validators_entered: entered,
    validators_exited: exited,
    uid_reassignments: reassignments,
  };
}

function turnoverChangeDetail(changes) {
  return {
    validators_entered_count: changes.validators_entered_count,
    validators_exited_count: changes.validators_exited_count,
    uid_reassignment_count: changes.uid_reassignment_count,
    validators_entered: changes.validators_entered,
    validators_exited: changes.validators_exited,
    uid_reassignments: changes.uid_reassignments,
  };
}

async function loadTurnoverBoundaryRows(d1, netuid, { windowDays }) {
  let boundsSql =
    "SELECT MIN(snapshot_date) AS start_date, MAX(snapshot_date) AS end_date FROM neuron_daily WHERE netuid = ?";
  const boundsParams = [netuid];
  if (windowDays != null) {
    const cutoff = new Date(Date.now() - windowDays * DAY_MS)
      .toISOString()
      .slice(0, 10);
    boundsSql += " AND snapshot_date >= ?";
    boundsParams.push(cutoff);
  }
  const bounds = await d1(boundsSql, boundsParams);
  const startDate = bounds[0]?.start_date ?? null;
  const endDate = bounds[0]?.end_date ?? null;
  const rows =
    startDate == null || endDate == null
      ? []
      : await d1(
          `SELECT ${TURNOVER_READ_COLUMNS} FROM neuron_daily WHERE netuid = ? AND snapshot_date IN (?, ?) ORDER BY snapshot_date ASC, uid ASC`,
          [netuid, startDate, endDate],
        );
  return { startDate, endDate, rows };
}

// One subnet's validator-set & registration churn — shared by the REST route and
// MCP tool: MIN/MAX the window's boundary snapshot_dates on neuron_daily, read
// exactly those two days' rows, shape with buildTurnover. Cold D1 → comparable:false.
export async function loadSubnetTurnover(
  d1,
  netuid,
  { windowLabel, windowDays, includeChanges = false },
) {
  const { startDate, endDate, rows } = await loadTurnoverBoundaryRows(
    d1,
    netuid,
    {
      windowDays,
    },
  );
  const options = {
    window: windowLabel,
    startDate,
    endDate,
  };
  const data = buildTurnover(rows, netuid, options);
  if (!includeChanges) return data;
  return {
    ...data,
    changes: turnoverChangeDetail(buildTurnoverChanges(rows, netuid, options)),
  };
}
