// Per-account daily position HISTORY (block-explorer Tier-1, epic #4329/6.1).
//
// The refresh-metagraph cron lands the LATEST per-UID snapshot in `neurons`
// (overwrite-on-conflict — no history is kept). This daily rollup copies the
// current snapshot into the append-only `account_position_daily` table, keyed by
// (account, netuid, snapshot_date) instead of neuron_daily's (netuid, uid,
// snapshot_date) — giving /accounts/{addr}/portfolio's positions a per-account
// time-series (the "Alpha Holdings chart") the same way neuron_daily gives
// per-UID metagraph time-series. Same source table as neuron_daily, so both
// rollups fire from the SAME cron tick for a consistent snapshot stamp.
// account = hotkey ss58, matching loadAccountPortfolio's own "WHERE hotkey = ?"
// framing (src/account-portfolio.mjs). Pure + injectable for tests; the Worker
// runs the D1 I/O.
//
// Known overlap with neuron_daily (#4330's own issue text mandates this new
// table regardless — flagging the tradeoff here, not silently accepting or
// re-litigating it): every column this table stores already exists in
// neuron_daily, which already carries a `hotkey` column and a purpose-built
// `idx_neuron_daily_hotkey_date` index ("Point-in-time account history: which
// UID a hotkey held on a date" — migrations/0011_neuron_daily.sql) that could
// serve most of this same read pattern (`WHERE hotkey = ? ORDER BY
// snapshot_date`) with no new table. This rollup doubles daily write volume
// onto the same D1 database that has already hit its capacity limit once
// (neuron_daily's own 400d->90d retention cut, src/neuron-history.mjs) — worth
// weighing before #4331's read route builds on top of this table, and before
// assuming this data couldn't instead be served from neuron_daily directly.
//
// Known scope limitation: "position"/stake_tao here is a HOTKEY's own
// registered-neuron stake (for a validator hotkey, the FULL pool delegated to
// it by every nominator — migrations/0007_neurons.sql's stake_tao comment),
// not a coldkey's aggregate nominator/delegated stake across OTHER people's
// validators. A wallet that only delegates (never registers its own hotkey)
// will show near-zero history here despite genuinely holding alpha — that
// delegated-stake concept only exists as an account_events log today (would
// need balance reconstruction, out of scope for this issue). Matches
// loadAccountPortfolio's existing, equally-unqualified "WHERE hotkey = ?"
// framing (src/account-portfolio.mjs) — not a new gap, but worth restating
// here since epic #4329 explicitly frames this as taostats.io's (coldkey-
// centric) "Alpha Holdings" feature.

// Columns written to account_position_daily by the rollup — the load contract,
// positionally aligned with NEURONS_SELECT_COLUMNS below.
const ROLLUP_COLUMNS = [
  "account",
  "netuid",
  "uid",
  "coldkey",
  "active",
  "validator_permit",
  "rank",
  "trust",
  "incentive",
  "dividends",
  "stake_tao",
  "emission_tao",
  "captured_at",
];

// The `neurons` columns snapshotted into account_position_daily — mirrors
// ACCOUNT_PORTFOLIO_READ_COLUMNS (src/account-portfolio.mjs) plus coldkey for
// ownership display, not the full neuron row (no axon/registered_at_block/
// is_immunity_period — point-in-time metagraph facts, not portfolio economics).
const NEURONS_SELECT_COLUMNS =
  "hotkey AS account, netuid, uid, coldkey, active, validator_permit, rank, " +
  "trust, incentive, dividends, stake_tao, emission_tao, captured_at";

// Retention window for the simple prune below. Mirrors EVENT_RETENTION_MS's
// plain-DELETE approach (src/account-events.mjs), not neuron_daily's cold-archive
// tier — account_position_daily is new and unproven at scale; add archival later
// if row growth demands it, following neuron_daily's own later evolution (PR-A2)
// rather than building it preemptively.
export const ACCOUNT_POSITION_DAILY_RETENTION_DAYS = 90;

function accountPositionDailyRetentionCutoff(now) {
  return new Date(now - ACCOUNT_POSITION_DAILY_RETENTION_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

// Daily rollup: snapshot the current `neurons` table into
// `account_position_daily` for the captured UTC day. Same atomic INSERT...SELECT
// shape as rollupNeuronDaily (src/neuron-history.mjs):
//  - WHERE captured_at = MAX(captured_at): one consistent snapshot stamp, so a
//    concurrent partial load can't bleed two stamps into a single day.
//  - AND hotkey IS NOT NULL: `account` is NOT NULL and part of the primary key,
//    but neurons.hotkey is nullable — an unfiltered SELECT would abort the
//    WHOLE INSERT (every account/subnet for the day, not just the offending
//    row) the moment any one neuron row lacked a hotkey.
//  - snapshot_date = the UTC day of that captured_at, computed in SQL.
//  - ON CONFLICT(account, netuid, snapshot_date) DO UPDATE: intra-day re-runs
//    are idempotent (the row reflects the last capture that UTC day).
// Returns {rolled, rows} for cron observability; the caller .catch-isolates it
// so a failure never affects the rest of the scheduled run.
export async function rollupAccountPositionDaily(
  env,
  { now = Date.now() } = {},
) {
  const db = env?.METAGRAPH_HEALTH_DB;
  if (!db?.prepare) return { rolled: false, reason: "no-db" };
  const cols = ROLLUP_COLUMNS.join(", ");
  const setClause = ROLLUP_COLUMNS.filter(
    (c) => c !== "account" && c !== "netuid",
  )
    .map((c) => `${c} = excluded.${c}`)
    .concat("updated_at = excluded.updated_at")
    .join(", ");
  const sql =
    `INSERT INTO account_position_daily (${cols}, snapshot_date, updated_at) ` +
    `SELECT ${NEURONS_SELECT_COLUMNS}, date(captured_at / 1000, 'unixepoch'), ? ` +
    `FROM neurons WHERE captured_at = (SELECT MAX(captured_at) FROM neurons) ` +
    `AND hotkey IS NOT NULL ` +
    `ON CONFLICT(account, netuid, snapshot_date) DO UPDATE SET ${setClause}`;
  const res = await db.prepare(sql).bind(now).run();
  return { rolled: true, rows: res?.meta?.changes ?? null };
}

// Prune rows older than the retention window — a plain DELETE, no cold-archive
// tier (mirrors pruneAccountEvents, src/account-events.mjs). Returns
// {pruned, changes} for cron observability. The D1 call is try/caught, but the
// retention-cutoff computation just above it is NOT — a non-finite `now` would
// still throw there; every current caller passes now = Date.now(), so that's
// not reachable today, but this function is not unconditionally exception-free.
export async function pruneAccountPositionDaily(
  env,
  { now = Date.now() } = {},
) {
  const db = env?.METAGRAPH_HEALTH_DB;
  if (!db?.prepare) return { pruned: false, reason: "no-db" };
  const cutoff = accountPositionDailyRetentionCutoff(now);
  try {
    const result = await db
      .prepare("DELETE FROM account_position_daily WHERE snapshot_date < ?")
      .bind(cutoff)
      .run();
    return { pruned: true, cutoff, changes: result?.meta?.changes ?? null };
  } catch {
    return { pruned: false };
  }
}

// ---- Read path (block-explorer Tier-1, epic #4329/6.2) --------------------
// GET /api/v1/accounts/{ss58}/subnets/{netuid}/history — the per-position
// counterpart to /accounts/{ss58}/portfolio's live cross-subnet snapshot, one
// point per snapshot_date for a single (account, netuid) pair. Field shape
// mirrors buildAccountPortfolio's per-position object (src/account-portfolio.mjs)
// since account_position_daily's columns were deliberately sized to match
// ACCOUNT_PORTFOLIO_READ_COLUMNS (see the migration's header comment) — a point
// here and a `positions[]` entry there should read as the same "position",
// just at different times. netuid is NOT repeated per-point (it's the fixed
// scope of the whole query, like SubnetHistoryArtifact's points omitting the
// netuid every row shares) — only `uid` and `coldkey` can legitimately vary
// day-to-day for one (account, netuid) pair (a hotkey re-registering at a new
// UID slot, or a coldkey key-rotation), so those travel with each point.

// SELECT list for one (account, netuid) day of account_position_daily.
export const ACCOUNT_POSITION_DAILY_READ_COLUMNS =
  "snapshot_date, captured_at, uid, coldkey, active, validator_permit, " +
  "rank, trust, incentive, dividends, stake_tao, emission_tao";

// 1 TAO = 1e9 rao; round tao + yield outputs to that precision (matches
// account-portfolio.mjs's round9 — each module owns its own copy, this
// codebase's established convention for these small numeric coercions).
const SCALE = 1e9;
function round9(value) {
  return Math.round(value * SCALE) / SCALE;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function nullableScore(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? round9(n) : null;
}

function toInt(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

function toIso(ms) {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Emission-per-stake return rate; null when stake is 0 (undefined return).
// Mirrors computeYieldValue in account-portfolio.mjs.
function computeYieldValue(emission, stake) {
  if (!(stake > 0)) return null;
  return round9(emission / stake);
}

// One day's position, in the same field shape as buildAccountPortfolio's
// `positions[]` entries (minus netuid — see the read-path header comment).
// Exported (unlike account-portfolio.mjs's inline per-row mapping) so its
// field coercion can be unit-tested directly, matching formatRuntimeTransition
// (src/runtime-versions.mjs)'s precedent for a history route's row formatter.
export function formatAccountPosition(row) {
  if (!row || typeof row !== "object") return null;
  const stake = toNumber(row.stake_tao);
  const emission = toNumber(row.emission_tao);
  const isValidator = Number(row.validator_permit) === 1;
  return {
    uid: toInt(row.uid),
    coldkey: row.coldkey ?? null,
    role: isValidator ? "validator" : "miner",
    active: Number(row.active) === 1,
    stake_tao: round9(stake),
    emission_tao: round9(emission),
    rank: nullableScore(row.rank),
    trust: nullableScore(row.trust),
    incentive: nullableScore(row.incentive),
    dividends: nullableScore(row.dividends),
    yield: computeYieldValue(emission, stake),
  };
}

// Per-account, per-subnet time series: one point per snapshot_date (the
// handler queries newest first, bounded by MAX_HISTORY_POINTS from
// neuron-history.mjs — the shared history-window vocabulary every other
// history route already reuses). Mirrors buildNeuronHistory's shape
// (src/neuron-history.mjs), the response-builder template this issue names.
export function buildAccountPositionHistory(
  rows,
  ss58,
  netuid,
  { window } = {},
) {
  const points = (rows || [])
    .map((r) => {
      const position = formatAccountPosition(r);
      if (!position) return null;
      return {
        snapshot_date: r.snapshot_date,
        captured_at: toIso(r.captured_at),
        ...position,
      };
    })
    .filter(Boolean);
  return {
    schema_version: 1,
    ss58,
    netuid,
    window: window ?? null,
    point_count: points.length,
    points,
  };
}
